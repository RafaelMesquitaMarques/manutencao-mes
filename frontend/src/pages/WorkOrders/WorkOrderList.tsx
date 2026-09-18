import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, Search, Filter, RefreshCw, ClipboardList } from 'lucide-react';
import { AgGridReact } from 'ag-grid-react';
import type {
  ColDef, GridReadyEvent, RowClickedEvent, IDatasource, IGetRowsParams,
} from 'ag-grid-community';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import {
  fetchWorkOrdersPage, fetchWorkOrderFacets, EMPTY_WO_FACETS, WO_PAGE_MAX,
} from '../../api/workOrders';
import type { WorkOrderFacets, WorkOrderQuery, WorkOrderPageParams } from '../../api/workOrders';
import { usePlantStore } from '../../store/plantStore';
import type { WorkOrder, WorkOrderStatus, WorkOrderType, Priority } from '../../types';
import Spinner from '../../components/ui/Spinner';
import ExcelSetFilter, { SET_FILTER_BLANK } from '../../components/grid/ExcelSetFilter';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';
import { usePermission } from '../../hooks/usePermission';

const ALL = '';

// Rows fetched per request. Kept under the server's 200 cap, and a multiple of
// every page size the selector offers (10/20/50/100) so one page never straddles
// three blocks.
const GRID_BLOCK_SIZE = 100;
const MOBILE_PAGE = 30;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Column → the server's sort key. Equipment, Location and Technician are not
 * columns on work_orders — the first two come off the joined equipment row and
 * the third off the imported name — but the endpoint orders by all three, so
 * every column keeps the sort it had before the list went server-side.
 */
const SORT_KEYS: Record<string, string> = {
  wo_number: 'wo_number',
  title: 'title',
  equipment_name: 'equipment_name',
  sector: 'location',
  technician: 'technician',
  type: 'type',
  priority: 'priority',
  status: 'status',
  due_date: 'due_date',
  opened_at: 'opened_at',
};

/** Column → the pair of date params its date filter drives. */
const DATE_FILTER_PARAMS: Record<string, { from: 'opened_from' | 'due_from'; to: 'opened_to' | 'due_to' }> = {
  opened_at: { from: 'opened_from', to: 'opened_to' },
  due_date: { from: 'due_from', to: 'due_to' },
};

/** Column → the text param its own filter drives, separate from the toolbar search. */
const TEXT_FILTER_PARAMS: Record<string, 'wo_number_contains' | 'title_contains'> = {
  wo_number: 'wo_number_contains',
  title: 'title_contains',
};

/**
 * The operators the server can honour. Offering the rest would light a filter
 * chip that changes nothing — AG Grid shows every option by default.
 */
const TEXT_FILTER_OPTIONS = ['contains'];
const DATE_FILTER_OPTIONS = ['equals', 'greaterThan', 'lessThan', 'inRange', 'blank', 'notBlank'];

/** Column → the multi-value query param backing its checkbox filter. */
type MultiValueParam =
  | 'equipment_name_in' | 'location_in' | 'technician_in'
  | 'type_in' | 'priority_in' | 'status_in';

const SET_FILTER_PARAMS: Record<string, MultiValueParam> = {
  equipment_name: 'equipment_name_in',
  sector: 'location_in',
  technician: 'technician_in',
  type: 'type_in',
  priority: 'priority_in',
  status: 'status_in',
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'text-red-400',
  high: 'text-orange-400',
  medium: 'text-amber-400',
  low: 'text-green-400',
};

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-blue-500/15 text-blue-400',
  in_progress: 'bg-amber-500/15 text-amber-400',
  completed: 'bg-green-500/15 text-green-400',
  on_hold: 'bg-gray-500/15 text-gray-400',
  cancelled: 'bg-red-500/15 text-red-400',
};

