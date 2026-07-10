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
  KeyboardSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useDroppable } from '@dnd-kit/core';
import {
  SortableContext, useSortable, arrayMove, verticalListSortingStrategy,
  rectSortingStrategy, sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  GripVertical, User, Users, AlertCircle, AlertTriangle, Clock, Ticket, X, CalendarDays,
  ChevronRight, Search, Lock, RotateCcw, Eye, EyeOff,
} from 'lucide-react';
import { fetchAllWorkOrders, fetchTechniciansFull, assignWorkOrder, reorderWorkOrders } from '../../api/workOrders';
import { fetchAvailableTickets, assignTicket } from '../../api/maintenance';
import { fetchEscalationSettings, updateEscalationSettings } from '../../api/escalation';
import { fetchShiftTemplates } from '../../api/shifts';
import { useWorkOrderStore } from '../../store/workOrderStore';
import { usePermission } from '../../hooks/usePermission';
import AvailabilityBadge from '../../components/AvailabilityBadge';
import type { WorkOrder, TechnicianFull, MaintenanceTicket, ShiftTemplate } from '../../types';

// Above this many backlog items we stop rendering the whole list (keeps the DOM
// — and dnd-kit's sortable registry — bounded). The list is triage-ordered so
// the most urgent items are always the ones kept; a footer points at the filter.
const BACKLOG_RENDER_CAP = 200;

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

// Segments of the per-technician priority-mix strip (workload at a glance).
const PRIORITY_BAR: Record<string, string> = {
  critical: 'bg-red-500/80',
  high: 'bg-orange-500/80',
  medium: 'bg-amber-500/70',
  low: 'bg-green-500/60',
};

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

// Whole cards are draggable; a click still opens the drawer. After a real drag
// the browser fires a click on release — swallow it with this timestamp.
let lastDragEndAt = 0;
const clickIsDragEcho = () => Date.now() - lastDragEndAt < 250;

const DAY_MS = 86_400_000;

/** Whole days since an ISO timestamp (null when missing/future). */
function ageDays(iso?: string | null): number | null {
  if (!iso) return null;
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS);
  return Number.isFinite(d) && d >= 0 ? d : null;
}

/** Whole days a WO is past its due date (null when not overdue / no due date). */
function overdueDays(due?: string | null): number | null {
  if (!due) return null;
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.floor((today.getTime() - d.getTime()) / DAY_MS);
  return diff > 0 ? diff : null;
}

/** Compact hours: 7.25 → "7.3", 8 → "8". */
const fmtH = (h: number) => (Math.round(h * 10) / 10).toString().replace(/\.0$/, '');

/** "HH:MM" → minutes since midnight (null if malformed). */
function hhmmToMin(v?: string | null): number | null {
  if (!v) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(v);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59 ? h * 60 + mi : null;
}

/** Net working hours of a shift = span (overnight-aware) minus every break.
 * This is the capacity a technician can actually wrench in one shift. */
function netShiftHours(tpl: ShiftTemplate): number {
  const start = hhmmToMin(tpl.start_time);
  const end = hhmmToMin(tpl.end_time);
  if (start == null || end == null) return 0;
  let dur = end - start;
  if (dur <= 0) dur += 1440;               // overnight (e.g. 22:00 → 06:00)
  let breaks = 0;
  for (const b of tpl.breaks ?? []) {
    const bs = hhmmToMin(b.start_time), be = hhmmToMin(b.end_time);
    if (bs == null || be == null) continue;
    let d = be - bs;
    if (d < 0) d += 1440;
    breaks += d;
  }
  return Math.max(0, dur - breaks) / 60;
}

/** Ids of work orders whose scheduled window overlaps another on the SAME day
 * (for the same technician — the caller passes one technician's items). Missing
 * end time ⇒ 1 h default; missing start on a dated WO ⇒ treated as full-day. */
function scheduleConflicts(items: WorkOrder[]): Set<string> {
  const byDate = new Map<string, { id: string; start: number; end: number }[]>();
  for (const w of items) {
    if (!w.scheduled_date) continue;
    const start = hhmmToMin(w.scheduled_start_time);
    const s = start ?? 0;
    const e = hhmmToMin(w.scheduled_end_time) ?? (start != null ? start + 60 : 1440);
    (byDate.get(w.scheduled_date) ?? byDate.set(w.scheduled_date, []).get(w.scheduled_date)!)
      .push({ id: w.id, start: s, end: Math.max(e, s + 1) });
  }
  const out = new Set<string>();
  byDate.forEach((arr) => {
    arr.sort((a, b) => a.start - b.start);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        if (arr[j].start >= arr[i].end) break;   // sorted by start → no later overlap
        out.add(arr[i].id);
        out.add(arr[j].id);
      }
    }
  });
  return out;
}

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

