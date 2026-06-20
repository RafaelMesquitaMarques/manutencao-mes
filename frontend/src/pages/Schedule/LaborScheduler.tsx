import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  CollisionDetection,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, arrayMove, verticalListSortingStrategy, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  GripVertical, User, Users, AlertCircle, Clock, Ticket, X, CalendarDays,
  ChevronRight, Search, Lock, RotateCcw,
} from 'lucide-react';
import { fetchAllWorkOrders, fetchTechniciansFull, assignWorkOrder, reorderWorkOrders } from '../../api/workOrders';
import { fetchAvailableTickets, assignTicket } from '../../api/maintenance';
import { fetchEscalationSettings, updateEscalationSettings } from '../../api/escalation';
import { useWorkOrderStore } from '../../store/workOrderStore';
import type { WorkOrder, TechnicianFull, MaintenanceTicket } from '../../types';

// Technician tiles auto-arrange in a wrapping grid (drag the header to reorder,
// they reflow and never overlap). Each tile keeps its own size — drag the
// bottom-right corner to resize. Sizes in px.
interface TileSize { w: number; h: number }
const TILE_W = 250, TILE_H = 248;
const MIN_W = 180, MIN_H = 120;
const DEFAULT_SIZE: TileSize = { w: TILE_W, h: TILE_H };

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

/** Technician ids assigned to a WO (multi-tech aware, executor_id fallback). */
function woTechIds(wo: WorkOrder): string[] {
  if (wo.technicians && wo.technicians.length > 0) {
    return wo.technicians.map((t) => t.technician_id);
  }
  return wo.executor_id ? [wo.executor_id] : [];
}

const _STATUS_RANK: Record<string, number> = { in_progress: 0, open: 1, on_hold: 2 };

/** In-progress work pinned on top (priority 1); then the manual board order set by
 * drag-reorder; unordered ones fall back to FIFO (assignment order) by opened_at. */
function woSort(a: WorkOrder, b: WorkOrder): number {
  const s = (_STATUS_RANK[a.status] ?? 9) - (_STATUS_RANK[b.status] ?? 9);
  if (s !== 0) return s;
  const ao = a.board_order ?? Number.MAX_SAFE_INTEGER;
  const bo = b.board_order ?? Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  return (a.opened_at ?? '').localeCompare(b.opened_at ?? '');
}

function buildAssignments(
  wos: WorkOrder[],
  techList: TechnicianFull[]
): Map<string | null, WorkOrder[]> {
  const map = new Map<string | null, WorkOrder[]>();
  map.set(null, []);
  techList.forEach((t) => map.set(t.id, []));
  wos.forEach((w) => {
    // One entry per assigned technician — a multi-tech WO shows in every column
    const ids = woTechIds(w).filter((id) => map.has(id));
    if (ids.length === 0) map.set(null, [...(map.get(null) ?? []), w]);
    else ids.forEach((id) => map.set(id, [...(map.get(id) ?? []), w]));
  });
  map.forEach((list) => list.sort(woSort));   // in-progress on top, then by priority
  return map;
}

const WO_CARD_CLS = (wo: WorkOrder, extra = '') =>
  `bg-[#0b1120] border border-white/[0.06] border-l-2 ${PRIORITY_COLORS[wo.priority] ?? 'border-l-gray-700'} rounded-lg p-3 select-none ${extra}`;