// Cell renderers run on rows the grid has NOT loaded yet: a paged grid paints
// placeholder rows while their block is in flight, and those come through with
// `data` and `value` undefined. Each renderer bails out on them, leaving the
// placeholder row blank instead of crashing on an absent value.
function StatusCell({ value }: { value?: string }) {
  const { t } = useTranslation();
  if (!value) return null;
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[value] ?? 'text-gray-400'}`}>
      {t(`status.${value}`, value.replace('_', ' '))}
    </span>
  );
}

function PriorityCell({ value }: { value?: string }) {
  const { t } = useTranslation();
  if (!value) return null;
  return (
    <span className={`text-xs font-medium capitalize ${PRIORITY_COLORS[value] ?? 'text-gray-400'}`}>
      {t(`priority.${value}`, value)}
    </span>
  );
}

function WONumberCell({ value }: { value?: string }) {
  if (!value) return null;
  return <span className="font-mono text-xs text-blue-400">{value}</span>;
}

function DateCell({ value, data }: { value?: string | null; data?: WorkOrder }) {
  if (!data) return null;
  if (!value) return <span className="text-gray-600">—</span>;
  return (
    <span className="text-xs text-gray-400">
      {new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
    </span>
  );
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// The technician a work order is shown under: the assignment when there is one,
// otherwise the name the order was filed under in the Interal import (the only
// technician a historical row has — and the one the server filters on).
function technicianOf(wo: WorkOrder | undefined): string {
  return wo?.technicians?.[0]?.name ?? wo?.assigned_to_name ?? wo?.legacy_technician ?? '';
}

/**
 * Translates the grid's filter model into query params.
 *
 * `impossible` means the user unchecked every value of a column: no row can
 * match, which is a state the server has no way to express (an empty `*_in` is
 * read as "no filter"), so the page answers it without a round-trip.
 */
/** AG Grid hands dates back as 'yyyy-mm-dd hh:mm:ss'; the API wants the day. */
function dayOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const day = value.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
}

/** Moves a yyyy-mm-dd day, for turning a strict bound into an inclusive one. */
function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * AG Grid wraps a two-condition filter as `{operator, condition1, condition2}`
 * with nothing usable at the top level. The API takes one condition per column,
 * so the first is used rather than the whole model being dropped on the floor.
 */
function firstCondition(model: unknown): unknown {
  const m = model as { condition1?: unknown; filterType?: string };
  return m && m.condition1 && !m.filterType ? m.condition1 : model;
}

function queryFromFilterModel(filterModel: unknown): { query: WorkOrderPageParams; impossible: boolean } {
  const query: WorkOrderPageParams = {};
  if (!filterModel || typeof filterModel !== 'object') return { query, impossible: false };

  let impossible = false;

  for (const [colId, model] of Object.entries(filterModel as Record<string, unknown>)) {
    const param = SET_FILTER_PARAMS[colId];
    if (param) {
      if (!Array.isArray(model)) continue;
      // The blank sentinel has no server-side equivalent (the facets never list
      // it), so only real values travel.
      const values = model.filter((v): v is string => typeof v === 'string' && v !== SET_FILTER_BLANK);
      if (values.length === 0) impossible = true;
      else query[param] = values;
      continue;
    }
    // The two date columns push their range down as day bounds. The API's bounds
    // are inclusive, so the strict operators are expressed by moving the day.
    const dateParams = DATE_FILTER_PARAMS[colId];
    if (dateParams) {
      const d = firstCondition(model) as
        { filterType?: string; type?: string; dateFrom?: unknown; dateTo?: unknown };
      if (d?.filterType !== 'date') continue;
      const from = dayOf(d.dateFrom);
      const to = dayOf(d.dateTo);
      if (d.type === 'blank' || d.type === 'notBlank') {
        // Only due_date has a null-ness param; opened_at is never null.
        if (colId === 'due_date') query.due_is_null = d.type === 'blank';
        else if (d.type === 'blank') impossible = true;
        continue;
      }
      if (d.type === 'inRange') {
        if (from) query[dateParams.from] = from;
        if (to) query[dateParams.to] = to;
      } else if (d.type === 'greaterThan' && from) {
        query[dateParams.from] = shiftDay(from, 1);   // strictly after
      } else if (d.type === 'lessThan' && from) {
        query[dateParams.to] = shiftDay(from, -1);    // strictly before
      } else if (d.type === 'equals' && from) {
        query[dateParams.from] = from;
        query[dateParams.to] = from;
      }
      continue;
    }
    // WO number and title each own a param, so two column filters — or a column
    // filter and the toolbar search — no longer overwrite one another.
    const textParam = TEXT_FILTER_PARAMS[colId];
    const text = firstCondition(model) as { filterType?: string; filter?: unknown };
    if (textParam && text?.filterType === 'text'
        && typeof text.filter === 'string' && text.filter.trim()) {
      query[textParam] = text.filter.trim();
    }
  }

  return { query, impossible };
}

const dedupeById = (rows: WorkOrder[]): WorkOrder[] => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
};

// Mobile-only card: the AG Grid is unreadable on a phone (every column collapses
// to a single truncated letter), so below the `lg` breakpoint we render a tappable
// card per work order instead.
function WorkOrderCard({ wo, onClick }: { wo: WorkOrder; onClick: () => void }) {
  const { t } = useTranslation();
  const technician = technicianOf(wo);
  return (
    <button
      onClick={onClick}
      className="glass-card w-full text-left p-3.5 flex flex-col gap-2 active:bg-white/[0.04] transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-xs text-blue-400 flex-shrink-0">{wo.wo_number}</span>
        <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${STATUS_COLORS[wo.status] ?? 'text-gray-400'}`}>
          {t(`status.${wo.status}`, wo.status.replace('_', ' '))}
        </span>
      </div>
      <p className="text-sm text-gray-100 font-medium leading-snug">{wo.title}</p>
      {(wo.equipment_name || wo.equipment_location) && (
        <p className="text-xs text-gray-400 truncate">
          {[wo.equipment_name, wo.equipment_location].filter(Boolean).join(' · ')}
        </p>
      )}
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className={`font-medium ${PRIORITY_COLORS[wo.priority] ?? 'text-gray-400'}`}>
          {t(`priority.${wo.priority}`, wo.priority)}
        </span>
        <div className="flex items-center gap-3 text-gray-500">
          {technician && <span className="truncate max-w-[120px]">{technician}</span>}
          <span className="font-mono">{fmtDate(wo.due_date)}</span>
        </div>
      </div>
    </button>
  );
}

