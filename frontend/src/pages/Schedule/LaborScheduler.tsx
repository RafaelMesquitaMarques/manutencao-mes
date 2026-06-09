import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useDroppable, useDraggable } from '@dnd-kit/core';
import { GripVertical, User, AlertCircle, Clock, Ticket, X, CalendarDays, ChevronRight } from 'lucide-react';
import { fetchWorkOrders, fetchTechniciansFull, updateWorkOrder } from '../../api/workOrders';
import { useWorkOrderStore } from '../../store/workOrderStore';
import type { WorkOrder, TechnicianFull } from '../../types';

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'border-l-red-500',
  high: 'border-l-orange-500',
  medium: 'border-l-amber-500',
  low: 'border-l-green-500',
};

const PRIORITY_DOT: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-amber-500',
  low: 'bg-green-500',
};

function DraggableWOCard({
  wo,
  overlay = false,
  onClick,
}: { wo: WorkOrder; overlay?: boolean; onClick?: (wo: WorkOrder) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: wo.id,
    data: { wo },
  });

  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`bg-[#0b1120] border border-white/[0.06] border-l-2 ${PRIORITY_COLORS[wo.priority] ?? 'border-l-gray-700'} rounded-lg p-3 select-none ${
        isDragging && !overlay ? 'opacity-40' : ''
      } ${overlay ? 'shadow-2xl ring-1 ring-blue-500/40' : ''}`}
    >
      <div className="flex items-start gap-2">
        <div
          {...attributes}
          {...listeners}
          className="mt-0.5 cursor-grab active:cursor-grabbing text-gray-600 hover:text-gray-400 flex-shrink-0"
        >
          <GripVertical size={14} />
        </div>
        <div className="flex-1 min-w-0" onClick={() => onClick?.(wo)} style={{ cursor: onClick ? 'pointer' : 'default' }}>
          <div className="flex items-center gap-1.5 mb-1">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PRIORITY_DOT[wo.priority] ?? 'bg-gray-500'}`} />
            <span className="text-[10px] text-gray-600 font-mono">{wo.wo_number}</span>
            {wo.ticket_id && (
              <span className="ml-auto flex items-center gap-0.5 text-[10px] text-purple-400 bg-purple-500/10 border border-purple-500/20 px-1 py-0.5 rounded font-mono">
                <Ticket size={9} />
                {wo.ticket_number ?? 'TKT'}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-300 font-medium leading-snug truncate">{wo.title}</p>
          {wo.equipment_name && (
            <p className="text-[10px] text-gray-600 mt-0.5 truncate">{wo.equipment_name}</p>
          )}
          {wo.scheduled_date && (
            <div className="flex items-center gap-1 mt-1">
              <CalendarDays size={9} className="text-green-500" />
              <span className="text-[10px] text-green-500">{wo.scheduled_date}</span>
              {wo.scheduled_start_time && (
                <span className="text-[10px] text-gray-600">{wo.scheduled_start_time}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DroppableColumn({
  id,
  label,
  subtitle,
  items,
  onCardClick,
}: {
  id: string;
  label: string;
  subtitle?: string;
  items: WorkOrder[];
  onCardClick?: (wo: WorkOrder) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={`flex-shrink-0 w-56 flex flex-col rounded-xl border transition-colors ${
        isOver
          ? 'border-blue-500/50 bg-blue-500/5'
          : 'border-white/[0.06] bg-[#0d1421]'
      }`}
    >
      {/* Column header */}
      <div className="p-3 border-b border-white/[0.06] flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
            <User size={12} className="text-blue-400" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-gray-300 truncate">{label}</p>
            {subtitle && <p className="text-[10px] text-gray-600 truncate">{subtitle}</p>}
          </div>
        </div>
        <div className="mt-1.5">
          <span className="text-[10px] text-gray-600">{items.length} WO{items.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Cards */}
      <div className="flex-1 p-2 space-y-2 min-h-[120px] overflow-y-auto">
        {items.map((wo) => (
          <DraggableWOCard key={wo.id} wo={wo} onClick={onCardClick} />
        ))}
        {items.length === 0 && (
          <div className="flex items-center justify-center h-20 border border-dashed border-white/[0.06] rounded-lg">
            <p className="text-[10px] text-gray-700">Drop here</p>
          </div>
        )}
      </div>
    </div>
  );
}

function WODetailPanel({ wo, onClose }: { wo: WorkOrder; onClose: () => void }) {
  const navigate = useNavigate();
  const PRIORITY_BADGE: Record<string, string> = {
    critical: 'bg-red-500/15 text-red-400 border-red-500/25',
    high:     'bg-orange-500/15 text-orange-400 border-orange-500/25',
    medium:   'bg-sky-500/15 text-sky-400 border-sky-500/25',
    low:      'bg-gray-500/15 text-gray-400 border-gray-500/25',
  };
  return (
    <div className="flex-shrink-0 w-72 flex flex-col rounded-xl border border-blue-500/30 bg-[#0d1421] shadow-xl">
      <div className="p-3 border-b border-white/[0.06] flex items-center justify-between flex-shrink-0">
        <p className="text-xs font-semibold text-gray-200">WO Details</p>
        <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors p-0.5">
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 p-4 space-y-3 overflow-y-auto">
        <div>
          <p className="text-[10px] text-gray-600 uppercase tracking-wide mb-0.5">WO Number</p>
          <p className="text-sm font-mono text-gray-200">{wo.wo_number}</p>
        </div>
        <div>
          <p className="text-[10px] text-gray-600 uppercase tracking-wide mb-0.5">Title</p>
          <p className="text-xs text-gray-300 leading-snug">{wo.title}</p>
        </div>
        <div className="flex gap-2">
          <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-mono border rounded ${PRIORITY_BADGE[wo.priority] ?? ''}`}>
            {wo.priority}
          </span>
          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-mono border rounded bg-white/[0.04] text-gray-400 border-white/[0.08]">
            {wo.status}
          </span>
        </div>
        {wo.equipment_name && (
          <div>
            <p className="text-[10px] text-gray-600 uppercase tracking-wide mb-0.5">Equipment</p>
            <p className="text-xs text-gray-400">{wo.equipment_name}</p>
          </div>
        )}
        {wo.ticket_id && (
          <div className="bg-purple-500/5 border border-purple-500/20 rounded-lg p-3 space-y-1.5">
            <div className="flex items-center gap-1.5 mb-1">
              <Ticket size={12} className="text-purple-400" />
              <p className="text-[10px] text-purple-400 font-semibold uppercase tracking-wide">Linked Ticket</p>
            </div>
            <p className="text-xs font-mono text-gray-300">{wo.ticket_number ?? wo.ticket_id}</p>
            <button
              onClick={() => navigate(`/tickets/${wo.ticket_id}`)}
              className="flex items-center gap-1 text-[11px] text-purple-400 hover:text-purple-300 transition-colors"
            >
              <ChevronRight size={12} /> View ticket
            </button>
          </div>
        )}
        {wo.executor_id && (
          <div>
            <p className="text-[10px] text-gray-600 uppercase tracking-wide mb-0.5">Assigned To</p>
            <p className="text-xs text-gray-400">{wo.executor_name ?? wo.executor_id}</p>
          </div>
        )}
        {wo.scheduled_date && (
          <div className="bg-green-500/5 border border-green-500/20 rounded-lg p-3 space-y-1">
            <div className="flex items-center gap-1.5 mb-1">
              <CalendarDays size={12} className="text-green-400" />
              <p className="text-[10px] text-green-400 font-semibold uppercase tracking-wide">Schedule</p>
            </div>
            <p className="text-xs text-gray-300">{wo.scheduled_date}</p>
            {(wo.scheduled_start_time || wo.scheduled_end_time) && (
              <p className="text-xs text-gray-500">
                {wo.scheduled_start_time ?? '—'} → {wo.scheduled_end_time ?? '—'}
              </p>
            )}
          </div>
        )}
        <button
          onClick={() => navigate(`/work-orders/${wo.id}`)}
          className="w-full btn-secondary py-1.5 text-xs flex items-center justify-center gap-1.5"
        >
          <ChevronRight size={13} /> Open full WO
        </button>
      </div>
    </div>
  );
}

