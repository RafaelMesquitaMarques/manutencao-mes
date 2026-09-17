import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Ticket, RefreshCw, Play, PauseCircle,
  XCircle, Package, ChevronRight, Plus, Trash2, Search, X, FilterX,
} from 'lucide-react';
import { fetchTickets, updateTicketStatus, deleteTicket } from '../../api/maintenance';
import type { MaintenanceTicket, AlertPriority, TicketStatus } from '../../types';
import Spinner from '../../components/ui/Spinner';
import TableColumnHeader from '../../components/ui/TableColumnHeader';
import type { ColumnOption, SortDir, SortState } from '../../components/ui/TableColumnHeader';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';
import { usePermission } from '../../hooks/usePermission';

const SLA_MINUTES: Record<AlertPriority, number> = {
  critical: 10, high: 30, medium: 120, low: 480,
};

const PRIORITY_BADGE: Record<AlertPriority, string> = {
  critical: 'bg-red-500/15 text-red-400 border-red-500/25',
  high:     'bg-orange-500/15 text-orange-400 border-orange-500/25',
  medium:   'bg-sky-500/15 text-sky-400 border-sky-500/25',
  low:      'bg-gray-500/15 text-gray-400 border-gray-500/25',
};

const STATUS_BADGE: Record<TicketStatus, string> = {
  open:          'bg-blue-500/15 text-blue-400 border-blue-500/25',
  in_progress:   'bg-amber-500/15 text-amber-400 border-amber-500/25',
  on_hold_parts: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
  on_hold_ext:   'bg-pink-500/15 text-pink-400 border-pink-500/25',
  completed:     'bg-green-500/15 text-green-400 border-green-500/25',
  cancelled:     'bg-gray-500/15 text-gray-400 border-gray-500/25',
};

const PRIORITY_ORDER: Record<AlertPriority, number> = { low: 1, medium: 2, high: 3, critical: 4 };
const STATUS_ORDER: Record<TicketStatus, number> = {
  open: 1, in_progress: 2, on_hold_parts: 3, on_hold_ext: 4, completed: 5, cancelled: 6,
};

const STATUS_TABS: TicketStatus[] = ['open', 'in_progress', 'on_hold_parts', 'on_hold_ext', 'completed'];

/** Sentinel filter value for tickets with no technician (cannot collide with a name). */
const UNASSIGNED = '__unassigned__';

type SortKey    = 'ticket' | 'machine' | 'priority' | 'status' | 'assignee' | 'age' | 'sla' | 'escalation';
type FilterKey  = 'machine' | 'priority' | 'status' | 'assignee' | 'sla' | 'escalation';
type SlaBucket  = 'overdue' | 'at_risk' | 'on_track' | 'na';

const EMPTY_FILTERS: Record<FilterKey, string[]> = {
  machine: [], priority: [], status: [], assignee: [], sla: [], escalation: [],
};

function elapsedMinutes(openedAt: string): number {
  return (Date.now() - new Date(openedAt).getTime()) / 60_000;
}

function timeOpen(openedAt: string): string {
  const mins = Math.floor(elapsedMinutes(openedAt));
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
}

/** Minutes left before the SLA is breached — null once the ticket is closed. */
function slaRemaining(t: MaintenanceTicket): number | null {
  if (t.status === 'completed' || t.status === 'cancelled') return null;
  return SLA_MINUTES[t.priority] - elapsedMinutes(t.opened_at);
}

function slaBucket(t: MaintenanceTicket): SlaBucket {
  const remain = slaRemaining(t);
  if (remain === null) return 'na';
  if (remain < 0) return 'overdue';
  return remain < SLA_MINUTES[t.priority] * 0.25 ? 'at_risk' : 'on_track';
}