/** Backlog triage order: most urgent priority first, then oldest first. */
function backlogSort(a: { priority: string; opened_at?: string }, b: { priority: string; opened_at?: string }): number {
  const p = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
  if (p !== 0) return p;
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

const CLAMP_2: React.CSSProperties = {
  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
};

const WO_CARD_CLS = (wo: WorkOrder, extra = '') =>
  `bg-[#0b1120] border border-white/[0.06] border-l-2 ${PRIORITY_COLORS[wo.priority] ?? 'border-l-gray-700'} rounded-lg p-2.5 select-none ${extra}`;

/** Shared bottom chip row: age, overdue, estimated hours, scheduled date. */
function CardMetaChips({ openedAt, dueDate, estimatedHours, scheduledDate, scheduledTime }: {
  openedAt?: string | null;
  dueDate?: string | null;
  estimatedHours?: number | null;
  scheduledDate?: string | null;
  scheduledTime?: string | null;
}) {
  const { t } = useTranslation();
  const age = ageDays(openedAt);
  const late = overdueDays(dueDate);
  if (late == null && !(age && age > 0) && !estimatedHours && !scheduledDate) return null;
  return (
    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
      {late != null ? (
        <span className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/25 rounded px-1 py-px font-semibold">
          {t('schedule.overdueShort')} {late}{t('schedule.dayShort')}
        </span>
      ) : age != null && age > 0 ? (
        <span className="text-[10px] text-gray-500 font-mono" title={t('schedule.ageTooltip')}>
          {age}{t('schedule.dayShort')}
        </span>
      ) : null}
      {estimatedHours ? (
        <span className="text-[10px] text-gray-500 font-mono flex items-center gap-0.5">
          <Clock size={9} />
          ~{fmtH(estimatedHours)}h
        </span>
      ) : null}
      {scheduledDate && (
        <span className="flex items-center gap-1 text-[10px] text-green-500">
          <CalendarDays size={9} />
          {scheduledDate}
          {scheduledTime && <span className="text-gray-600">{scheduledTime}</span>}
        </span>
      )}
    </div>
  );
}

function WOCardInner({ wo, onClick, conflict }: { wo: WorkOrder; onClick?: (wo: WorkOrder) => void; conflict?: boolean }) {
  const { t } = useTranslation();
  const techCount = woTechIds(wo).length;
  return (
    <div
      className="flex-1 min-w-0"
      onClick={() => { if (clickIsDragEcho()) return; onClick?.(wo); }}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      <div className="flex items-center gap-1.5 mb-1 flex-wrap">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PRIORITY_DOT[wo.priority] ?? 'bg-gray-500'}`} />
        <span className="text-[10px] text-gray-600 font-mono">{wo.wo_number}</span>
        {conflict && (
          <span
            title={t('schedule.conflictTooltip')}
            className="flex items-center gap-0.5 text-[10px] text-red-400 bg-red-500/10 border border-red-500/30 px-1 py-0.5 rounded font-semibold uppercase"
          >
            <AlertTriangle size={9} />
            {t('schedule.conflict')}
          </span>
        )}
        {wo.status === 'in_progress' && (
          <span className="flex items-center gap-1 text-[10px] text-blue-400 bg-blue-500/10 border border-blue-500/25 px-1.5 py-0.5 rounded font-semibold uppercase">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            {t('status.in_progress')}
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
      <p className="text-xs text-gray-300 font-medium leading-snug" style={CLAMP_2} title={wo.title}>{wo.title}</p>
      {wo.equipment_name && (
        <p className="text-[10px] text-gray-600 mt-0.5 truncate" title={wo.equipment_name}>{wo.equipment_name}</p>
      )}
      <CardMetaChips
        openedAt={wo.opened_at}
        dueDate={wo.due_date}
        estimatedHours={wo.estimated_hours}
        scheduledDate={wo.scheduled_date}
        scheduledTime={wo.scheduled_start_time}
      />
    </div>
  );
}

/** Sortable WO card (open / not-started). The WHOLE card is draggable (grip kept
 * as affordance); a plain click (<5px movement) still opens the detail drawer. */
function SortableWOCard({ wo, colId, onClick, canEdit, conflict }: {
  wo: WorkOrder; colId: string; onClick?: (wo: WorkOrder) => void; canEdit: boolean; conflict?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `${wo.id}|${colId}`,
    data: { type: 'wo', wo, colId },
    disabled: !canEdit,
  });
  const style = { transform: CSS.Translate.toString(transform), transition, touchAction: 'none' as const };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...(canEdit ? listeners : {})}
      className={WO_CARD_CLS(wo, `${isDragging ? 'opacity-40' : ''} ${conflict ? '!border-red-500/40' : ''} ${canEdit ? 'cursor-grab active:cursor-grabbing hover:border-white/[0.14]' : ''}`)}
    >
      <div className="flex items-start gap-2">
        {canEdit && (
          <div className="mt-0.5 text-gray-600 flex-shrink-0">
            <GripVertical size={14} />
          </div>
        )}
        <WOCardInner wo={wo} onClick={onClick} conflict={conflict} />
      </div>
    </div>
  );
}

/** In-progress WO — pinned at the top (priority 1), not draggable. */
function LockedWOCard({ wo, onClick, conflict }: { wo: WorkOrder; onClick?: (wo: WorkOrder) => void; conflict?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={WO_CARD_CLS(wo, conflict ? '!border-red-500/40' : '')} title={t('schedule.lockedTooltip')}>
      <div className="flex items-start gap-2">
        <div className="mt-0.5 text-blue-500/60 flex-shrink-0"><Lock size={13} /></div>
        <WOCardInner wo={wo} onClick={onClick} conflict={conflict} />
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
  `bg-[#0b1120] border border-purple-500/20 border-l-2 ${PRIORITY_COLORS[ticket.priority] ?? 'border-l-gray-700'} rounded-lg p-2.5 select-none ${extra}`;

function TicketCardInner({ ticket, onClick }: { ticket: MaintenanceTicket; onClick?: (t: MaintenanceTicket) => void }) {
  return (
    <div
      className="flex-1 min-w-0"
      onClick={() => { if (clickIsDragEcho()) return; onClick?.(ticket); }}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PRIORITY_DOT[ticket.priority] ?? 'bg-gray-500'}`} />
        <span className="flex items-center gap-0.5 text-[10px] text-purple-400 bg-purple-500/10 border border-purple-500/20 px-1 py-0.5 rounded font-mono">
          <Ticket size={9} /> {ticket.ticket_number}
        </span>
      </div>
      <p className="text-xs text-gray-300 font-medium leading-snug" style={CLAMP_2}>
        {ticket.machine_name ?? '—'}{ticket.problem_type ? ` · ${ticket.problem_type}` : ''}
      </p>
      {ticket.description && (
        <p className="text-[10px] text-gray-600 mt-0.5 truncate" title={ticket.description}>{ticket.description}</p>
      )}
      <CardMetaChips openedAt={ticket.opened_at} />
    </div>
  );
}

/** Draggable open ticket (no work order yet) — dropping it on a technician
 * auto-creates a work order assigned to them. */
function SortableTicketCard({ ticket, onClick, canEdit }: {
  ticket: MaintenanceTicket; onClick?: (t: MaintenanceTicket) => void; canEdit: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `tk:${ticket.id}|unassigned`,
    data: { type: 'ticket', ticket },
    disabled: !canEdit,
  });
  const style = { transform: CSS.Translate.toString(transform), transition, touchAction: 'none' as const };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...(canEdit ? listeners : {})}
      className={TK_CARD_CLS(ticket, `${isDragging ? 'opacity-40' : ''} ${canEdit ? 'cursor-grab active:cursor-grabbing hover:border-purple-500/40' : ''}`)}
    >
      <div className="flex items-start gap-2">
        {canEdit && (
          <div className="mt-0.5 text-gray-600 flex-shrink-0">
            <GripVertical size={14} />
          </div>
        )}
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

/** Left column: the dispatch backlog — open tickets (drag → creates a WO) and
 * unassigned WOs, in triage order (priority, then oldest), with its own filter. */
function UnassignedColumn({
  items,
  tickets,
  query,
  onQuery,
  onCardClick,
  onTicketClick,
  title,
  canEdit,
}: {
  items: WorkOrder[];
  tickets: MaintenanceTicket[];
  query: string;
  onQuery: (q: string) => void;
  onCardClick?: (wo: WorkOrder) => void;
  onTicketClick?: (t: MaintenanceTicket) => void;
  title: string;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: 'unassigned' });
  const total = items.length + tickets.length;
  const filtering = query.trim().length > 0;
  // Keep the rendered list (and dnd-kit's registry) bounded on huge backlogs.
  // Tickets are few (API caps at 50) so they always render; WOs are the tail we
  // trim — the list is triage-ordered, so we keep the most urgent ones.
  const woBudget = Math.max(0, BACKLOG_RENDER_CAP - tickets.length);
  const shownItems = total > BACKLOG_RENDER_CAP ? items.slice(0, woBudget) : items;
  const hiddenCount = items.length - shownItems.length;

  return (
    <div
      ref={setNodeRef}
      className={`h-full w-full flex flex-col rounded-xl border transition-colors ${
        isOver ? 'border-blue-500/50 bg-blue-500/5' : 'border-white/[0.06] bg-[#0d1421]'
      }`}
    >
      <div className="p-3 border-b border-white/[0.06] flex-shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-amber-500/20 flex items-center justify-center flex-shrink-0">
            <AlertCircle size={12} className="text-amber-400" />
          </div>
          <p className="text-xs font-semibold text-gray-300 truncate min-w-0">{title}</p>
          <span className={`ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full ${
            total > 0 ? 'bg-amber-500/15 text-amber-400' : 'bg-white/[0.04] text-gray-600'
          }`}>
            {total}
          </span>
        </div>
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-600" />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={t('schedule.searchUnassigned')}
            className="w-full pl-7 pr-2 py-1 bg-[#0b1120] border border-white/[0.06] rounded-lg text-[11px] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>
      <div className="flex-1 p-2 space-y-2 overflow-y-auto">
        <SortableContext
          items={[...tickets.map((tk) => `tk:${tk.id}|unassigned`), ...shownItems.map((wo) => `${wo.id}|unassigned`)]}
          strategy={verticalListSortingStrategy}
        >
          {tickets.length > 0 && (
            <p className="text-[10px] text-purple-400/80 font-semibold uppercase tracking-wide px-1 pt-1">
              {t('schedule.sectionTickets')} · {tickets.length}
            </p>
          )}
          {tickets.map((tk) => (
            <SortableTicketCard key={`tk:${tk.id}`} ticket={tk} onClick={onTicketClick} canEdit={canEdit} />
          ))}
          {items.length > 0 && tickets.length > 0 && (
            <p className="text-[10px] text-gray-500 font-semibold uppercase tracking-wide px-1 pt-1.5">
              {t('schedule.sectionWorkOrders')} · {items.length}
            </p>
          )}
          {shownItems.map((wo) => (
            <SortableWOCard key={`${wo.id}|unassigned`} wo={wo} colId="unassigned" onClick={onCardClick} canEdit={canEdit} />
          ))}
        </SortableContext>
        {hiddenCount > 0 && (
          <div className="flex items-center justify-center gap-1.5 py-2 text-[10px] text-gray-500 border border-dashed border-white/[0.08] rounded-lg">
            <Search size={11} />
            {t('schedule.backlogMore', { count: hiddenCount })}
          </div>
        )}
        {total === 0 && (
          <div className="flex items-center justify-center h-20 border border-dashed border-white/[0.06] rounded-lg">
            <p className="text-[10px] text-gray-700">
              {filtering ? t('schedule.noBacklogMatch') : t('schedule.dropHere')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

type TechStatus = 'busy' | 'assigned' | 'free';

const TECH_STATUS_STYLE: Record<TechStatus, { bg: string; icon: string; pulse: boolean }> = {
  busy:     { bg: 'bg-red-500/20 ring-2 ring-red-500/50',     icon: 'text-red-400',   pulse: true  },
  assigned: { bg: 'bg-amber-500/20 ring-2 ring-amber-500/40', icon: 'text-amber-400', pulse: false },
  free:     { bg: 'bg-green-500/20 ring-2 ring-green-500/40', icon: 'text-green-400', pulse: false },
};

const TECH_STATUS_LABEL_KEY: Record<TechStatus, string> = {
  busy: 'schedule.techStatusBusy',
  assigned: 'schedule.techStatusAssigned',
  free: 'schedule.free',
};

/** One technician tile — a sortable grid cell: drag the header to reorder it
 * (tiles reflow and never overlap), drag the bottom-right corner to resize it.
 * The header shows real availability (only when NOT plainly available) plus a
 * workload strip: priority mix bar + total estimated hours. Body scrolls. */
function TechCell({
  tech,
  items,
  status,
  size,
  capacity,
  onResize,
  onResizeCommit,
  onCardClick,
  canEdit,
}: {
  tech: TechnicianFull;
  items: WorkOrder[];
  status: TechStatus;
  size: TileSize;
  capacity: number | null;   // net working hours of one shift, or null if unknown
  onResize: (s: TileSize) => void;
  onResizeCommit: () => void;
  onCardClick?: (wo: WorkOrder) => void;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: tech.id });
  const {
    setNodeRef: setSortRef, attributes, listeners, transform, transition, isDragging,
  } = useSortable({ id: `panel:${tech.id}`, data: { type: 'panel', techId: tech.id }, disabled: !canEdit });
  const setRefs = (el: HTMLElement | null) => { setDropRef(el); setSortRef(el); };
  const s = TECH_STATUS_STYLE[status];
  const [resizing, setResizing] = useState(false);
  const inProgress = items.filter((w) => w.status === 'in_progress');
  const openItems = items.filter((w) => w.status !== 'in_progress');
  const estHours = items.reduce((sum, w) => sum + (w.estimated_hours ?? 0), 0);
  const conflictIds = useMemo(() => scheduleConflicts(items), [items]);
  // Load vs one shift's capacity. util > 1 = over-committed for a shift.
  const util = capacity && capacity > 0 ? estHours / capacity : null;
  const capColor = util == null ? '' : util > 1 ? 'text-red-400' : util >= 0.85 ? 'text-amber-400' : 'text-gray-400';
  const barColor = util == null ? '' : util > 1 ? 'bg-red-500/80' : util >= 0.85 ? 'bg-amber-500/80' : 'bg-blue-500/70';
  // Real availability from the shift/vacation service — surfaced only as an
  // exception (vacation, off shift, lunch…): green-by-default keeps tiles calm.
  const avail = tech.availability;
  const showAvail = !!avail && avail.status !== 'available';

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
      className={`relative flex flex-col flex-shrink-0 rounded-xl border ${
        isDragging || resizing
          ? 'border-blue-500/60 ring-1 ring-blue-500/30 shadow-2xl shadow-black/50'
          : isOver ? 'border-blue-500/50 bg-blue-500/5' : 'border-white/[0.06] bg-[#0d1421]'
      }`}
    >
      <div
        {...attributes}
        {...(canEdit ? listeners : {})}
        style={{ touchAction: 'none' }}
        className={`p-2.5 border-b border-white/[0.06] select-none flex-shrink-0 ${canEdit ? 'cursor-move' : ''}`}
      >
        <div className="flex items-center gap-2">
          {canEdit && <GripVertical size={13} className="text-gray-600 flex-shrink-0" />}
          <div
            title={t(TECH_STATUS_LABEL_KEY[status])}
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
          {conflictIds.size > 0 && (
            <span
              title={t('schedule.conflictTileTooltip', { count: conflictIds.size })}
              className="flex items-center gap-0.5 text-[10px] font-mono px-1.5 py-0.5 rounded-full flex-shrink-0 bg-red-500/15 text-red-400 border border-red-500/25"
            >
              <AlertTriangle size={9} />
              {conflictIds.size}
            </span>
          )}
          <span
            title={`${inProgress.length} ${t('status.in_progress')} · ${openItems.length} ${t('status.open')}`}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full flex-shrink-0 ${
              items.length > 0 ? 'bg-blue-500/15 text-blue-400' : 'bg-white/[0.04] text-gray-600'
            }`}
          >
            {items.length}
          </span>
        </div>
        {(showAvail || items.length > 0) && (
          <div className="flex items-center gap-2 mt-1.5">
            {showAvail && <AvailabilityBadge availability={avail} size={11} />}
            {items.length > 0 && util != null && estHours > 0 ? (
              // Capacity: load (Σ estimated) vs one shift's net working hours.
              <div className="flex-1 flex items-center gap-2 min-w-0">
                <div
                  className="flex-1 h-[4px] rounded-full overflow-hidden bg-white/[0.06] relative"
                  title={t('schedule.capacityTooltip', { load: fmtH(estHours), cap: fmtH(capacity!) })}
                >
                  <div className={`absolute inset-y-0 left-0 ${barColor}`} style={{ width: `${Math.min(util, 1) * 100}%` }} />
                </div>
                <span className={`text-[10px] font-mono flex-shrink-0 ${capColor}`} title={t('schedule.capacityTooltip', { load: fmtH(estHours), cap: fmtH(capacity!) })}>
                  {fmtH(estHours)}/{fmtH(capacity!)}h
                </span>
              </div>
            ) : items.length > 0 ? (
              // No capacity/estimates known → priority-mix bar (composition at a glance).
              <div className="flex-1 flex items-center gap-2 min-w-0">
                <div className="flex-1 h-[3px] rounded-full overflow-hidden flex bg-white/[0.04]">
                  {(['critical', 'high', 'medium', 'low'] as const).map((p) => {
                    const n = items.filter((w) => w.priority === p).length;
                    return n > 0
                      ? <div key={p} className={PRIORITY_BAR[p]} style={{ width: `${(n / items.length) * 100}%` }} />
                      : null;
                  })}
                </div>
                {estHours > 0 && (
                  <span className="text-[10px] text-gray-500 font-mono flex-shrink-0" title={t('form.estimatedHoursLabel')}>
                    Σ {fmtH(estHours)}h
                  </span>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>
      <div className="flex-1 p-2 space-y-2 overflow-y-auto">
        {inProgress.map((wo) => (
          <LockedWOCard key={`${wo.id}|${tech.id}`} wo={wo} onClick={onCardClick} conflict={conflictIds.has(wo.id)} />
        ))}
        <SortableContext items={openItems.map((wo) => `${wo.id}|${tech.id}`)} strategy={verticalListSortingStrategy}>
          {openItems.map((wo) => (
            <SortableWOCard key={`${wo.id}|${tech.id}`} wo={wo} colId={tech.id} onClick={onCardClick} canEdit={canEdit} conflict={conflictIds.has(wo.id)} />
          ))}
        </SortableContext>
        {items.length === 0 && (
          <div className="flex items-center justify-center h-12 border border-dashed border-white/[0.06] rounded-lg">
            <p className="text-[10px] text-gray-700">{t('schedule.dropHere')}</p>
          </div>
        )}
      </div>
      {/* Resize handle (bottom-right corner) */}
      {canEdit && (
        <div
          onPointerDown={startResize}
          title={t('schedule.resize')}
          style={{ touchAction: 'none' }}
          className="absolute bottom-0 right-0 w-5 h-5 cursor-se-resize flex items-end justify-end p-0.5 text-gray-600 hover:text-blue-400"
        >
          <svg viewBox="0 0 10 10" width="9" height="9" className="fill-current">
            <path d="M10 0v10H0z" opacity="0.6" />
          </svg>
        </div>
      )}
    </div>
  );
}

/** Fixed right-side drawer — visible immediately on click, anywhere on the page. */
function WODetailDrawer({
  wo,
  techs,
  onClose,
  onUpdate,
  canEdit,
}: {
  wo: WorkOrder;
  techs: TechnicianFull[];
  onClose: () => void;
  onUpdate: (updated: WorkOrder) => void;
  canEdit: boolean;
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
  const late = overdueDays(wo.due_date);

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
        <p className="text-xs font-semibold text-gray-200">{t('schedule.woDetails')}</p>
        <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors p-0.5">
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 p-4 space-y-3 overflow-y-auto">
        <div>
          <p className="text-[10px] text-gray-600 uppercase tracking-wide mb-0.5">{t('workOrders.woNumber')}</p>
          <p className="text-sm font-mono text-gray-200">{wo.wo_number}</p>
        </div>
        <div>
          <p className="text-[10px] text-gray-600 uppercase tracking-wide mb-0.5">{t('workOrders.titleField')}</p>
          <p className="text-xs text-gray-300 leading-snug">{wo.title}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-mono border rounded ${PRIORITY_BADGE[wo.priority] ?? ''}`}>
            {t(`priority.${wo.priority}`, wo.priority)}
          </span>
          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-mono border rounded bg-white/[0.04] text-gray-400 border-white/[0.08]">
            {t(`status.${wo.status}`, wo.status)}
          </span>
        </div>
        {wo.equipment_name && (
          <div>
            <p className="text-[10px] text-gray-600 uppercase tracking-wide mb-0.5">{t('workOrders.equipment')}</p>
            <p className="text-xs text-gray-400">{wo.equipment_name}</p>
          </div>
        )}
        {(wo.estimated_hours || wo.due_date) && (
          <div className="flex gap-4">
            {wo.estimated_hours ? (
              <div>
                <p className="text-[10px] text-gray-600 uppercase tracking-wide mb-0.5">{t('form.estimatedHoursLabel')}</p>
                <p className="text-xs text-gray-300 font-mono">{fmtH(wo.estimated_hours)} h</p>
              </div>
            ) : null}
            {wo.due_date && (
              <div>
                <p className="text-[10px] text-gray-600 uppercase tracking-wide mb-0.5">{t('form.dueDateLabel')}</p>
                <p className={`text-xs font-mono ${late != null ? 'text-red-400' : 'text-gray-300'}`}>
                  {new Date(wo.due_date).toLocaleDateString()}
                  {late != null && ` · ${t('schedule.overdueShort')} ${late}${t('schedule.dayShort')}`}
                </p>
              </div>
            )}
          </div>
        )}
        {wo.ticket_id && (
          <div className="bg-purple-500/5 border border-purple-500/20 rounded-lg p-3 space-y-1.5">
            <div className="flex items-center gap-1.5 mb-1">
              <Ticket size={12} className="text-purple-400" />
              <p className="text-[10px] text-purple-400 font-semibold uppercase tracking-wide">{t('workOrders.linkedTicket')}</p>
            </div>
            <p className="text-xs font-mono text-gray-300">{wo.ticket_number ?? wo.ticket_id}</p>
            <button
              onClick={() => navigate(`/tickets/${wo.ticket_id}`)}
              className="flex items-center gap-1 text-[11px] text-purple-400 hover:text-purple-300 transition-colors"
            >
              <ChevronRight size={12} /> {t('schedule.viewTicket')}
            </button>
          </div>
        )}
        {/* Assigned technicians — add/remove without leaving the page */}
        <div>
          <p className="text-[10px] text-gray-600 uppercase tracking-wide mb-1">{t('workOrders.assignedTechnicians')}</p>
          {assignedIds.length === 0 && (
            <p className="text-[11px] text-gray-600 italic mb-1.5">
              {t('schedule.noneAssigned', 'No technician assigned yet')}
            </p>
          )}
          <div className="flex flex-wrap gap-1 mb-2">
            {(assigned.length > 0
              ? assigned.map((tech) => ({ id: tech.technician_id, name: techName(tech.technician_id, tech.name) }))
              : assignedIds.map((id) => ({ id, name: techName(id, wo.executor_name) }))
            ).map(({ id, name }) => (
              <span
                key={id}
                className="inline-flex items-center gap-1 bg-blue-500/10 border border-blue-500/25 text-blue-300 rounded-full pl-2 pr-1 py-0.5 text-[10px]"
              >
                <User size={9} className="text-blue-400/70" />
                {name}
                {canEdit && (
                  <button
                    onClick={() => removeTech(id)}
                    disabled={saving}
                    title={t('schedule.removeTech', 'Remove technician')}
                    className="p-0.5 rounded-full text-blue-400/60 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                  >
                    <X size={10} />
                  </button>
                )}
              </span>
            ))}
          </div>
          {canEdit && available.length > 0 && (
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
              <p className="text-[10px] text-green-400 font-semibold uppercase tracking-wide">{t('schedule.scheduleLabel')}</p>
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
          <ChevronRight size={13} /> {t('schedule.openFullWO')}
        </button>
      </div>
    </div>
  );
}

type SortMode = 'custom' | 'workload' | 'name' | 'availability';
const SORT_MODES: SortMode[] = ['custom', 'workload', 'name', 'availability'];
const SORT_LABEL_KEY: Record<SortMode, string> = {
  custom: 'schedule.sortCustom',
  workload: 'schedule.sortWorkload',
  name: 'schedule.sortName',
  availability: 'schedule.sortAvailability',
};

// Availability exceptions sink to the bottom in "by availability" ordering.
const AVAIL_RANK: Record<string, number> = {
  available: 0, on_break: 1, at_lunch: 1, off_shift: 2,
  on_vacation: 3, unavailable: 3, inactive: 4,
};

export default function LaborScheduler() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canEdit = usePermission('schedule', 'update');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
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
  const [shiftTemplates, setShiftTemplates] = useState<ShiftTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeWO, setActiveWO] = useState<WorkOrder | null>(null);
  const [activeTicket, setActiveTicket] = useState<MaintenanceTicket | null>(null);
  const [selectedWO, setSelectedWO] = useState<WorkOrder | null>(null);
  const [search, setSearch] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [backlogQuery, setBacklogQuery] = useState('');
  const [selfAssign, setSelfAssign] = useState<boolean | null>(null);
  const [savingSelfAssign, setSavingSelfAssign] = useState(false);
  // Per-user dashboard layout, persisted: tile order (drag-to-reorder) + per-tile
  // size + explicit sort mode (custom keeps the manual order).
  const [order, setOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('labor_order_v1') || '[]'); } catch { return []; }
  });
  const [sizes, setSizes] = useState<Record<string, TileSize>>(() => {
    try { return JSON.parse(localStorage.getItem('labor_sizes_v1') || '{}'); } catch { return {}; }
  });
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    const s = localStorage.getItem('labor_sort_v1') as SortMode | null;
    return s && SORT_MODES.includes(s) ? s : 'custom';
  });
  // View filter: hide technicians currently outside their shift window.
  const [hideOffShift, setHideOffShift] = useState<boolean>(
    () => localStorage.getItem('labor_hide_offshift_v1') === '1',
  );

  const changeSortMode = useCallback((m: SortMode) => {
    setSortMode(m);
    try { localStorage.setItem('labor_sort_v1', m); } catch { /* ignore */ }
  }, []);

  const toggleHideOffShift = useCallback(() => {
    setHideOffShift((prev) => {
      const next = !prev;
      try { localStorage.setItem('labor_hide_offshift_v1', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  useEffect(() => {
    fetchEscalationSettings()
      .then((r) => setSelfAssign(r.settings.technician_self_assign))
      .catch(() => setSelfAssign(null));
    fetchShiftTemplates()
      .then(setShiftTemplates)
      .catch(() => setShiftTemplates([]));
  }, []);

  // Net working hours per shift key (plant-scoped template wins over global),
  // used as each technician's per-shift capacity.
  const capacityByKey = useMemo(() => {
    const chosen = new Map<string, ShiftTemplate>();
    shiftTemplates.filter((tp) => tp.active).forEach((tp) => {
      const prev = chosen.get(tp.key);
      // prefer a plant-scoped template (plant_id set) over a global one
      if (!prev || (prev.plant_id == null && tp.plant_id != null)) chosen.set(tp.key, tp);
    });
    const out = new Map<string, number>();
    chosen.forEach((tp, key) => out.set(key, netShiftHours(tp)));
    return out;
  }, [shiftTemplates]);

  const capacityOf = useCallback(
    (shiftKey?: string | null): number | null => {
      if (!shiftKey) return null;
      const h = capacityByKey.get(shiftKey);
      return h && h > 0 ? h : null;
    },
    [capacityByKey],
  );

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

  // Backlog (left column) in triage order, with its own text filter.
  const backlogWOs = useMemo(() => {
    const list = assignments.get(null) ?? [];
    const q = backlogQuery.trim().toLowerCase();
    const filtered = q
      ? list.filter((w) => [w.wo_number, w.title, w.equipment_name].some((s) => s?.toLowerCase().includes(q)))
      : list;
    return [...filtered].sort(backlogSort);
  }, [assignments, backlogQuery]);

  const backlogTickets = useMemo(() => {
    const q = backlogQuery.trim().toLowerCase();
    const filtered = q
      ? tickets.filter((tk) =>
          [tk.ticket_number, tk.machine_name, tk.description, tk.problem_type]
            .some((s) => s?.toLowerCase().includes(q)))
      : tickets;
    return [...filtered].sort(backlogSort);
  }, [tickets, backlogQuery]);

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
    setSortMode('custom');
    try {
      localStorage.removeItem('labor_order_v1');
      localStorage.removeItem('labor_sizes_v1');
      localStorage.removeItem('labor_sort_v1');
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

  const offShiftCount = useMemo(
    () => techs.filter((tc) => tc.availability?.status === 'off_shift').length,
    [techs],
  );

  const filteredTechs = useMemo(
    () => orderedAllTechs.filter((tech) => {
      if (hideOffShift && tech.availability?.status === 'off_shift') return false;
      if (specialty && tech.specialty !== specialty) return false;
      if (search) {
        const name = `${tech.full_name ?? ''} ${tech.email ?? ''}`.toLowerCase();
        if (!name.includes(search.toLowerCase())) return false;
      }
      return true;
    }),
    [orderedAllTechs, search, specialty, hideOffShift],
  );

  // Visible tiles, laid out per the chosen sort ('custom' = drag-to-reorder order)
  const orderIndex = useMemo(() => {
    const m = new Map<string, number>();
    order.forEach((id, i) => m.set(id, i));
    return m;
  }, [order]);

  const hoursOf = useCallback(
    (techId: string) => (assignments.get(techId) ?? []).reduce((s, w) => s + (w.estimated_hours ?? 0), 0),
    [assignments],
  );

  const displayTechs = useMemo(() => {
    const arr = [...filteredTechs];
    const byName = (a: TechnicianFull, b: TechnicianFull) =>
      (a.full_name ?? '').localeCompare(b.full_name ?? '');
    if (sortMode === 'name') arr.sort(byName);
    else if (sortMode === 'workload') {
      arr.sort((a, b) => {
        const ca = assignments.get(a.id)?.length ?? 0, cb = assignments.get(b.id)?.length ?? 0;
        if (cb !== ca) return cb - ca;
        const ha = hoursOf(a.id), hb = hoursOf(b.id);
        if (hb !== ha) return hb - ha;
        return byName(a, b);
      });
    } else if (sortMode === 'availability') {
      arr.sort((a, b) => {
        const ra = AVAIL_RANK[a.availability?.status ?? 'available'] ?? 0;
        const rb = AVAIL_RANK[b.availability?.status ?? 'available'] ?? 0;
        if (ra !== rb) return ra - rb;
        return byName(a, b);
      });
    } else {
      arr.sort((a, b) => (orderIndex.get(a.id) ?? Infinity) - (orderIndex.get(b.id) ?? Infinity));
    }
    return arr;
  }, [filteredTechs, sortMode, orderIndex, assignments, hoursOf]);

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

  // Advisory guard-rail: dropping work on a technician the availability service
  // flags (vacation / off shift / inactive…) asks for confirmation — never blocks.
  const confirmIfUnavailable = useCallback((techId: string): boolean => {
    const tech = techs.find((tc) => tc.id === techId);
    const a = tech?.availability;
    if (!a?.should_warn) return true;
    const status = t(`availability.${a.status}`, a.status).toLowerCase();
    return window.confirm(t('schedule.confirmUnavailable', {
      name: tech?.full_name ?? tech?.email ?? '', status,
    }));
  }, [techs, t]);

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

  const handleDragCancel = useCallback(() => {
    lastDragEndAt = Date.now();
    setActiveWO(null);
    setActiveTicket(null);
  }, []);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    lastDragEndAt = Date.now();
    setActiveWO(null);
    setActiveTicket(null);
    const { active, over } = event;
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);

    // Reorder technician tiles (drag-to-reorder grid) — kept separate from cards.
    // Dragging while a computed sort is active adopts that arrangement as the
    // new custom order, then applies the move.
    if (activeId.startsWith('panel:')) {
      if (!overId.startsWith('panel:') || activeId === overId) return;
      const a = activeId.slice(6), o = overId.slice(6);
      const base = sortMode === 'custom' ? order : displayTechs.map((tc) => tc.id);
      const from = base.indexOf(a), to = base.indexOf(o);
      if (from < 0 || to < 0 || from === to) return;
      const next = arrayMove(base, from, to);
      setOrder(next);
      try { localStorage.setItem('labor_order_v1', JSON.stringify(next)); } catch { /* ignore */ }
      if (sortMode !== 'custom') changeSortMode('custom');
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
      if (!confirmIfUnavailable(targetCol)) return;
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
    if (techIdSet.has(targetCol) && !confirmIfUnavailable(targetCol)) return;
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
  }, [allWOs, techs, techIdSet, upsertWorkOrder, reload, sortMode, order, displayTechs, changeSortMode, confirmIfUnavailable]);

  const openCount = useMemo(() => allWOs.filter((w) => w.status === 'open').length, [allWOs]);
  const inProgressCount = useMemo(() => allWOs.filter((w) => w.status === 'in_progress').length, [allWOs]);

  return (
    <div className="px-4 py-4 flex flex-col space-y-3">
      {/* Header — title + live stats on one line, controls on the next */}
      <div className="flex items-baseline gap-x-4 gap-y-1 flex-wrap">
        <h1 className="text-xl font-bold text-white">{t('schedule.title')}</h1>
        <p className="text-gray-600 text-xs">{t('schedule.subtitle')}</p>
        <div className="flex items-center gap-3 text-xs flex-wrap ml-auto">
          <span className={`flex items-center gap-1.5 ${unassignedCount > 0 ? 'text-amber-400' : 'text-gray-500'}`}>
            <AlertCircle size={13} />
            {t('schedule.statsUnassigned', { count: unassignedCount })}
          </span>
          <span className="flex items-center gap-1.5 text-gray-400">
            <Ticket size={13} className="text-purple-400" />
            {t('schedule.statsOpenTickets', { count: tickets.length })}
          </span>
          <span className="flex items-center gap-1.5 text-gray-400">
            <Clock size={13} className="text-blue-400" />
            {t('schedule.statsOpen', { count: openCount })} · {t('schedule.statsInProgress', { count: inProgressCount })}
          </span>
          <span className="flex items-center gap-1.5 text-gray-400">
            <User size={13} className="text-green-400" />
            {t('schedule.statsTechnicians', { count: techs.length })}
          </span>
        </div>
      </div>

      {/* Controls bar */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Working-state legend (avatar ring); availability exceptions get their own labeled pill */}
        <div className="flex items-center gap-3 text-[11px] text-gray-500">
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
        {canEdit && selfAssign !== null && (
          <button
            onClick={toggleSelfAssign}
            disabled={savingSelfAssign}
            title={t('schedule.autoAssignTooltip')}
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
            {selfAssign ? t('schedule.autoAssignOn') : t('schedule.autoAssignOff')}
          </button>
        )}

        {!canEdit && (
          <span
            title={t('schedule.readOnlyHint')}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/[0.08] bg-white/[0.03] text-[11px] text-gray-400"
          >
            <Eye size={12} />
            {t('schedule.readOnly')}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <button
            onClick={toggleHideOffShift}
            title={t('schedule.offShiftTooltip')}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
              hideOffShift
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                : 'border-white/[0.06] bg-[#0d1421] text-gray-400 hover:text-gray-200 hover:border-white/20'
            }`}
          >
            {hideOffShift ? <EyeOff size={13} /> : <Eye size={13} />}
            {hideOffShift ? t('schedule.offShiftHidden') : t('schedule.hideOffShift')}
            {offShiftCount > 0 && <span className="text-[10px] font-mono opacity-70">{offShiftCount}</span>}
          </button>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-600" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('schedule.searchTech', 'Search technician…')}
              className="w-44 pl-8 pr-3 py-1.5 bg-[#0d1421] border border-white/[0.06] rounded-lg text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
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
          <select
            value={sortMode}
            onChange={(e) => changeSortMode(e.target.value as SortMode)}
            title={t('schedule.sortTooltip')}
            className="bg-[#0d1421] border border-white/[0.06] rounded-lg px-2.5 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
          >
            {SORT_MODES.map((m) => (
              <option key={m} value={m}>{t(SORT_LABEL_KEY[m])}</option>
            ))}
          </select>
          <button
            onClick={resetLayout}
            title={t('schedule.resetLayout', 'Reset layout (technicians with WOs first)')}
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
          onDragCancel={handleDragCancel}
        >
          <div className="flex gap-4" style={{ height: 'calc(100vh - 205px)', minHeight: 420 }}>
            {/* Unassigned backlog — pinned left, always visible */}
            <div className="w-72 flex-shrink-0 h-full">
              <UnassignedColumn
                title={t('schedule.unassigned')}
                items={backlogWOs}
                tickets={backlogTickets}
                query={backlogQuery}
                onQuery={setBacklogQuery}
                onCardClick={setSelectedWO}
                onTicketClick={(tk) => navigate(`/tickets/${tk.id}`)}
                canEdit={canEdit}
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
                        capacity={capacityOf(tech.shift)}
                        onResize={(sz) => liveSize(tech.id, sz)}
                        onResizeCommit={commitSizes}
                        onCardClick={setSelectedWO}
                        canEdit={canEdit}
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
          canEdit={canEdit}
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