export default function LaborScheduler() {
  const { t } = useTranslation();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const upsertWorkOrder = useWorkOrderStore((s) => s.upsertWorkOrder);

  const [allWOs, setAllWOs] = useState<WorkOrder[]>([]);
  const [techs, setTechs] = useState<TechnicianFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeWO, setActiveWO] = useState<WorkOrder | null>(null);
  const [selectedWO, setSelectedWO] = useState<WorkOrder | null>(null);

  // Derived state: partition WOs into columns
  const [assignments, setAssignments] = useState<Map<string | null, WorkOrder[]>>(new Map());

  useEffect(() => {
    Promise.allSettled([
      fetchWorkOrders({ status: 'open', limit: '100' }),
      fetchTechniciansFull(),
    ]).then(([wo, te]) => {
      const wos = wo.status === 'fulfilled' ? wo.value : [];
      const techList = te.status === 'fulfilled' ? te.value : [];
      setAllWOs(wos);
      setTechs(techList);

      // Build assignment map
      const map = new Map<string | null, WorkOrder[]>();
      map.set(null, []); // unassigned column
      techList.forEach((t) => map.set(t.id, []));
      wos.forEach((w) => {
        const key = w.executor_id ?? null;
        if (!map.has(key)) map.set(null, [...(map.get(null) ?? []), w]);
        else map.set(key, [...(map.get(key) ?? []), w]);
      });
      setAssignments(map);
      setLoading(false);
    });
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const wo = allWOs.find((w) => w.id === event.active.id);
    setActiveWO(wo ?? null);
  }, [allWOs]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    setActiveWO(null);
    const { active, over } = event;
    if (!over) return;

    const woId = active.id as string;
    const targetColId = over.id as string; // technician.id or 'unassigned'
    const executorId = targetColId === 'unassigned' ? null : targetColId;

    // Find which column the WO is currently in
    let sourceColId: string | null = null;
    assignments.forEach((wos, colId) => {
      if (wos.some((w) => w.id === woId)) sourceColId = colId;
    });

    if (sourceColId === executorId) return; // no change

    // Optimistic update
    setAssignments((prev) => {
      const next = new Map(prev);
      const sourceWOs = (next.get(sourceColId) ?? []).filter((w) => w.id !== woId);
      next.set(sourceColId, sourceWOs);

      const movedWO = allWOs.find((w) => w.id === woId);
      if (movedWO) {
        const targetWOs = [...(next.get(executorId) ?? []), { ...movedWO, executor_id: executorId ?? undefined }];
        next.set(executorId, targetWOs);
      }
      return next;
    });

    // Persist via API
    try {
      const updated = await updateWorkOrder(woId, { executor_id: executorId });
      setAllWOs((prev) => prev.map((w) => w.id === woId ? { ...w, executor_id: executorId ?? undefined } : w));
      upsertWorkOrder(updated);
    } catch {
      // Revert on failure — reload from server
      const fresh = await fetchWorkOrders({ status: 'open', limit: '100' });
      setAllWOs(fresh);
      const map = new Map<string | null, WorkOrder[]>();
      map.set(null, []);
      techs.forEach((t) => map.set(t.id, []));
      fresh.forEach((w) => {
        const key = w.executor_id ?? null;
        if (!map.has(key)) map.set(null, [...(map.get(null) ?? []), w]);
        else map.set(key, [...(map.get(key) ?? []), w]);
      });
      setAssignments(map);
    }
  }, [allWOs, assignments, techs, upsertWorkOrder]);

  return (
    <div className="p-6 flex flex-col h-full min-h-0 space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">{t('schedule.title')}</h1>
        <p className="text-gray-500 text-sm mt-0.5">{t('schedule.subtitle')}</p>
      </div>

      {/* Stats bar */}
      <div className="flex items-center gap-4 text-sm">
        <div className="flex items-center gap-1.5 text-gray-400">
          <AlertCircle size={14} className="text-amber-400" />
          <span>{assignments.get(null)?.length ?? 0} unassigned</span>
        </div>
        <div className="flex items-center gap-1.5 text-gray-400">
          <Clock size={14} className="text-blue-400" />
          <span>{allWOs.length} total open WOs</span>
        </div>
        <div className="flex items-center gap-1.5 text-gray-400">
          <User size={14} className="text-green-400" />
          <span>{techs.length} technicians</span>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
          {t('common.loading')}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-4 overflow-x-auto pb-4 flex-1">
            {/* Unassigned column */}
            <DroppableColumn
              id="unassigned"
              label={t('schedule.unassigned')}
              subtitle={t('schedule.dragToAssign')}
              items={assignments.get(null) ?? []}
              onCardClick={setSelectedWO}
            />

            {/* Divider */}
            <div className="w-px bg-white/[0.06] flex-shrink-0 self-stretch" />

            {/* Technician columns */}
            {techs.length === 0 ? (
              <div className="flex items-center justify-center w-56 rounded-xl border border-dashed border-white/[0.06] text-gray-600 text-xs p-4 text-center flex-shrink-0">
                {t('schedule.noTechnicians')}
              </div>
            ) : (
              techs.map((tech) => (
                <DroppableColumn
                  key={tech.id}
                  id={tech.id}
                  label={tech.full_name ?? tech.email ?? 'Technician'}
                  subtitle={tech.specialty ? `${tech.specialty} · ${tech.shift ?? ''}` : tech.shift}
                  items={assignments.get(tech.id) ?? []}
                  onCardClick={setSelectedWO}
                />
              ))
            )}

            {/* Side panel */}
            {selectedWO && (
              <WODetailPanel wo={selectedWO} onClose={() => setSelectedWO(null)} />
            )}
          </div>

          {/* Drag overlay */}
          <DragOverlay>
            {activeWO ? <DraggableWOCard wo={activeWO} overlay /> : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}
