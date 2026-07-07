// frontend/src/pages/Inventory/InventoryList.tsx
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-alpine.css';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { AgGridReact } from 'ag-grid-react';
import type { CellClickedEvent, CellValueChangedEvent, ColDef, ICellRendererParams } from 'ag-grid-community';
import {
  Package, AlertTriangle, Search, Filter, Plus,
  RefreshCw, Download, ChevronDown, X, Boxes,
  TrendingDown, CircleAlert,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  fetchStockItems,
  fetchInventoryCategories,
  fetchInventoryDashboard,
  updateStockItem,
  type StockItemFilters,
} from '../../api/inventory';
import { fetchSupplierList } from '../../api/suppliers';
import ExcelSetFilter from '../../components/grid/ExcelSetFilter';
import type { StockItem, InventoryDashboard, Supplier } from '../../types';

// ── Cell renderers ────────────────────────────────────────────────────────────

function QuantityCellRenderer({ data }: ICellRendererParams<StockItem>) {
  if (!data) return null;
  const qty = data.quantity;
  const isLow = data.is_low_stock;
  const isZero = qty <= 0;

  return (
    <span
      className={`inline-flex items-center gap-1 font-mono font-semibold text-sm ${
        isZero
          ? 'text-red-400'
          : isLow
          ? 'text-amber-400'
          : 'text-emerald-400'
      }`}
    >
      {isZero && <CircleAlert size={13} />}
      {!isZero && isLow && <AlertTriangle size={13} />}
      {qty.toFixed(qty % 1 === 0 ? 0 : 2)} {data.unit !== 'Unitaire' ? data.unit : ''}
    </span>
  );
}

function CategoryCellRenderer({ value }: ICellRendererParams) {
  if (!value) return <span className="text-gray-500 text-xs italic">—</span>;
  const colorMap: Record<string, string> = {
    mecanique:    'bg-blue-900/50 text-blue-300 border-blue-700',
    electrique:   'bg-yellow-900/50 text-yellow-300 border-yellow-700',
    pneumatique:  'bg-cyan-900/50 text-cyan-300 border-cyan-700',
    electronique: 'bg-purple-900/50 text-purple-300 border-purple-700',
    hydraulique:  'bg-orange-900/50 text-orange-300 border-orange-700',
    valve:        'bg-pink-900/50 text-pink-300 border-pink-700',
  };
  const key = value.toLowerCase().split(' ')[0];
  const cls = colorMap[key] ?? 'bg-gray-800 text-gray-300 border-gray-600';
  return (
    <span className={`px-2 py-0.5 rounded border text-xs font-medium ${cls}`}>
      {value}
    </span>
  );
}

