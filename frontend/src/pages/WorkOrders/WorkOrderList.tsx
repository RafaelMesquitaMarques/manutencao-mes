import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, Search, Filter, RefreshCw, ClipboardList } from 'lucide-react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GridReadyEvent, RowClickedEvent } from 'ag-grid-community';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import { fetchWorkOrders } from '../../api/workOrders';
import { useWorkOrderStore } from '../../store/workOrderStore';
import type { WorkOrder, WorkOrderStatus, WorkOrderType, Priority } from '../../types';
import Spinner from '../../components/ui/Spinner';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';

const ALL = '';

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

function StatusCell({ value }: { value: string }) {
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[value] ?? 'text-gray-400'}`}>
      {value.replace('_', ' ')}
    </span>
  );
}

function PriorityCell({ value }: { value: string }) {
  return (
    <span className={`text-xs font-medium capitalize ${PRIORITY_COLORS[value] ?? 'text-gray-400'}`}>
      {value}
    </span>
  );
}

function WONumberCell({ value }: { value: string }) {
  return <span className="font-mono text-xs text-blue-400">{value}</span>;
}

function DateCell({ value }: { value: string | null }) {
  if (!value) return <span className="text-gray-600">—</span>;
  return (
    <span className="text-xs text-gray-400">
      {new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
    </span>
  );
}

const WorkOrderList = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const gridRef = useRef<AgGridReact>(null);

  const { workOrders, isLoading, setWorkOrders, setLoading } = useWorkOrderStore();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<WorkOrderStatus | ''>(ALL);
  const [typeFilter, setTypeFilter] = useState<WorkOrderType | ''>(ALL);
  const [priorityFilter, setPriorityFilter] = useState<Priority | ''>(ALL);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await fetchWorkOrders();
      setWorkOrders(data);
    } catch {
      // keep empty
    } finally {
      if (!silent) setLoading(false);
    }
  }, [setWorkOrders, setLoading]);

  useEffect(() => { load(); }, [load]);

  const { lastUpdatedAt, isRefreshing, hasError, manualRefresh } = useAutoRefresh(
    () => load(true),
  );

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return workOrders.filter((wo) => {
      if (statusFilter && wo.status !== statusFilter) return false;
      if (typeFilter && wo.type !== typeFilter) return false;
      if (priorityFilter && wo.priority !== priorityFilter) return false;
      if (q) {
        return (
          wo.wo_number.toLowerCase().includes(q) ||
          wo.title.toLowerCase().includes(q) ||
          (wo.equipment_name ?? '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [workOrders, search, statusFilter, typeFilter, priorityFilter]);

  const colDefs = useMemo(() => ([
    {
      field: 'wo_number',
      headerName: t('workOrders.woNumber'),
      width: 140,
      cellRenderer: WONumberCell,
      sortable: true,
      filter: false,
    },
    {
      field: 'title',
      headerName: t('workOrders.titleField'),
      flex: 2,
      sortable: true,
      filter: 'agTextColumnFilter',
      cellStyle: { color: '#e2e8f0', fontSize: '13px' },
    },
    {
      field: 'equipment_name',
      headerName: t('workOrders.equipment'),
      flex: 1,
      sortable: true,
      filter: 'agTextColumnFilter',
      cellStyle: { color: '#94a3b8', fontSize: '13px' },
    },
    {
      field: 'type',
      headerName: t('common.type'),
      width: 120,
      sortable: true,
      filter: 'agSetColumnFilter',
      cellStyle: { color: '#94a3b8', fontSize: '13px', textTransform: 'capitalize' },
    },
    {
      field: 'priority',
      headerName: t('common.priority'),
      width: 110,
      sortable: true,
      filter: 'agSetColumnFilter',
      cellRenderer: PriorityCell,
    },
    {
      field: 'status',
      headerName: t('common.status'),
      width: 130,
      sortable: true,
      filter: 'agSetColumnFilter',
      cellRenderer: StatusCell,
    },
    {
      field: 'due_date',
      headerName: t('workOrders.dueDate'),
      width: 130,
      sortable: true,
      cellRenderer: DateCell,
    },
    {
      field: 'opened_at',
      headerName: t('workOrders.openedAt'),
      width: 130,
      sortable: true,
      sort: 'desc',
      cellRenderer: DateCell,
    },
  ] as ColDef<WorkOrder>[]), [t]);

  const defaultColDef: ColDef = useMemo(() => ({
    resizable: true,
    suppressMovable: false,
  }), []);

  const onRowClicked = useCallback((event: RowClickedEvent<WorkOrder>) => {
    if (event.data) navigate(`/work-orders/${event.data.id}`);
  }, [navigate]);

  const onGridReady = useCallback((params: GridReadyEvent) => {
    params.api.sizeColumnsToFit();
  }, []);

  const statuses: WorkOrderStatus[] = ['open', 'in_progress', 'completed', 'cancelled', 'on_hold'];
  const types: WorkOrderType[] = ['corrective', 'preventive', 'predictive', 'inspection', 'improvement'];
  const priorities: Priority[] = ['low', 'medium', 'high', 'critical'];

  return (
    <div className="space-y-4 animate-fade-in p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('workOrders.title')}</h1>
          <p className="text-gray-500 text-sm mt-1">{t('workOrders.subtitle')}</p>
        </div>
        <button onClick={() => navigate('/work-orders/new')} className="btn-primary flex-shrink-0">
          <Plus size={16} />
          {t('workOrders.newWO')}
        </button>
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
            <span className="text-xs text-amber-500 hidden sm:inline">⚠ Last update failed</span>
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
      ) : workOrders.length === 0 ? (
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
            {filtered.length} / {workOrders.length} orders
          </p>
          <div
            className="ag-theme-quartz-dark rounded-xl overflow-hidden border border-white/[0.06]"
            style={{ height: 520 }}
          >
            <AgGridReact<WorkOrder>
              ref={gridRef}
              rowData={filtered}
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
        </div>
      )}
    </div>
  );
};

export default WorkOrderList;