/** Individual technician names — the API joins them into assigned_to_name. */
function techNames(t: MaintenanceTicket): string[] {
  const fromLinks = (t.assigned_technicians ?? [])
    .map((a) => a.name)
    .filter((n): n is string => !!n);
  if (fromLinks.length) return fromLinks;
  return (t.assigned_to_name ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export default function TicketList() {
  const { t }    = useTranslation();
  const navigate = useNavigate();
  const canCreate = usePermission('tickets', 'create');
  const canUpdate = usePermission('tickets', 'update');
  const canDelete = usePermission('tickets', 'delete');

  const [tickets, setTickets]   = useState<MaintenanceTicket[]>([]);
  const [total, setTotal]       = useState(0);
  const [loading, setLoading]   = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const [search, setSearch]   = useState('');
  const [filters, setFilters] = useState<Record<FilterKey, string[]>>(EMPTY_FILTERS);
  const [sort, setSort]       = useState<SortState>({ key: 'age', dir: 'asc' });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Filtering/sorting is client-side, so pull the whole (capped) list in one go.
  const load = useCallback(async () => {
    const { total: tot, items } = await fetchTickets({ limit: '500' });
    setTickets(items);
    setTotal(tot);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const { lastUpdatedAt, isRefreshing, hasError, manualRefresh } = useAutoRefresh(load);

  // Drop selected rows that disappeared (deleted elsewhere, plant switch, …).
  useEffect(() => {
    setSelected((prev) => {
      if (!prev.size) return prev;
      const alive = new Set(tickets.map((x) => x.id));
      const next  = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [tickets]);

  const setFilter = (key: FilterKey, values: string[]) =>
    setFilters((prev) => ({ ...prev, [key]: values }));

  const onSort = (key: string, dir: SortDir) => setSort({ key, dir });

  /* ---------------------------------------------------------------- filters */

  const matchSearch = useCallback((x: MaintenanceTicket) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [x.ticket_number, x.machine_name, x.assigned_to_name, x.description, x.work_order_number]
      .some((v) => (v ?? '').toLowerCase().includes(q));
  }, [search]);

  const matchers = useMemo<Record<FilterKey, (x: MaintenanceTicket) => boolean>>(() => ({
    machine:  (x) => !filters.machine.length  || filters.machine.includes(x.machine_name ?? ''),
    priority: (x) => !filters.priority.length || filters.priority.includes(x.priority),
    status:   (x) => !filters.status.length   || filters.status.includes(x.status),
    assignee: (x) => {
      if (!filters.assignee.length) return true;
      const names = techNames(x);
      return names.length
        ? names.some((n) => filters.assignee.includes(n))
        : filters.assignee.includes(UNASSIGNED);
    },
    sla:        (x) => !filters.sla.length        || filters.sla.includes(slaBucket(x)),
    escalation: (x) => !filters.escalation.length || filters.escalation.includes(String(x.current_escalation_level)),
  }), [filters]);

  /** Rows passing every filter except `key` — the basis for that column's counts. */
  const rowsExcept = useCallback((key: FilterKey) => tickets.filter((x) =>
    matchSearch(x) && (Object.keys(matchers) as FilterKey[]).every((k) => k === key || matchers[k](x))
  ), [tickets, matchers, matchSearch]);

  const filtered = useMemo(() => tickets.filter((x) =>
    matchSearch(x) && (Object.keys(matchers) as FilterKey[]).every((k) => matchers[k](x))
  ), [tickets, matchers, matchSearch]);

  const sorted = useMemo(() => {
    const val = (x: MaintenanceTicket): string | number => {
      switch (sort.key as SortKey) {
        case 'machine':    return x.machine_name ?? '';
        case 'priority':   return PRIORITY_ORDER[x.priority] ?? 0;
        case 'status':     return STATUS_ORDER[x.status] ?? 0;
        case 'assignee':   return techNames(x).join(', ');
        case 'age':        return elapsedMinutes(x.opened_at);
        case 'sla':        return slaRemaining(x) ?? Number.POSITIVE_INFINITY;
        case 'escalation': return x.current_escalation_level;
        default:           return x.ticket_number;
      }
    };
    return [...filtered].sort((a, b) => {
      const va = val(a), vb = val(b);
      const c = typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb));
      return sort.dir === 'asc' ? c : -c;
    });
  }, [filtered, sort]);

  /* ------------------------------------------------------- column facets */

  const buildFacet = useCallback((
    key: FilterKey,
    valuesOf: (x: MaintenanceTicket) => string[],
    labelOf: (v: string) => string,
    compare?: (a: ColumnOption, b: ColumnOption) => number,
  ): ColumnOption[] => {
    const counts = new Map<string, number>();
    for (const x of rowsExcept(key)) {
      for (const v of valuesOf(x)) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    // Keep already-selected values visible even when nothing matches them now,
    // otherwise the user cannot untick them.
    for (const v of filters[key]) if (!counts.has(v)) counts.set(v, 0);
    const opts = [...counts.entries()].map(([value, count]) => ({ value, label: labelOf(value), count }));
    return opts.sort(compare ?? ((a, b) => a.label.localeCompare(b.label)));
  }, [rowsExcept, filters]);

  const machineOptions = useMemo(
    () => buildFacet('machine', (x) => [x.machine_name ?? ''], (v) => v || '—'),
    [buildFacet]);

  const priorityOptions = useMemo(
    () => buildFacet('priority', (x) => [x.priority], (v) => t(`priority.${v}`, v),
      (a, b) => (PRIORITY_ORDER[b.value as AlertPriority] ?? 0) - (PRIORITY_ORDER[a.value as AlertPriority] ?? 0)),
    [buildFacet, t]);

  const statusOptions = useMemo(
    () => buildFacet('status', (x) => [x.status], (v) => t(`ticketStatus.${v}`, v),
      (a, b) => (STATUS_ORDER[a.value as TicketStatus] ?? 0) - (STATUS_ORDER[b.value as TicketStatus] ?? 0)),
    [buildFacet, t]);

  const assigneeOptions = useMemo(
    () => buildFacet('assignee', (x) => { const n = techNames(x); return n.length ? n : [UNASSIGNED]; },
      (v) => (v === UNASSIGNED ? t('common.unassigned') : v),
      (a, b) => (a.value === UNASSIGNED ? 1 : b.value === UNASSIGNED ? -1 : a.label.localeCompare(b.label))),
    [buildFacet, t]);

  const slaOptions = useMemo(() => {
    const rank: Record<string, number> = { overdue: 0, at_risk: 1, on_track: 2, na: 3 };
    const label: Record<string, string> = {
      overdue:  t('tickets.slaOverdue'),
      at_risk:  t('tickets.slaAtRisk'),
      on_track: t('tickets.slaOnTrack'),
      na:       t('tickets.slaNone'),
    };
    return buildFacet('sla', (x) => [slaBucket(x)], (v) => label[v] ?? v,
      (a, b) => (rank[a.value] ?? 9) - (rank[b.value] ?? 9));
  }, [buildFacet, t]);

  const escalationOptions = useMemo(
    () => buildFacet('escalation', (x) => [String(x.current_escalation_level)],
      (v) => (v === '0' ? t('tickets.noEscalation') : t('tickets.escalationLevel', { n: v })),
      (a, b) => Number(a.value) - Number(b.value)),
    [buildFacet, t]);

  const activeFilters = (Object.keys(filters) as FilterKey[]).reduce((n, k) => n + filters[k].length, 0);
  const anyFilter = activeFilters > 0 || !!search.trim();
  const clearAll  = () => { setFilters(EMPTY_FILTERS); setSearch(''); };

  /* ------------------------------------------------------- row selection */

  const visibleIds  = useMemo(() => sorted.map((x) => x.id), [sorted]);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someSelected = visibleIds.some((id) => selected.has(id));
  const headCbRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headCbRef.current) headCbRef.current.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);

  const toggleOne = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAllVisible = () => setSelected((prev) => {
    const next = new Set(prev);
    if (allSelected) visibleIds.forEach((id) => next.delete(id));
    else visibleIds.forEach((id) => next.add(id));
    return next;
  });

  const selectedTickets = useMemo(
    () => tickets.filter((x) => selected.has(x.id)), [tickets, selected]);
  const bulkStartable   = selectedTickets.filter((x) => x.status === 'open');
  const bulkCancellable = selectedTickets.filter((x) => x.status !== 'completed' && x.status !== 'cancelled');
  const bulkDeletable   = selectedTickets.filter((x) => x.status === 'completed' || x.status === 'cancelled');

  /* ------------------------------------------------------------ mutations */

  const quickAction = async (id: string, status: TicketStatus) => {
    setActionId(id);
    try {
      const updated = await updateTicketStatus(id, { status });
      setTickets((prev) => prev.map((x) => (x.id === id ? updated : x)));
    } finally {
      setActionId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(t('tickets.deleteConfirm'))) return;
    setDeletingId(id);
    try {
      await deleteTicket(id);
      setTickets((prev) => prev.filter((x) => x.id !== id));
      setTotal((prev) => prev - 1);
    } finally {
      setDeletingId(null);
    }
  };

  const bulkStatus = async (rows: MaintenanceTicket[], status: TicketStatus) => {
    if (!rows.length || bulkBusy) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(rows.map((x) => updateTicketStatus(x.id, { status })));
      const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      setTickets((prev) => prev.map((x) => ok.find((u) => u.id === x.id) ?? x));
      setSelected(new Set());
      if (ok.length < rows.length) await load();
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkDelete = async (rows: MaintenanceTicket[]) => {
    if (!rows.length || bulkBusy) return;
    if (!window.confirm(t('tickets.deleteManyConfirm', { n: rows.length }))) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(rows.map((x) => deleteTicket(x.id)));
      const gone = new Set(rows.filter((_, i) => results[i].status === 'fulfilled').map((x) => x.id));
      setTickets((prev) => prev.filter((x) => !gone.has(x.id)));
      setTotal((prev) => prev - gone.size);
      setSelected(new Set());
      if (gone.size < rows.length) await load();
    } finally {
      setBulkBusy(false);
    }
  };

  /* ------------------------------------------------------------- rendering */

  return (
    <div className="p-6 space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Ticket size={22} className="text-blue-400" />
            {t('tickets.title')}
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">{t('tickets.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {hasError && (
            <span className="text-xs text-amber-500 hidden sm:inline">⚠ {t('common.lastUpdateFailed')}</span>
          )}
          {lastUpdatedAt && !hasError && (
            <span className="text-xs text-gray-600 font-mono hidden sm:inline">
              {lastUpdatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          <button onClick={manualRefresh} disabled={isRefreshing} className="btn-secondary py-1.5 px-3">
            <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
          </button>
          {canCreate && (
            <Link to="/tickets/new" className="btn-primary py-1.5 px-3 flex items-center gap-1.5 text-sm">
              <Plus size={14} /> {t('tickets.newTicket')}
            </Link>
          )}
        </div>
      </div>

      {/* Search + status shortcuts (the tabs drive the Status column filter) */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative w-full sm:w-64">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('tickets.searchPlaceholder')}
            className="w-full pl-9 pr-8 py-1.5 bg-[#0d1421] border border-white/[0.06] rounded-lg text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500/50"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              title={t('common.clear')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-300"
            >
              <X size={13} />
            </button>
          )}
        </div>
        {(['', ...STATUS_TABS] as const).map((s) => {
          const active = s === '' ? filters.status.length === 0
            : filters.status.length === 1 && filters.status[0] === s;
          return (
            <button
              key={s || 'all'}
              onClick={() => setFilter('status', s === '' ? [] : [s])}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                active
                  ? 'bg-blue-500/15 text-blue-400 border-blue-500/30'
                  : 'border-white/10 text-gray-500 hover:border-white/20 hover:text-gray-300'
              }`}
            >
              {s === '' ? t('common.all') : t(`ticketStatus.${s}`, s)}
            </button>
          );
        })}
        {anyFilter && (
          <button
            onClick={clearAll}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border border-white/10 text-gray-400 hover:text-gray-200 hover:border-white/20 flex items-center gap-1.5"
          >
            <FilterX size={12} /> {t('common.clearFilters')}
          </button>
        )}
        <span className="ml-auto text-xs text-gray-600">
          {anyFilter
            ? `${t('tickets.showingOf', { shown: sorted.length, total: tickets.length })} ${t('tickets.total')}`
            : `${total} ${t('tickets.total')}`}
        </span>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 flex-wrap px-3 py-2 rounded-lg border border-blue-500/25 bg-blue-500/[0.07]">
          <span className="text-xs text-blue-300 font-medium">
            {t('common.nSelected', { n: selected.size })}
          </span>
          {canUpdate && bulkStartable.length > 0 && (
            <button
              onClick={() => bulkStatus(bulkStartable, 'in_progress')}
              disabled={bulkBusy}
              className="btn-success py-1 px-2.5 text-xs flex items-center gap-1.5"
            >
              <Play size={11} /> {t('tickets.start')} ({bulkStartable.length})
            </button>
          )}
          {canUpdate && bulkCancellable.length > 0 && (
            <button
              onClick={() => bulkStatus(bulkCancellable, 'cancelled')}
              disabled={bulkBusy}
              className="btn-danger py-1 px-2.5 text-xs flex items-center gap-1.5"
            >
              <XCircle size={11} /> {t('tickets.cancel')} ({bulkCancellable.length})
            </button>
          )}
          {canDelete && bulkDeletable.length > 0 && (
            <button
              onClick={() => bulkDelete(bulkDeletable)}
              disabled={bulkBusy}
              className="btn-danger py-1 px-2.5 text-xs flex items-center gap-1.5"
            >
              <Trash2 size={11} /> {t('common.delete')} ({bulkDeletable.length})
            </button>
          )}
          {bulkBusy && <Spinner size="sm" />}
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs text-gray-400 hover:text-gray-200"
          >
            {t('common.clearSelection')}
          </button>
        </div>
      )}

      {/* Table */}
      <div className="glass-card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <Spinner size="lg" />
          </div>
        ) : tickets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-3">
            <Ticket size={36} className="text-gray-700" />
            <p className="text-gray-500 text-sm">{t('tickets.noTickets')}</p>
          </div>
        ) : sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-3">
            <FilterX size={36} className="text-gray-700" />
            <p className="text-gray-500 text-sm">{t('tickets.noMatch')}</p>
            <button onClick={clearAll} className="btn-secondary py-1 px-3 text-xs">
              {t('common.clearFilters')}
            </button>
          </div>
        ) : (
          <div className="overflow-auto max-h-[calc(100vh-230px)]">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="table-header-cell sticky top-0 z-10 bg-gray-900 border-b border-white/[0.06] w-px pr-0">
                    <input
                      ref={headCbRef}
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAllVisible}
                      title={t('common.selectAll')}
                      aria-label={t('common.selectAll')}
                      className="w-3.5 h-3.5 accent-blue-600 cursor-pointer align-middle"
                    />
                  </th>
                  <TableColumnHeader
                    label={t('tickets.ticketNumber')}
                    className="w-px whitespace-nowrap"
                    sortKey="ticket" sortState={sort} onSort={onSort}
                  />
                  <TableColumnHeader
                    label={t('alerts.machine')}
                    className="whitespace-nowrap"
                    sortKey="machine" sortState={sort} onSort={onSort}
                    options={machineOptions} selected={filters.machine}
                    onFilter={(v) => setFilter('machine', v)}
                  />
                  <TableColumnHeader
                    label={t('common.priority')}
                    className="w-px whitespace-nowrap"
                    sortKey="priority" sortState={sort} onSort={onSort}
                    options={priorityOptions} selected={filters.priority}
                    onFilter={(v) => setFilter('priority', v)}
                  />
                  <TableColumnHeader
                    label={t('common.status')}
                    className="w-px whitespace-nowrap"
                    sortKey="status" sortState={sort} onSort={onSort}
                    options={statusOptions} selected={filters.status}
                    onFilter={(v) => setFilter('status', v)}
                  />
                  <TableColumnHeader
                    label={t('tickets.assignedTo')}
                    className="hidden md:table-cell whitespace-nowrap"
                    sortKey="assignee" sortState={sort} onSort={onSort}
                    options={assigneeOptions} selected={filters.assignee}
                    onFilter={(v) => setFilter('assignee', v)}
                  />
                  <TableColumnHeader
                    label={t('tickets.timeOpen')}
                    className="hidden lg:table-cell w-px whitespace-nowrap"
                    sortKey="age" sortState={sort} onSort={onSort}
                  />
                  <TableColumnHeader
                    label="SLA"
                    className="hidden xl:table-cell w-px whitespace-nowrap"
                    sortKey="sla" sortState={sort} onSort={onSort}
                    options={slaOptions} selected={filters.sla}
                    onFilter={(v) => setFilter('sla', v)}
                  />
                  <TableColumnHeader
                    label={t('alerts.escalation')}
                    className="hidden xl:table-cell w-px whitespace-nowrap"
                    sortKey="escalation" sortState={sort} onSort={onSort}
                    options={escalationOptions} selected={filters.escalation}
                    onFilter={(v) => setFilter('escalation', v)}
                  />
                  <th className="table-header-cell sticky top-0 z-10 bg-gray-900 border-b border-white/[0.06] w-px whitespace-nowrap">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((ticket) => {
                  const remain   = slaRemaining(ticket);
                  const bucket   = slaBucket(ticket);
                  const isPicked = selected.has(ticket.id);
                  return (
                    <tr key={ticket.id} className={`table-row ${isPicked ? 'bg-blue-500/[0.07]' : ''}`}>
                      <td className="table-cell pr-0 w-px">
                        <input
                          type="checkbox"
                          checked={isPicked}
                          onChange={() => toggleOne(ticket.id)}
                          aria-label={ticket.ticket_number}
                          className="w-3.5 h-3.5 accent-blue-600 cursor-pointer align-middle"
                        />
                      </td>
                      <td className="table-cell whitespace-nowrap">
                        <div className="flex flex-col gap-1">
                          <span className="font-mono text-blue-400 text-xs">{ticket.ticket_number}</span>
                          {ticket.machine_page_source && (
                            <span className="text-[10px] font-medium bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 px-1.5 py-0.5 rounded w-fit">
                              {t('tickets.machinePage')}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="table-cell font-medium text-gray-200">
                        {ticket.machine_name ?? '—'}
                      </td>
                      <td className="table-cell whitespace-nowrap">
                        <span className={`inline-flex items-center px-2 py-0.5 text-xs font-mono font-medium border rounded ${PRIORITY_BADGE[ticket.priority]}`}>
                          {t(`priority.${ticket.priority}`)}
                        </span>
                      </td>
                      <td className="table-cell whitespace-nowrap">
                        <span className={`inline-flex items-center px-2 py-0.5 text-xs font-mono font-medium border rounded ${STATUS_BADGE[ticket.status]}`}>
                          {t(`ticketStatus.${ticket.status}`, ticket.status)}
                        </span>
                      </td>
                      <td className="table-cell hidden md:table-cell text-gray-400 text-xs">
                        {ticket.assigned_to_name ?? '—'}
                      </td>
                      <td className="table-cell hidden lg:table-cell font-mono text-xs text-gray-400 whitespace-nowrap">
                        {timeOpen(ticket.opened_at)}
                      </td>
                      <td className="table-cell hidden xl:table-cell whitespace-nowrap">
                        {remain === null ? (
                          <span className="text-xs text-gray-700">—</span>
                        ) : bucket === 'overdue' ? (
                          <span className="text-xs font-mono text-red-400">{t('tickets.slaOverdue')}</span>
                        ) : (
                          <span className={`text-xs font-mono ${bucket === 'at_risk' ? 'text-amber-400' : 'text-green-400'}`}>
                            {remain < 60
                              ? t('tickets.minutesLeft', { n: Math.round(remain) })
                              : t('tickets.hoursLeft', { n: Math.floor(remain / 60) })}
                          </span>
                        )}
                      </td>
                      <td className="table-cell hidden xl:table-cell">
                        {ticket.current_escalation_level > 0 ? (
                          <span className="text-xs text-red-400 font-mono">L{ticket.current_escalation_level}</span>
                        ) : (
                          <span className="text-xs text-gray-700">—</span>
                        )}
                      </td>
                      <td className="table-cell whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          {canUpdate && ticket.status === 'open' && (
                            <button
                              onClick={() => quickAction(ticket.id, 'in_progress')}
                              disabled={actionId === ticket.id}
                              title={t('tickets.start')}
                              className="btn-success py-1 px-2 text-xs"
                            >
                              <Play size={11} />
                            </button>
                          )}
                          {canUpdate && ticket.status === 'in_progress' && (
                            <>
                              <button
                                onClick={() => quickAction(ticket.id, 'on_hold_parts')}
                                disabled={actionId === ticket.id}
                                title={t('tickets.holdParts')}
                                className="btn-warning py-1 px-2 text-xs"
                              >
                                <Package size={11} />
                              </button>
                              <button
                                onClick={() => quickAction(ticket.id, 'on_hold_ext')}
                                disabled={actionId === ticket.id}
                                title={t('tickets.holdExt')}
                                className="btn-warning py-1 px-2 text-xs"
                              >
                                <PauseCircle size={11} />
                              </button>
                            </>
                          )}
                          {canUpdate && (ticket.status === 'on_hold_parts' || ticket.status === 'on_hold_ext') && (
                            <button
                              onClick={() => quickAction(ticket.id, 'in_progress')}
                              disabled={actionId === ticket.id}
                              title={t('tickets.resume')}
                              className="btn-success py-1 px-2 text-xs"
                            >
                              <Play size={11} />
                            </button>
                          )}
                          {canUpdate && ticket.status !== 'completed' && ticket.status !== 'cancelled' && (
                            <button
                              onClick={() => quickAction(ticket.id, 'cancelled')}
                              disabled={actionId === ticket.id}
                              title={t('tickets.cancel')}
                              className="btn-danger py-1 px-2 text-xs"
                            >
                              <XCircle size={11} />
                            </button>
                          )}
                          {canDelete && (ticket.status === 'completed' || ticket.status === 'cancelled') && (
                            <button
                              onClick={() => handleDelete(ticket.id)}
                              disabled={deletingId === ticket.id}
                              title={t('common.delete')}
                              className="btn-danger py-1 px-2 text-xs"
                            >
                              <Trash2 size={11} />
                            </button>
                          )}
                          <button
                            onClick={() => navigate(`/tickets/${ticket.id}`)}
                            className="btn-secondary py-1 px-2 text-xs"
                            title={t('common.view')}
                          >
                            <ChevronRight size={11} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