function LocationCellRenderer({ data }: ICellRendererParams<StockItem>) {
  if (!data) return null;
  const parts = [data.warehouse, data.location].filter(Boolean);
  if (!parts.length) return <span className="text-gray-500 text-xs italic">—</span>;
  return (
    <span className="font-mono text-xs text-gray-300">
      {parts.join(' › ')}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function InventoryList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const gridRef = useRef<AgGridReact<StockItem>>(null);

  const [items, setItems] = useState<StockItem[]>([]);
  const [total, setTotal] = useState(0);
  const [lowStockCount, setLowStockCount] = useState(0);
  const [dashboard, setDashboard] = useState<InventoryDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<string[]>([]);
  const [warehouses, setWarehouses] = useState<string[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  const [filters, setFilters] = useState<StockItemFilters>({
    search: '',
    category: '',
    warehouse: '',
    supplier_id: '',
    low_stock_only: false,
    limit: 5500,
    skip: 0,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, dash, cats, sups] = await Promise.allSettled([
        fetchStockItems(filters),
        fetchInventoryDashboard(),
        fetchInventoryCategories(),
        fetchSupplierList({ active_only: true, limit: 200 }),
      ]);

      if (res.status === 'fulfilled') {
        setItems(res.value.items);
        setTotal(res.value.total);
        setLowStockCount(res.value.low_stock_count);
      }
      if (dash.status === 'fulfilled') setDashboard(dash.value);
      if (cats.status === 'fulfilled') {
        setCategories(cats.value.categories);
        setWarehouses(cats.value.warehouses);
      }
      if (sups.status === 'fulfilled') setSuppliers(sups.value.items);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  // Columns flex to fill the viewport; when their minimum widths don't fit,
  // the grid's own horizontal scrollbar (always visible at the bottom of the
  // table area) takes over.
  const colDefs = useMemo<ColDef<StockItem>[]>(() => [
    {
      field: 'code',
      headerName: t('inventory.code', 'Part No.'),
      width: 130,
      pinned: 'left',
      cellClass: 'font-mono text-xs text-indigo-300 font-semibold',
      filter: 'agTextColumnFilter',
    },
    {
      field: 'description',
      headerName: t('inventory.description', 'Description'),
      flex: 2,
      minWidth: 220,
      filter: 'agTextColumnFilter',
      cellClass: 'text-sm text-gray-200',
      tooltipField: 'description',
    },
    {
      field: 'category',
      headerName: t('inventory.category', 'Category'),
      flex: 1,
      minWidth: 112,
      cellRenderer: CategoryCellRenderer,
      filter: ExcelSetFilter,
      tooltipField: 'category',
    },
    {
      field: 'part_class',
      headerName: t('inventory.partClass', 'Part Class'),
      flex: 1,
      minWidth: 100,
      cellClass: 'text-xs text-gray-400',
      filter: ExcelSetFilter,
      tooltipField: 'part_class',
    },
    {
      field: 'quantity',
      headerName: t('inventory.quantity', 'Qty in stock'),
      flex: 1,
      minWidth: 118,
      cellRenderer: QuantityCellRenderer,
      sort: 'asc',
      comparator: (a, b) => a - b,
      filter: 'agNumberColumnFilter',
    },
    {
      field: 'min_quantity',
      headerName: t('inventory.minQty', 'Min qty'),
      flex: 0.7,
      minWidth: 88,
      editable: true,
      filter: 'agNumberColumnFilter',
      cellClass: 'text-xs font-mono text-gray-300',
      valueFormatter: ({ value }) => (value != null ? String(value) : '—'),
      valueParser: ({ newValue }) => {
        const v = parseFloat(String(newValue ?? '').replace(',', '.'));
        return Number.isFinite(v) && v >= 0 ? v : null;
      },
      headerTooltip: t('inventory.editHint', 'Double-click to edit'),
    },
    {
      field: 'unit_cost',
      headerName: t('inventory.cost', 'Unit cost'),
      flex: 0.8,
      minWidth: 105,
      editable: true,
      filter: 'agNumberColumnFilter',
      cellClass: 'text-xs font-mono text-emerald-300',
      valueFormatter: ({ value }) =>
        value != null ? `$${Number(value).toFixed(2)}` : '—',
      valueParser: ({ newValue }) => {
        const v = parseFloat(String(newValue ?? '').replace('$', '').replace(',', '.'));
        return Number.isFinite(v) && v >= 0 ? v : null;
      },
      headerTooltip: t('inventory.costEditHint', 'Double-click to edit'),
    },
    {
      field: 'average_cost',
      headerName: t('inventory.avgCost', 'Avg. cost'),
      flex: 0.8,
      minWidth: 105,
      filter: 'agNumberColumnFilter',
      cellClass: 'text-xs font-mono text-sky-300',
      valueFormatter: ({ value }) =>
        value != null ? `$${Number(value).toFixed(2)}` : '—',
      headerTooltip: t('inventory.avgCostHint', 'Weighted average of all received purchases'),
    },
    {
      field: 'last_purchase_cost',
      headerName: t('inventory.lastPurchase', 'Last purchase'),
      flex: 0.85,
      minWidth: 120,
      filter: 'agNumberColumnFilter',
      cellClass: 'text-xs font-mono text-amber-200',
      valueFormatter: ({ value }) =>
        value != null ? `$${Number(value).toFixed(2)}` : '—',
      headerTooltip: t('inventory.lastPurchaseHint', 'Unit cost of the most recent receipt'),
      tooltipValueGetter: (p) => {
        const d = (p.data as StockItem | undefined)?.last_purchase_date;
        return d ? `${t('inventory.lastPurchase', 'Last purchase')}: ${d}` : '';
      },
    },
    {
      colId: 'location',
      headerName: t('inventory.location', 'Location'),
      flex: 1,
      minWidth: 125,
      cellRenderer: LocationCellRenderer,
      valueGetter: (p) => [p.data?.warehouse, p.data?.location].filter(Boolean).join(' / '),
      filter: ExcelSetFilter,
    },
    {
      field: 'supplier_name',
      headerName: t('inventory.supplier', 'Supplier'),
      flex: 1.2,
      minWidth: 135,
      editable: true,
      cellEditor: 'agSelectCellEditor',
      cellEditorParams: { values: ['', ...suppliers.map(s => s.name)] },
      cellClass: 'text-xs text-gray-300',
      valueFormatter: ({ value }) => value || '—',
      filter: ExcelSetFilter,
      headerTooltip: t('inventory.editHint', 'Double-click to edit'),
    },
  ], [t, suppliers]);

  const defaultColDef = useMemo<ColDef>(() => ({
    sortable: true,
    resizable: true,
    floatingFilter: true,
    // Wrap header labels onto a second line instead of truncating them with "…"
    // (the grid squeezes flex columns down to their minWidth, which was cutting
    // headers like "Qty in stock" / "Last purchase" / "Part Class").
    wrapHeaderText: true,
    autoHeaderHeight: true,
  }), []);

  const EDITABLE_FIELDS = ['unit_cost', 'min_quantity', 'supplier_name'];

  // Navigate on cell click, except on the inline-editable columns
  const onCellClicked = ({ data, colDef: col }: CellClickedEvent<StockItem>) => {
    if (data && !EDITABLE_FIELDS.includes(col.field ?? '')) navigate(`/inventory/${data.id}`);
  };

  const onCellValueChanged = async ({ data, colDef: col, newValue, oldValue }: CellValueChangedEvent<StockItem>) => {
    const field = col.field ?? '';
    if (!EDITABLE_FIELDS.includes(field) || newValue === oldValue) return;
    try {
      if (field === 'supplier_name') {
        const supplier = suppliers.find(s => s.name === newValue);
        await updateStockItem(data.id, { supplier_id: supplier?.id ?? null });
        data.supplier_id = supplier?.id ?? null;
      } else {
        await updateStockItem(data.id, { [field]: newValue });
      }
    } catch {
      (data as unknown as Record<string, unknown>)[field] = oldValue;
      gridRef.current?.api.refreshCells({ columns: [field], force: true });
    }
  };

  const exportCSV = () => gridRef.current?.api.exportDataAsCsv();

  const clearFilters = () =>
    setFilters({ search: '', category: '', warehouse: '', supplier_id: '', low_stock_only: false, limit: 5500, skip: 0 });

  const activeFilterCount = [
    filters.search, filters.category, filters.warehouse, filters.supplier_id,
  ].filter(Boolean).length + (filters.low_stock_only ? 1 : 0);

  return (
    <div className="flex flex-col bg-gray-950 text-gray-100">

      {/* ── Header ── */}
      <div className="px-6 pt-6 pb-4 border-b border-gray-800">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-600/20 rounded-lg border border-indigo-500/30">
              <Boxes size={22} className="text-indigo-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white tracking-tight">
                {t('nav.inventory', 'Inventory')}
              </h1>
              <p className="text-sm text-gray-400 mt-0.5">
                {t('inventory.subtitle', 'Parts & materials · Saint-Jérôme')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={exportCSV}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-300 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg transition-colors"
            >
              <Download size={14} /> Export CSV
            </button>
            <button
              onClick={() => navigate('/inventory/new')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
            >
              <Plus size={14} /> {t('inventory.newItem', 'New item')}
            </button>
          </div>
        </div>

        {/* ── KPI cards ── */}
        <div className="grid grid-cols-4 gap-3 mb-5">
          <KpiCard
            icon={<Package size={16} className="text-indigo-400" />}
            label={t('inventory.totalItems', 'Total items')}
            value={total.toLocaleString()}
            color="indigo"
          />
          <KpiCard
            icon={<AlertTriangle size={16} className="text-amber-400" />}
            label={t('inventory.lowStock', 'Low stock')}
            value={lowStockCount.toLocaleString()}
            color="amber"
            alert={lowStockCount > 0}
            onClick={() => setFilters(f => ({ ...f, low_stock_only: !f.low_stock_only }))}
            active={filters.low_stock_only}
          />
          <KpiCard
            icon={<TrendingDown size={16} className="text-red-400" />}
            label={t('inventory.zeroStock', 'Out of stock')}
            value={dashboard?.zero_stock_count?.toLocaleString() ?? '—'}
            color="red"
          />
          <KpiCard
            icon={<Boxes size={16} className="text-emerald-400" />}
            label={t('inventory.categories', 'Categories')}
            value={categories.length.toLocaleString()}
            color="emerald"
          />
        </div>

        {/* ── Search + filter bar ── */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1 max-w-md">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              className="w-full pl-9 pr-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors"
              placeholder={t('inventory.searchPlaceholder', 'Search by code, description…')}
              value={filters.search}
              onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
            />
          </div>

          <button
            onClick={() => setShowFilters(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm border rounded-lg transition-colors ${
              showFilters || activeFilterCount > 0
                ? 'bg-indigo-600/20 border-indigo-500/50 text-indigo-300'
                : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700'
            }`}
          >
            <Filter size={14} />
            {t('common.filter', 'Filters')}
            {activeFilterCount > 0 && (
              <span className="ml-1 bg-indigo-500 text-white text-xs px-1.5 py-0.5 rounded-full">
                {activeFilterCount}
              </span>
            )}
            <ChevronDown size={12} className={`transition-transform ${showFilters ? 'rotate-180' : ''}`} />
          </button>

          {activeFilterCount > 0 && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 px-2 py-2 text-xs text-gray-400 hover:text-gray-200 transition-colors"
            >
              <X size={13} /> Clear
            </button>
          )}

          <button
            onClick={load}
            className="p-2 text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>

          <span className="ml-auto text-xs text-gray-500">
            {total.toLocaleString()} {t('inventory.results', 'results')}
          </span>
        </div>

        {/* ── Expanded filters ── */}
        {showFilters && (
          <div className="mt-3 flex items-center gap-3 pt-3 border-t border-gray-800">
            <FilterSelect
              label={t('inventory.category', 'Category')}
              value={filters.category ?? ''}
              options={categories}
              onChange={v => setFilters(f => ({ ...f, category: v }))}
            />
            <FilterSelect
              label={t('inventory.warehouse', 'Warehouse')}
              value={filters.warehouse ?? ''}
              options={warehouses}
              onChange={v => setFilters(f => ({ ...f, warehouse: v }))}
            />
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 whitespace-nowrap">{t('inventory.supplier', 'Supplier')}:</span>
              <select
                value={filters.supplier_id ?? ''}
                onChange={e => setFilters(f => ({ ...f, supplier_id: e.target.value }))}
                className="bg-gray-800 border border-gray-700 text-sm text-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-indigo-500"
              >
                <option value="">All</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={filters.low_stock_only ?? false}
                onChange={e => setFilters(f => ({ ...f, low_stock_only: e.target.checked }))}
                className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-indigo-500 focus:ring-indigo-500"
              />
              {t('inventory.lowStockOnly', 'Low stock only')}
            </label>
          </div>
        )}
      </div>

      {/* ── AG Grid — viewport-sized so the horizontal scrollbar stays visible ── */}
      <div
        className="ag-theme-alpine-dark w-full"
        style={{ height: 'calc(100vh - 400px)', minHeight: 360 }}
      >
        <AgGridReact<StockItem>
          ref={gridRef}
          reactiveCustomComponents
          rowData={items}
          columnDefs={colDefs}
          defaultColDef={defaultColDef}
          animateRows
          rowSelection="single"
          onCellClicked={onCellClicked}
          onCellValueChanged={onCellValueChanged}
          rowClass="cursor-pointer"
          rowClassRules={{
            'ag-row-low-stock': (params) => params.data?.is_low_stock ?? false,
          }}
          overlayLoadingTemplate='<span class="text-gray-400 text-sm">Loading…</span>'
          overlayNoRowsTemplate='<span class="text-gray-500 text-sm">No items found</span>'
          getRowId={({ data }) => data.id}
          alwaysShowHorizontalScroll
          pagination
          paginationPageSize={100}
          paginationPageSizeSelector={[50, 100, 200, 500]}
        />
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function KpiCard({
  icon, label, value, color, alert, onClick, active,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: 'indigo' | 'amber' | 'red' | 'emerald';
  alert?: boolean;
  onClick?: () => void;
  active?: boolean;
}) {
  const colorMap = {
    indigo:  'border-indigo-800  bg-indigo-950/40',
    amber:   'border-amber-800   bg-amber-950/40',
    red:     'border-red-800     bg-red-950/40',
    emerald: 'border-emerald-800 bg-emerald-950/40',
  };
  return (
    <div
      onClick={onClick}
      className={`p-4 rounded-xl border transition-all ${colorMap[color]} ${
        onClick ? 'cursor-pointer hover:scale-[1.02]' : ''
      } ${active ? 'ring-1 ring-amber-500' : ''} ${alert && !active ? 'animate-pulse-subtle' : ''}`}
    >
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs text-gray-400">{label}</span>
      </div>
      <span className="text-2xl font-bold tracking-tight text-white">{value}</span>
    </div>
  );
}

function FilterSelect({
  label, value, options, onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 whitespace-nowrap">{label}:</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="bg-gray-800 border border-gray-700 text-sm text-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-indigo-500"
      >
        <option value="">All</option>
        {options.map(o => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  );
}