const WorkOrderList = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canCreate = usePermission('work_orders', 'create');
  const gridRef = useRef<AgGridReact>(null);
  const activePlantId = usePlantStore((s) => s.activePlantId);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<WorkOrderStatus | ''>(ALL);
  const [typeFilter, setTypeFilter] = useState<WorkOrderType | ''>(ALL);
  const [priorityFilter, setPriorityFilter] = useState<Priority | ''>(ALL);

  // How many orders this plant has at all, ignoring every filter. Doubles as the
  // "has this plant ever had a work order" answer behind the empty state, which
  // used to be `workOrders.length` back when the whole table was in memory.
  const [plantTotal, setPlantTotal] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Server total for the query the grid is showing (null until the first block).
  const [gridTotal, setGridTotal] = useState<number | null>(null);
  const [facets, setFacets] = useState<WorkOrderFacets>(EMPTY_WO_FACETS);

  // The card list renders plain DOM (no virtualization) and has no column
  // filters, so it pages through the server on its own. Only fetched when the
  // viewport is actually below `lg` — otherwise every desktop refresh would pay
  // for a list nobody can see.
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? true
      : window.matchMedia('(min-width: 1024px)').matches,
  );
  const [mobileRows, setMobileRows] = useState<WorkOrder[]>([]);
  const [mobileTotal, setMobileTotal] = useState(0);
  const [mobileLoading, setMobileLoading] = useState(false);
  const mobileRowsRef = useRef<WorkOrder[]>([]);
  useEffect(() => { mobileRowsRef.current = mobileRows; }, [mobileRows]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    // Belt and braces: a plain resize listener catches the environments where
    // the media-query `change` event does not fire (device emulation).
    window.addEventListener('resize', sync);
    return () => {
      mq.removeEventListener('change', sync);
      window.removeEventListener('resize', sync);
    };
  }, []);

  // Typing must not fire a request per keystroke against 65k rows.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search]);

  const toolbarQuery = useMemo<WorkOrderQuery>(() => {
    const q: WorkOrderQuery = {};
    const term = debouncedSearch.trim();
    if (term) q.search = term;
    if (statusFilter) q.status = statusFilter;
    if (typeFilter) q.type = typeFilter;
    if (priorityFilter) q.priority = priorityFilter;
    return q;
  }, [debouncedSearch, statusFilter, typeFilter, priorityFilter]);

  // Unfiltered count + "is this plant empty", refreshed with everything else.
  const loadPlantTotal = useCallback(
    () => fetchWorkOrdersPage({ skip: 0, limit: 1 }).then(({ total }) => setPlantTotal(total)),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setPlantTotal(null);
    setGridTotal(null);
    fetchWorkOrdersPage({ skip: 0, limit: 1 })
      .then(({ total }) => { if (!cancelled) setPlantTotal(total); })
      .catch(() => { if (!cancelled) setPlantTotal(0); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [activePlantId]);

  // Checkbox filter values now come from the database, not from the loaded rows.
  useEffect(() => {
    let cancelled = false;
    fetchWorkOrderFacets()
      .then((f) => { if (!cancelled) setFacets(f); })
      .catch(() => { if (!cancelled) setFacets(EMPTY_WO_FACETS); });
    return () => { cancelled = true; };
  }, [activePlantId]);

  const datasource = useMemo<IDatasource>(() => ({
    getRows: (params: IGetRowsParams) => {
      const { query, impossible } = queryFromFilterModel(params.filterModel);
      if (impossible) {
        setGridTotal(0);
        params.successCallback([], 0);
        return;
      }
      // The toolbar selects win over the column filter for the same free-text
      // slot; for status/type/priority the server ANDs both, so they intersect.
      const request: WorkOrderPageParams = { ...query, ...toolbarQuery };
      const sort = params.sortModel?.find((s) => SORT_KEYS[s.colId]);
      if (sort) {
        request.sort_by = SORT_KEYS[sort.colId];
        request.sort_dir = sort.sort === 'asc' ? 'asc' : 'desc';
      }
      request.skip = params.startRow;
      request.limit = Math.min(params.endRow - params.startRow, WO_PAGE_MAX);

      fetchWorkOrdersPage(request)
        .then(({ total, items }) => {
          setGridTotal(total);
          params.successCallback(items, total);
        })
        .catch(() => params.failCallback());
    },
  }), [toolbarQuery]);

  // A new datasource resets the cache; send the user back to page 1 so a
  // narrower filter does not leave them stranded past the last page.
  useEffect(() => {
    gridRef.current?.api?.paginationGoToFirstPage();
  }, [datasource]);

  // Mobile list: first page for the current toolbar state.
  useEffect(() => {
    if (isDesktop) return;
    let cancelled = false;
    setMobileLoading(true);
    fetchWorkOrdersPage({ ...toolbarQuery, skip: 0, limit: MOBILE_PAGE })
      .then(({ total, items }) => {
        if (cancelled) return;
        setMobileTotal(total);
        setMobileRows(items);
      })
      .catch(() => {
        if (cancelled) return;
        setMobileTotal(0);
        setMobileRows([]);
      })
      .finally(() => { if (!cancelled) setMobileLoading(false); });
    return () => { cancelled = true; };
  }, [isDesktop, toolbarQuery]);

  const loadMoreMobile = useCallback(() => {
    setMobileLoading(true);
    fetchWorkOrdersPage({ ...toolbarQuery, skip: mobileRowsRef.current.length, limit: MOBILE_PAGE })
      .then(({ total, items }) => {
        setMobileTotal(total);
        setMobileRows((prev) => dedupeById([...prev, ...items]));
      })
      .catch(() => { /* keep what we have */ })
      .finally(() => setMobileLoading(false));
  }, [toolbarQuery]);

  const refreshAll = useCallback(async () => {
    // Reloads the blocks the grid is holding, keeping the page and scroll.
    gridRef.current?.api?.refreshInfiniteCache();

    const tasks: Promise<unknown>[] = [loadPlantTotal()];
    const loaded = mobileRowsRef.current.length;
    if (!isDesktop && loaded > 0) {
      // Refresh what the card list has already pulled down, in one request.
      const limit = Math.min(loaded, WO_PAGE_MAX);
      tasks.push(
        fetchWorkOrdersPage({ ...toolbarQuery, skip: 0, limit }).then(({ total, items }) => {
          setMobileTotal(total);
          setMobileRows((prev) => dedupeById([...items, ...prev.slice(limit)]));
        }),
      );
    }
    await Promise.all(tasks);
  }, [isDesktop, toolbarQuery, loadPlantTotal]);

  const { lastUpdatedAt, isRefreshing, hasError, manualRefresh } = useAutoRefresh(refreshAll);

  const colDefs = useMemo(() => ([
    {
      field: 'wo_number',
      headerName: t('workOrders.woNumber'),
      width: 140,
      cellRenderer: WONumberCell,
      sortable: true,
      filter: 'agTextColumnFilter',
      filterParams: { filterOptions: TEXT_FILTER_OPTIONS, maxNumConditions: 1 },
    },
    {
      field: 'title',
      headerName: t('workOrders.titleField'),
      flex: 2,
      sortable: true,
      filter: 'agTextColumnFilter',
      filterParams: { filterOptions: TEXT_FILTER_OPTIONS, maxNumConditions: 1 },
      cellStyle: { color: '#e2e8f0', fontSize: '13px' },
    },
    {
      field: 'equipment_name',
      headerName: t('workOrders.equipment'),
      flex: 1,
      sortable: true,
      filter: ExcelSetFilter,
      filterParams: { values: facets.equipment_name },
      cellStyle: { color: '#94a3b8', fontSize: '13px' },
    },
    {
      colId: 'sector',
      headerName: t('workOrders.sector', 'Secteur'),
      valueGetter: (p) => p.data?.equipment_location ?? '',
      width: 150,
      sortable: true,
      filter: ExcelSetFilter,
      filterParams: { values: facets.location },
      cellStyle: { color: '#94a3b8', fontSize: '13px' },
    },
    {
      colId: 'technician',
      headerName: t('workOrders.technicianLabel'),
      valueGetter: (p) => technicianOf(p.data),
      width: 160,
      sortable: true,
      filter: ExcelSetFilter,
      filterParams: { values: facets.technician },
      cellStyle: { color: '#94a3b8', fontSize: '13px' },
    },
    {
      field: 'type',
      headerName: t('common.type'),
      width: 120,
      sortable: true,
      filter: ExcelSetFilter,
      filterParams: { values: facets.type },
      valueFormatter: (p) => (p.value ? t(`type.${p.value}`, p.value) : ''),
      cellStyle: { color: '#94a3b8', fontSize: '13px' },
    },
    {
      field: 'priority',
      headerName: t('common.priority'),
      width: 110,
      sortable: true,
      filter: ExcelSetFilter,
      filterParams: { values: facets.priority },
      cellRenderer: PriorityCell,
      valueFormatter: (p) => (p.value ? t(`priority.${p.value}`, p.value) : ''),
    },
    {
      field: 'status',
      headerName: t('common.status'),
      width: 130,
      sortable: true,
      filter: ExcelSetFilter,
      filterParams: { values: facets.status },
      cellRenderer: StatusCell,
      valueFormatter: (p) => (p.value ? t(`status.${p.value}`, String(p.value).replace('_', ' ')) : ''),
    },
    {
      field: 'due_date',
      headerName: t('workOrders.dueDate'),
      width: 130,
      sortable: true,
      filter: 'agDateColumnFilter',
      filterParams: { filterOptions: DATE_FILTER_OPTIONS, maxNumConditions: 1 },
      cellRenderer: DateCell,
    },
    {
      field: 'opened_at',
      headerName: t('workOrders.openedAt'),
      width: 130,
      sortable: true,
      sort: 'desc',
      filter: 'agDateColumnFilter',
      filterParams: { filterOptions: DATE_FILTER_OPTIONS, maxNumConditions: 1 },
      cellRenderer: DateCell,
    },
  ] as ColDef<WorkOrder>[]), [t, facets]);

  const defaultColDef: ColDef = useMemo(() => ({
    resizable: true,
    suppressMovable: false,
    floatingFilter: true,
  }), []);

  const getRowId = useCallback((params: { data: WorkOrder }) => params.data.id, []);

  const onRowClicked = useCallback((event: RowClickedEvent<WorkOrder>) => {
    if (event.data) navigate(`/work-orders/${event.data.id}`);
  }, [navigate]);

  const onGridReady = useCallback((params: GridReadyEvent) => {
    params.api.sizeColumnsToFit();
  }, []);

  const statuses: WorkOrderStatus[] = ['open', 'in_progress', 'completed', 'cancelled', 'on_hold'];
  const types: WorkOrderType[] = ['corrective', 'preventive', 'predictive', 'inspection', 'improvement'];
  const priorities: Priority[] = ['low', 'medium', 'high', 'critical'];

  // Both counts are the server's, for the pane the user is actually looking at.
  const shownTotal = isDesktop ? (gridTotal ?? plantTotal ?? 0) : mobileTotal;

  return (
    <div className="space-y-4 animate-fade-in p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('workOrders.title')}</h1>
          <p className="text-gray-500 text-sm mt-1">{t('workOrders.subtitle')}</p>
        </div>
        {canCreate && (
          <button onClick={() => navigate('/work-orders/new')} className="btn-primary flex-shrink-0">
            <Plus size={16} />
            {t('workOrders.newWO')}
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="glass-card p-3">
        <div className="flex flex-wrap gap-2.5 items-center">
          <div className="relative flex-1 min-w-[180px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('common.search')}
              className="input-field pl-8 py-1.5"
            />
          </div>
          <Filter size={13} className="text-gray-600" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as WorkOrderStatus | '')}
            className="select-field py-1.5 pr-8 text-xs min-w-[120px]"
          >
            <option value={ALL}>{t('common.status')}: {t('common.all')}</option>
            {statuses.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
          </select>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as WorkOrderType | '')}
            className="select-field py-1.5 pr-8 text-xs min-w-[120px]"
          >
            <option value={ALL}>{t('common.type')}: {t('common.all')}</option>
            {types.map((tp) => <option key={tp} value={tp}>{t(`type.${tp}`)}</option>)}
          </select>
          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value as Priority | '')}
            className="select-field py-1.5 pr-8 text-xs min-w-[120px]"
          >
            <option value={ALL}>{t('common.priority')}: {t('common.all')}</option>
            {priorities.map((p) => <option key={p} value={p}>{t(`priority.${p}`)}</option>)}
          </select>
          {hasError && (
            <span className="text-xs text-amber-500 hidden sm:inline">⚠ {t('common.lastUpdateFailed')}</span>
          )}
          {lastUpdatedAt && !hasError && (
            <span className="text-xs text-gray-600 font-mono hidden sm:inline">
              {lastUpdatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          <button onClick={manualRefresh} disabled={isRefreshing} className="btn-secondary py-1.5 px-2.5 ml-auto">
            <RefreshCw size={13} className={isRefreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Spinner />
        </div>
      ) : plantTotal === 0 ? (
        <div className="glass-card flex flex-col items-center py-16 gap-3">
          <ClipboardList size={40} className="text-gray-700" />
          <p className="text-gray-400 text-sm">{t('workOrders.noResults')}</p>
          <button onClick={() => navigate('/work-orders/new')} className="btn-primary gap-1.5 py-2 px-4 text-sm">
            <Plus size={15} />
            {t('workOrders.createFirst')}
          </button>
        </div>
      ) : (
        <div>
          <p className="text-gray-600 text-xs font-mono mb-2 px-1">
            {t('workOrders.countLabel', { shown: shownTotal, total: plantTotal ?? shownTotal })}
          </p>
          {/* Desktop: AG Grid. Hidden on phones where the columns are unreadable. */}
          <div
            className="hidden lg:block ag-theme-quartz-dark rounded-xl overflow-hidden border border-white/[0.06]"
            style={{ height: 520 }}
          >
            <AgGridReact<WorkOrder>
              ref={gridRef}
              reactiveCustomComponents
              rowModelType="infinite"
              datasource={datasource}
              cacheBlockSize={GRID_BLOCK_SIZE}
              maxBlocksInCache={10}
              blockLoadDebounceMillis={100}
              getRowId={getRowId}
              columnDefs={colDefs}
              defaultColDef={defaultColDef}
              onRowClicked={onRowClicked}
              onGridReady={onGridReady}
              rowClass="cursor-pointer"
              rowSelection="single"
              suppressCellFocus={true}
              animateRows={true}
              pagination={true}
              paginationPageSize={20}
              paginationPageSizeSelector={[10, 20, 50, 100]}
            />
          </div>
          {/* Mobile: tappable card list. */}
          <div className="lg:hidden space-y-2.5">
            {mobileRows.length === 0 ? (
              <div className="glass-card flex items-center justify-center py-10 text-gray-500 text-sm">
                {mobileLoading ? <Spinner /> : t('workOrders.noResults')}
              </div>
            ) : (
              <>
                {mobileRows.map((wo) => (
                  <WorkOrderCard key={wo.id} wo={wo} onClick={() => navigate(`/work-orders/${wo.id}`)} />
                ))}
                {mobileRows.length < mobileTotal && (
                  <button
                    onClick={loadMoreMobile}
                    disabled={mobileLoading}
                    className="btn-secondary w-full py-2.5 text-sm"
                  >
                    {t('common.loadMore', 'Load more')}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default WorkOrderList;