function WOCardInner({ wo, onClick }: { wo: WorkOrder; onClick?: (wo: WorkOrder) => void }) {
  const techCount = woTechIds(wo).length;
  return (
    <div className="flex-1 min-w-0" onClick={() => onClick?.(wo)} style={{ cursor: onClick ? 'pointer' : 'default' }}>
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PRIORITY_DOT[wo.priority] ?? 'bg-gray-500'}`} />
        <span className="text-[10px] text-gray-600 font-mono">{wo.wo_number}</span>
        {wo.status === 'in_progress' && (
          <span className="flex items-center gap-1 text-[10px] text-red-400 bg-red-500/10 border border-red-500/25 px-1.5 py-0.5 rounded font-semibold uppercase">
            <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
            en cours
          </span>
        )}
        {techCount > 1 && (
          <span className="flex items-center gap-0.5 text-[10px] text-blue-400 bg-blue-500/10 border border-blue-500/20 px-1 py-0.5 rounded font-mono">
            <Users size={9} />
            {techCount}
          </span>
        )}
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
  );
}

/** Sortable WO card (open / not-started) — drag to reorder priority or reassign. */
function SortableWOCard({ wo, colId, onClick }: { wo: WorkOrder; colId: string; onClick?: (wo: WorkOrder) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `${wo.id}|${colId}`,
    data: { type: 'wo', wo, colId },
  });
  const style = { transform: CSS.Translate.toString(transform), transition };
  return (
    <div ref={setNodeRef} style={style} className={WO_CARD_CLS(wo, isDragging ? 'opacity-40' : '')}>
      <div className="flex items-start gap-2">
        <div {...attributes} {...listeners} className="mt-0.5 cursor-grab active:cursor-grabbing text-gray-600 hover:text-gray-400 flex-shrink-0">
          <GripVertical size={14} />
        </div>
        <WOCardInner wo={wo} onClick={onClick} />
      </div>
    </div>
  );
}

/** In-progress WO — pinned at the top (priority 1), not draggable. */
function LockedWOCard({ wo, onClick }: { wo: WorkOrder; onClick?: (wo: WorkOrder) => void }) {
  return (
    <div className={WO_CARD_CLS(wo)} title="En cours — priorité verrouillée">
      <div className="flex items-start gap-2">
        <div className="mt-0.5 text-gray-700 flex-shrink-0"><Lock size={13} /></div>
        <WOCardInner wo={wo} onClick={onClick} />
      </div>
    </div>
  );
}

function WOCardOverlay({ wo }: { wo: WorkOrder }) {
  return (
    <div className={WO_CARD_CLS(wo, 'shadow-2xl ring-1 ring-blue-500/40')}>
      <div className="flex items-start gap-2">
        <div className="mt-0.5 text-gray-600 flex-shrink-0"><GripVertical size={14} /></div>
        <WOCardInner wo={wo} />
      </div>
    </div>
  );
}

const TK_CARD_CLS = (ticket: MaintenanceTicket, extra = '') =>
  `bg-[#0b1120] border border-purple-500/20 border-l-2 ${PRIORITY_COLORS[ticket.priority] ?? 'border-l-gray-700'} rounded-lg p-3 select-none ${extra}`;

function TicketCardInner({ ticket, onClick }: { ticket: MaintenanceTicket; onClick?: (t: MaintenanceTicket) => void }) {
  return (
    <div className="flex-1 min-w-0" onClick={() => onClick?.(ticket)} style={{ cursor: onClick ? 'pointer' : 'default' }}>
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PRIORITY_DOT[ticket.priority] ?? 'bg-gray-500'}`} />
        <span className="flex items-center gap-0.5 text-[10px] text-purple-400 bg-purple-500/10 border border-purple-500/20 px-1 py-0.5 rounded font-mono">
          <Ticket size={9} /> {ticket.ticket_number}
        </span>
      </div>
      <p className="text-xs text-gray-300 font-medium leading-snug truncate">
        {ticket.machine_name ?? '—'}{ticket.problem_type ? ` · ${ticket.problem_type}` : ''}
      </p>
      {ticket.description && (
        <p className="text-[10px] text-gray-600 mt-0.5 truncate">{ticket.description}</p>
      )}
    </div>
  );
}

/** Draggable open ticket (no work order yet) — dropping it on a technician
 * auto-creates a work order assigned to them. */
function SortableTicketCard({ ticket, onClick }: { ticket: MaintenanceTicket; onClick?: (t: MaintenanceTicket) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `tk:${ticket.id}|unassigned`,
    data: { type: 'ticket', ticket },
  });
  const style = { transform: CSS.Translate.toString(transform), transition };
  return (
    <div ref={setNodeRef} style={style} className={TK_CARD_CLS(ticket, isDragging ? 'opacity-40' : '')}>
      <div className="flex items-start gap-2">
        <div {...attributes} {...listeners} className="mt-0.5 cursor-grab active:cursor-grabbing text-gray-600 hover:text-gray-400 flex-shrink-0">
          <GripVertical size={14} />
        </div>
        <TicketCardInner ticket={ticket} onClick={onClick} />
      </div>
    </div>
  );
}

function TicketCardOverlay({ ticket }: { ticket: MaintenanceTicket }) {
  return (
    <div className={TK_CARD_CLS(ticket, 'shadow-2xl ring-1 ring-purple-500/40')}>
      <div className="flex items-start gap-2">
        <div className="mt-0.5 text-gray-600 flex-shrink-0"><GripVertical size={14} /></div>
        <TicketCardInner ticket={ticket} />
      </div>
    </div>
  );
}

/** Left column: unassigned tickets (drag → creates a WO) + unassigned WOs. */
function UnassignedColumn({
  items,
  tickets,
  onCardClick,
  onTicketClick,
  title,
  subtitle,
}: {
  items: WorkOrder[];
  tickets: MaintenanceTicket[];
  onCardClick?: (wo: WorkOrder) => void;
  onTicketClick?: (t: MaintenanceTicket) => void;
  title: string;
  subtitle?: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: 'unassigned' });
  const total = items.length + tickets.length;

  return (
    <div
      ref={setNodeRef}
      className={`h-full w-full flex flex-col rounded-xl border transition-colors ${
        isOver ? 'border-blue-500/50 bg-blue-500/5' : 'border-white/[0.06] bg-[#0d1421]'
      }`}
    >
      <div className="p-3 border-b border-white/[0.06] flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-amber-500/20 flex items-center justify-center flex-shrink-0">
            <AlertCircle size={12} className="text-amber-400" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-gray-300 truncate">{title}</p>
            {subtitle && <p className="text-[10px] text-gray-600 truncate">{subtitle}</p>}
          </div>
          <span className={`ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full ${
            total > 0 ? 'bg-amber-500/15 text-amber-400' : 'bg-white/[0.04] text-gray-600'
          }`}>
            {total}
          </span>
        </div>
      </div>
      <div className="flex-1 p-2 space-y-2 overflow-y-auto">
        <SortableContext
          items={[...tickets.map((tk) => `tk:${tk.id}|unassigned`), ...items.map((wo) => `${wo.id}|unassigned`)]}
          strategy={verticalListSortingStrategy}
        >
          {tickets.map((tk) => (
            <SortableTicketCard key={`tk:${tk.id}`} ticket={tk} onClick={onTicketClick} />
          ))}
          {items.map((wo) => (
            <SortableWOCard key={`${wo.id}|unassigned`} wo={wo} colId="unassigned" onClick={onCardClick} />
          ))}
        </SortableContext>
        {total === 0 && (
          <div className="flex items-center justify-center h-20 border border-dashed border-white/[0.06] rounded-lg">
            <p className="text-[10px] text-gray-700">Drop here</p>
          </div>
        )}
      </div>
    </div>
  );
}

type TechStatus = 'busy' | 'assigned' | 'free';

const TECH_STATUS_STYLE: Record<TechStatus, { bg: string; icon: string; pulse: boolean; label: string }> = {
  busy:     { bg: 'bg-red-500/20 ring-2 ring-red-500/50',     icon: 'text-red-400',   pulse: true,  label: 'Busy — WO in progress' },
  assigned: { bg: 'bg-amber-500/20 ring-2 ring-amber-500/40', icon: 'text-amber-400', pulse: false, label: 'Assigned — open WOs' },
  free:     { bg: 'bg-green-500/20 ring-2 ring-green-500/40', icon: 'text-green-400', pulse: false, label: 'Available' },
};

/** One technician tile — a sortable grid cell: drag the header to reorder it
 * (tiles reflow and never overlap), drag the bottom-right corner to resize it.
 * Body scrolls to fit. */
function TechCell({
  tech,
  items,
  status,
  size,
  onResize,
  onResizeCommit,
  onCardClick,
}: {
  tech: TechnicianFull;
  items: WorkOrder[];
  status: TechStatus;
  size: TileSize;
  onResize: (s: TileSize) => void;
  onResizeCommit: () => void;
  onCardClick?: (wo: WorkOrder) => void;
}) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: tech.id });
  const {
    setNodeRef: setSortRef, attributes, listeners, transform, transition, isDragging,
  } = useSortable({ id: `panel:${tech.id}`, data: { type: 'panel', techId: tech.id } });
  const setRefs = (el: HTMLElement | null) => { setDropRef(el); setSortRef(el); };
  const s = TECH_STATUS_STYLE[status];
  const [resizing, setResizing] = useState(false);
  const inProgress = items.filter((w) => w.status === 'in_progress');
  const openItems = items.filter((w) => w.status !== 'in_progress');

  const startResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    const w0 = size.w, h0 = size.h;
    setResizing(true);
    const onPointerMove = (ev: PointerEvent) => {
      onResize({ w: Math.max(MIN_W, w0 + ev.clientX - sx), h: Math.max(MIN_H, h0 + ev.clientY - sy) });
    };
    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      setResizing(false);
      onResizeCommit();
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  return (
    <div
      ref={setRefs}
      style={{
        width: size.w, height: size.h,
        transform: CSS.Transform.toString(transform), transition,
        zIndex: isDragging ? 50 : undefined, opacity: isDragging ? 0.85 : 1,
      }}
      className={`flex flex-col flex-shrink-0 rounded-xl border ${
        isDragging || resizing
          ? 'border-blue-500/60 ring-1 ring-blue-500/30 shadow-2xl shadow-black/50'
          : isOver ? 'border-blue-500/50 bg-blue-500/5' : 'border-white/[0.06] bg-[#0d1421]'
      }`}
    >
      <div
        {...attributes}
        {...listeners}
        style={{ touchAction: 'none' }}
        className="p-3 border-b border-white/[0.06] cursor-move select-none flex-shrink-0"
      >
        <div className="flex items-center gap-2">
          <GripVertical size={13} className="text-gray-600 flex-shrink-0" />
          <div
            title={s.label}
            className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${s.bg} ${s.pulse ? 'animate-pulse' : ''}`}
          >
            <User size={12} className={s.icon} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-gray-300 truncate">{tech.full_name ?? tech.email ?? 'Technician'}</p>
            <p className="text-[10px] text-gray-600 truncate">
              {[tech.specialty, tech.shift].filter(Boolean).join(' · ') || '—'}
            </p>
          </div>
          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full flex-shrink-0 ${
            items.length > 0 ? 'bg-blue-500/15 text-blue-400' : 'bg-white/[0.04] text-gray-600'
          }`}>
            {items.length}
          </span>
        </div>
      </div>
      <div className="flex-1 p-2 space-y-2 overflow-y-auto">
        {inProgress.map((wo) => (
          <LockedWOCard key={`${wo.id}|${tech.id}`} wo={wo} onClick={onCardClick} />
        ))}
        <SortableContext items={openItems.map((wo) => `${wo.id}|${tech.id}`)} strategy={verticalListSortingStrategy}>
          {openItems.map((wo) => (
            <SortableWOCard key={`${wo.id}|${tech.id}`} wo={wo} colId={tech.id} onClick={onCardClick} />
          ))}
        </SortableContext>
        {items.length === 0 && (
          <div className="flex items-center justify-center h-12 border border-dashed border-white/[0.06] rounded-lg">
            <p className="text-[10px] text-gray-700">Drop here</p>
          </div>
        )}
      </div>
      {/* Resize handle (bottom-right corner) */}
      <div
        onPointerDown={startResize}
        title="Redimensionner"
        style={{ touchAction: 'none' }}
        className="absolute bottom-0 right-0 w-5 h-5 cursor-se-resize flex items-end justify-end p-0.5 text-gray-600 hover:text-blue-400"
      >
        <svg viewBox="0 0 10 10" width="9" height="9" className="fill-current">
          <path d="M10 0v10H0z" opacity="0.6" />
        </svg>
      </div>
    </div>
  );
}

/** Fixed right-side drawer — visible immediately on click, anywhere on the page. */
function WODetailDrawer({
  wo,
  techs,
  onClose,
  onUpdate,
}: {
  wo: WorkOrder;
  techs: TechnicianFull[];
  onClose: () => void;
  onUpdate: (updated: WorkOrder) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [assignError, setAssignError] = useState('');
  const PRIORITY_BADGE: Record<string, string> = {
    critical: 'bg-red-500/15 text-red-400 border-red-500/25',
    high:     'bg-orange-500/15 text-orange-400 border-orange-500/25',
    medium:   'bg-sky-500/15 text-sky-400 border-sky-500/25',
    low:      'bg-gray-500/15 text-gray-400 border-gray-500/25',
  };
  const assigned = wo.technicians ?? [];
  const assignedIds = woTechIds(wo);
  const available = techs.filter((tech) => !assignedIds.includes(tech.id));

  const saveAssignment = async (ids: string[]) => {
    setSaving(true);
    setAssignError('');
    try {
      const updated = await assignWorkOrder(wo.id, ids);
      onUpdate(updated);
    } catch {
      setAssignError(t('schedule.assignFailed', 'Failed to update assignment'));
    } finally {
      setSaving(false);
    }
  };

  const addTech = (techId: string) => {
    if (!techId || assignedIds.includes(techId)) return;
    saveAssignment([...assignedIds, techId]);
  };

  const removeTech = (techId: string) => {
    saveAssignment(assignedIds.filter((id) => id !== techId));
  };

  const techName = (id: string, fallback?: string | null) =>
    fallback ?? techs.find((tech) => tech.id === id)?.full_name ?? `${id.slice(0, 8)}…`;
  return (
    <div className="fixed top-20 right-4 bottom-4 w-80 z-40 flex flex-col rounded-xl border border-blue-500/30 bg-[#0d1421] shadow-2xl shadow-black/60">
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
        {/* Assigned technicians — add/remove without leaving the page */}
        <div>
          <p className="text-[10px] text-gray-600 uppercase tracking-wide mb-1">Assigned Technicians</p>
          {assignedIds.length === 0 && (
            <p className="text-[11px] text-gray-600 italic mb-1.5">
              {t('schedule.noneAssigned', 'No technician assigned yet')}
            </p>
          )}
          <div className="flex flex-wrap gap-1 mb-2">
            {assigned.length > 0
              ? assigned.map((tech) => (
                  <span
                    key={tech.technician_id}
                    className="inline-flex items-center gap-1 bg-blue-500/10 border border-blue-500/25 text-blue-300 rounded-full pl-2 pr-1 py-0.5 text-[10px]"
                  >
                    <User size={9} className="text-blue-400/70" />
                    {techName(tech.technician_id, tech.name)}
                    <button
                      onClick={() => removeTech(tech.technician_id)}
                      disabled={saving}
                      title={t('schedule.removeTech', 'Remove technician')}
                      className="p-0.5 rounded-full text-blue-400/60 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))
              : assignedIds.map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 bg-blue-500/10 border border-blue-500/25 text-blue-300 rounded-full pl-2 pr-1 py-0.5 text-[10px]"
                  >
                    <User size={9} className="text-blue-400/70" />
                    {techName(id, wo.executor_name)}
                    <button
                      onClick={() => removeTech(id)}
                      disabled={saving}
                      title={t('schedule.removeTech', 'Remove technician')}
                      className="p-0.5 rounded-full text-blue-400/60 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
          </div>
          {available.length > 0 && (
            <select
              value=""
              onChange={(e) => addTech(e.target.value)}
              disabled={saving}
              className="w-full bg-[#0b1120] border border-white/[0.08] rounded-lg px-2 py-1.5 text-[11px] text-gray-300 focus:outline-none focus:border-blue-500 disabled:opacity-50"
            >
              <option value="">
                {saving
                  ? t('common.saving', 'Saving…')
                  : `+ ${t('schedule.addTech', 'Add technician…')}`}
              </option>
              {available.map((tech) => (
                <option key={tech.id} value={tech.id}>
                  {tech.full_name ?? tech.email}{tech.specialty ? ` — ${tech.specialty}` : ''}
                </option>
              ))}
            </select>
          )}
          {assignError && <p className="text-[11px] text-red-400 mt-1">{assignError}</p>}
        </div>
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
  const navigate = useNavigate();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const upsertWorkOrder = useWorkOrderStore((s) => s.upsertWorkOrder);

  // Keep the two drag flows independent: a tile drag (`panel:`) only collides with
  // other tiles; a card/ticket drag only collides with columns/cards (never tiles).
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const isPanel = String(args.active.id).startsWith('panel:');
    const droppableContainers = args.droppableContainers.filter((c) =>
      String(c.id).startsWith('panel:') === isPanel,
    );
    return closestCenter({ ...args, droppableContainers });
  }, []);

  // Board holds open + in-progress WOs; in-progress ones get the "en cours" badge
  const [allWOs, setAllWOs] = useState<WorkOrder[]>([]);
  const [tickets, setTickets] = useState<MaintenanceTicket[]>([]);   // open, unassigned, no WO yet
  const [techs, setTechs] = useState<TechnicianFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeWO, setActiveWO] = useState<WorkOrder | null>(null);
  const [activeTicket, setActiveTicket] = useState<MaintenanceTicket | null>(null);
  const [selectedWO, setSelectedWO] = useState<WorkOrder | null>(null);
  const [search, setSearch] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [selfAssign, setSelfAssign] = useState<boolean | null>(null);
  const [savingSelfAssign, setSavingSelfAssign] = useState(false);
  // Per-user dashboard layout, persisted: tile order (drag-to-reorder) + per-tile size
  const [order, setOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('labor_order_v1') || '[]'); } catch { return []; }
  });
  const [sizes, setSizes] = useState<Record<string, TileSize>>(() => {
    try { return JSON.parse(localStorage.getItem('labor_sizes_v1') || '{}'); } catch { return {}; }
  });

  useEffect(() => {
    fetchEscalationSettings()
      .then((r) => setSelfAssign(r.settings.technician_self_assign))
      .catch(() => setSelfAssign(null));
  }, []);

  const toggleSelfAssign = async () => {
    if (selfAssign === null || savingSelfAssign) return;
    const next = !selfAssign;
    setSavingSelfAssign(true);
    setSelfAssign(next);
    try {
      await updateEscalationSettings({ technician_self_assign: next });
    } catch {
      setSelfAssign(!next);
    } finally {
      setSavingSelfAssign(false);
    }
  };

  // Columns derived from WO data — a WO appears in every assigned tech's column
  const assignments = useMemo(() => buildAssignments(allWOs, techs), [allWOs, techs]);
  const unassignedCount = (assignments.get(null)?.length ?? 0) + tickets.length;
  const techIdSet = useMemo(() => new Set(techs.map((tc) => tc.id)), [techs]);

  // Live resize while dragging the corner (no persist), then commit on release
  const liveSize = useCallback((id: string, sz: TileSize) => {
    setSizes((prev) => ({ ...prev, [id]: sz }));
  }, []);

  const commitSizes = useCallback(() => {
    setSizes((prev) => {
      try { localStorage.setItem('labor_sizes_v1', JSON.stringify(prev)); } catch { /* ignore */ }
      return prev;
    });
  }, []);

  const sizeOf = useCallback((id: string): TileSize => {
    const sz = sizes[id];
    return sz && sz.w >= MIN_W && sz.h >= MIN_H ? sz : DEFAULT_SIZE;
  }, [sizes]);

  const resetLayout = useCallback(() => {
    setOrder([]);
    setSizes({});
    try {
      localStorage.removeItem('labor_order_v1');
      localStorage.removeItem('labor_sizes_v1');
      localStorage.removeItem('labor_layout_v2');   // drop legacy free-floating layout
    } catch { /* ignore */ }
  }, []);

  // Default tile order when nothing is saved yet: technicians WITH work orders
  // first, empty ones last (only seeds the initial order).
  const orderedAllTechs = useMemo(() => {
    const hasWork = (id: string) => (assignments.get(id)?.length ?? 0) > 0;
    return [...techs].sort((a, b) =>
      (Number(hasWork(b.id)) - Number(hasWork(a.id))) ||
      (a.full_name ?? '').localeCompare(b.full_name ?? ''));
  }, [techs, assignments]);

  // Keep the saved order in sync with the roster: append new techs (in default
  // order), drop any that no longer exist. No-op when already consistent.
  useEffect(() => {
    const all = orderedAllTechs.map((tc) => tc.id);
    const present = new Set(all);
    setOrder((prev) => {
      const pruned = prev.filter((id) => present.has(id));
      const missing = all.filter((id) => !prev.includes(id));
      if (missing.length === 0 && pruned.length === prev.length) return prev;
      return [...pruned, ...missing];
    });
  }, [orderedAllTechs]);

  const specialties = useMemo(
    () => Array.from(new Set(techs.map((t) => t.specialty).filter(Boolean))) as string[],
    [techs],
  );

  const filteredTechs = useMemo(
    () => orderedAllTechs.filter((tech) => {
      if (specialty && tech.specialty !== specialty) return false;
      if (search) {
        const name = `${tech.full_name ?? ''} ${tech.email ?? ''}`.toLowerCase();
        if (!name.includes(search.toLowerCase())) return false;
      }
      return true;
    }),
    [orderedAllTechs, search, specialty],
  );

  // Visible tiles, laid out in the saved drag-to-reorder sequence
  const orderIndex = useMemo(() => {
    const m = new Map<string, number>();
    order.forEach((id, i) => m.set(id, i));
    return m;
  }, [order]);

  const displayTechs = useMemo(
    () => [...filteredTechs].sort(
      (a, b) => (orderIndex.get(a.id) ?? Infinity) - (orderIndex.get(b.id) ?? Infinity),
    ),
    [filteredTechs, orderIndex],
  );

  const reload = useCallback(async () => {
    const [wo, wip, te, tk] = await Promise.allSettled([
      fetchAllWorkOrders({ status: 'open' }),
      fetchAllWorkOrders({ status: 'in_progress' }),
      fetchTechniciansFull(),
      fetchAvailableTickets(),
    ]);
    setAllWOs([
      ...(wo.status === 'fulfilled' ? wo.value : []),
      ...(wip.status === 'fulfilled' ? wip.value : []),
    ]);
    setTechs(te.status === 'fulfilled' ? te.value : []);
    setTickets(tk.status === 'fulfilled' ? tk.value.filter((t) => !t.work_order_id) : []);
    setLoading(false);
  }, []);

  // busy = executing a WO right now; assigned = has open WOs; free = neither
  const busyTechIds = useMemo(() => {
    const ids = new Set<string>();
    allWOs
      .filter((w) => w.status === 'in_progress')
      .forEach((w) => woTechIds(w).forEach((id) => ids.add(id)));
    return ids;
  }, [allWOs]);

  const techStatus = useCallback((techId: string): TechStatus => {
    if (busyTechIds.has(techId)) return 'busy';
    if ((assignments.get(techId) ?? []).length > 0) return 'assigned';
    return 'free';
  }, [busyTechIds, assignments]);

  useEffect(() => { reload(); }, [reload]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const idStr = String(event.active.id);
    if (idStr.startsWith('panel:')) {        // reordering a technician tile, not a card
      setActiveWO(null);
      setActiveTicket(null);
      return;
    }
    if (idStr.startsWith('tk:')) {
      const tid = idStr.slice(3).split('|')[0];
      setActiveTicket(tickets.find((tk) => tk.id === tid) ?? null);
      setActiveWO(null);
      return;
    }
    const woId = idStr.split('|')[0];
    setActiveWO(allWOs.find((w) => w.id === woId) ?? null);
    setActiveTicket(null);
  }, [allWOs, tickets]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    setActiveWO(null);
    setActiveTicket(null);
    const { active, over } = event;
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);

    // Reorder technician tiles (drag-to-reorder grid) — kept separate from cards
    if (activeId.startsWith('panel:')) {
      if (!overId.startsWith('panel:') || activeId === overId) return;
      const a = activeId.slice(6), o = overId.slice(6);
      setOrder((prev) => {
        const from = prev.indexOf(a), to = prev.indexOf(o);
        if (from < 0 || to < 0 || from === to) return prev;
        const next = arrayMove(prev, from, to);
        try { localStorage.setItem('labor_order_v1', JSON.stringify(next)); } catch { /* ignore */ }
        return next;
      });
      return;
    }

    // `over` can be a container droppable id, or a sortable card id (`x|colId`)
    const containerOf = (id: string): string => {
      if (id === 'unassigned' || techIdSet.has(id)) return id;
      const parts = id.split('|');
      return parts[parts.length - 1];
    };
    const sourceCol = containerOf(activeId);
    const targetCol = containerOf(overId);

    // Ticket dropped on a technician → auto-create a work order assigned to them
    if (activeId.startsWith('tk:')) {
      if (!techIdSet.has(targetCol)) return;                    // only a real tech column counts
      const ticketId = activeId.slice(3).split('|')[0];
      setTickets((prev) => prev.filter((tk) => tk.id !== ticketId));   // optimistic remove
      try {
        await assignTicket(ticketId, targetCol);
      } finally {
        await reload();
      }
      return;
    }

    const woId = activeId.split('|')[0];
    const wo = allWOs.find((w) => w.id === woId);
    if (!wo) return;

    // Reorder priority WITHIN the same technician column (not-started WOs only)
    if (sourceCol === targetCol && techIdSet.has(targetCol)) {
      const openIds = allWOs
        .filter((w) => woTechIds(w).includes(targetCol) && w.status !== 'in_progress')
        .sort(woSort)
        .map((w) => w.id);
      const fromIdx = openIds.indexOf(woId);
      if (fromIdx === -1) return;
      let toIdx = openIds.length - 1;
      if (overId !== targetCol) {
        const oi = openIds.indexOf(overId.split('|')[0]);
        if (oi >= 0) toIdx = oi;
      }
      if (fromIdx === toIdx) return;
      const newOrder = arrayMove(openIds, fromIdx, toIdx);
      setAllWOs((prev) => prev.map((w) => {
        const idx = newOrder.indexOf(w.id);
        return idx >= 0 ? { ...w, board_order: idx } : w;
      }));
      try { await reorderWorkOrders(newOrder); } catch { await reload(); }
      return;
    }

    if (sourceCol === targetCol) return;   // reorder inside unassigned — nothing to persist

    // Cross-column reassign: drop the source tech, add the target tech, keep the others
    let ids = woTechIds(wo);
    if (techIdSet.has(sourceCol)) ids = ids.filter((id) => id !== sourceCol);
    if (techIdSet.has(targetCol) && !ids.includes(targetCol)) ids = [...ids, targetCol];

    const optimistic: WorkOrder = {
      ...wo,
      executor_id: ids[0],
      technicians: ids.map((id, i) => {
        const tk = techs.find((tech) => tech.id === id);
        return {
          technician_id: id,
          user_id: tk?.user_id,
          name: tk?.full_name ?? undefined,
          is_primary: i === 0,
        };
      }),
    };
    setAllWOs((prev) => prev.map((w) => (w.id === woId ? optimistic : w)));

    try {
      const updated = await assignWorkOrder(woId, ids);
      setAllWOs((prev) => prev.map((w) => (w.id === woId ? updated : w)));
      upsertWorkOrder(updated);
    } catch {
      await reload();
    }
  }, [allWOs, techs, techIdSet, upsertWorkOrder, reload]);

  return (
    <div className="px-4 py-5 flex flex-col space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">{t('schedule.title')}</h1>
        <p className="text-gray-500 text-sm mt-0.5">{t('schedule.subtitle')}</p>
      </div>

      {/* Stats + filters bar */}
      <div className="flex items-center gap-4 text-sm flex-wrap">
        <div className="flex items-center gap-1.5 text-gray-400">
          <AlertCircle size={14} className="text-amber-400" />
          <span>{unassignedCount} unassigned</span>
        </div>
        <div className="flex items-center gap-1.5 text-gray-400">
          <Ticket size={14} className="text-purple-400" />
          <span>{tickets.length} open tickets</span>
        </div>
        <div className="flex items-center gap-1.5 text-gray-400">
          <Clock size={14} className="text-blue-400" />
          <span>
            {allWOs.filter((w) => w.status === 'open').length} open ·{' '}
            {allWOs.filter((w) => w.status === 'in_progress').length} in progress
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-gray-400">
          <User size={14} className="text-green-400" />
          <span>{techs.length} technicians</span>
        </div>

        {/* Availability legend */}
        <div className="flex items-center gap-3 text-[11px] text-gray-500 border-l border-white/[0.08] pl-4">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-400" /> {t('schedule.free', 'Available')}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-400" /> {t('schedule.assigned', 'Assigned')}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" /> {t('schedule.busy', 'Busy')}
          </span>
        </div>

        {/* Technician self-assignment switch (supervisor control) */}
        {selfAssign !== null && (
          <button
            onClick={toggleSelfAssign}
            disabled={savingSelfAssign}
            title="When ON, technicians can claim unassigned tickets from My Work (for shifts without a supervisor). When OFF, only supervisors dispatch work."
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors disabled:opacity-60 ${
              selfAssign
                ? 'border-green-500/40 bg-green-500/10 text-green-300'
                : 'border-gray-600 bg-gray-800/60 text-gray-400'
            }`}
          >
            <span className={`w-8 h-4 rounded-full relative transition-colors ${selfAssign ? 'bg-green-500/70' : 'bg-gray-600'}`}>
              <span
                className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all"
                style={{ left: selfAssign ? '18px' : '2px' }}
              />
            </span>
            Auto-attribution {selfAssign ? 'ON' : 'OFF'}
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-600" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('schedule.searchTech', 'Search technician…')}
              className="w-48 pl-8 pr-3 py-1.5 bg-[#0d1421] border border-white/[0.06] rounded-lg text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
          </div>
          <select
            value={specialty}
            onChange={(e) => setSpecialty(e.target.value)}
            className="bg-[#0d1421] border border-white/[0.06] rounded-lg px-2.5 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
          >
            <option value="">{t('schedule.allSpecialties', 'All specialties')}</option>
            {specialties.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <button
            onClick={resetLayout}
            title={t('schedule.resetLayout', 'Réinitialiser la disposition (techniciens avec OS en haut)')}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-[#0d1421] border border-white/[0.06] rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:border-white/20 transition-colors"
          >
            <RotateCcw size={13} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
          {t('common.loading')}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-4" style={{ height: 'calc(100vh - 240px)', minHeight: 420 }}>
            {/* Unassigned — pinned left, always visible */}
            <div className="w-64 flex-shrink-0 h-full">
              <UnassignedColumn
                title={t('schedule.unassigned')}
                subtitle={t('schedule.dragToAssign')}
                items={assignments.get(null) ?? []}
                tickets={tickets}
                onCardClick={setSelectedWO}
                onTicketClick={(tk) => navigate(`/tickets/${tk.id}`)}
              />
            </div>

            <div className="w-px bg-white/[0.06] flex-shrink-0 self-stretch" />

            {/* Technician tiles — auto-arranging grid: drag the header to reorder
                (tiles reflow and never overlap), drag the corner to resize */}
            <div className="flex-1 min-w-0 overflow-auto pr-1">
              {displayTechs.length === 0 ? (
                <div className="flex items-center justify-center h-32 rounded-xl border border-dashed border-white/[0.06] text-gray-600 text-xs p-4 text-center">
                  {techs.length === 0
                    ? t('schedule.noTechnicians')
                    : t('schedule.noMatch', 'No technician matches the filter')}
                </div>
              ) : (
                <SortableContext items={displayTechs.map((tc) => `panel:${tc.id}`)} strategy={rectSortingStrategy}>
                  <div className="flex flex-wrap content-start items-start gap-3">
                    {displayTechs.map((tech) => (
                      <TechCell
                        key={tech.id}
                        tech={tech}
                        items={assignments.get(tech.id) ?? []}
                        status={techStatus(tech.id)}
                        size={sizeOf(tech.id)}
                        onResize={(sz) => liveSize(tech.id, sz)}
                        onResizeCommit={commitSizes}
                        onCardClick={setSelectedWO}
                      />
                    ))}
                  </div>
                </SortableContext>
              )}
            </div>
          </div>

          {/* Drag overlay */}
          <DragOverlay>
            {activeWO ? <WOCardOverlay wo={activeWO} />
              : activeTicket ? <TicketCardOverlay ticket={activeTicket} />
              : null}
          </DragOverlay>
        </DndContext>
      )}

      {/* Detail drawer — fixed to the viewport, no scrolling needed */}
      {selectedWO && (
        <WODetailDrawer
          wo={selectedWO}
          techs={techs}
          onClose={() => setSelectedWO(null)}
          onUpdate={(updated) => {
            setAllWOs((prev) => prev.map((w) => (w.id === updated.id ? updated : w)));
            setSelectedWO(updated);
            upsertWorkOrder(updated);
          }}
        />
      )}
    </div>
  );
}
