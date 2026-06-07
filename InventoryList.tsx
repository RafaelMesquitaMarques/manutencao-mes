// frontend/src/pages/Inventory/InventoryList.tsx
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
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
  type StockItemFilters,
} from '../../api/inventory';
import type { StockItem, InventoryDashboard } from '../../types';

// ── Cell renderers ────────────────────────────────────────────────────────────

function QuantityCellRenderer({ data }: ICellRendererParams<StockItem>) {
  if (!data) return null;
  const qty = data.quantity;
  const min = data.min_quantity;
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
  const [showFilters, setShowFilters] = useState(false);

  const [filters, setFilters] = useState<StockItemFilters>({
    search: '',
    category: '',
    warehouse: '',
    low_stock_only: false,
    limit: 500,
    skip: 0,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, dash, cats] = await Promise.allSettled([
        fetchStockItems(filters),
        fetchInventoryDashboard(),
        fetchInventoryCategories(),
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
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  const colDefs = useMemo<ColDef<StockItem>[]>(() => [
    {
      field: 'code',
      headerName: t('inventory.code', 'N° Pièce'),
      width: 145,
      pinned: 'left',
      cellClass: 'font-mono text-xs text-indigo-300 font-semibold',
      filter: 'agTextColumnFilter',
    },
    {
      field: 'description',
      headerName: t('inventory.description', 'Description'),
      flex: 3,
      minWidth: 300,
      filter: 'agTextColumnFilter',
      cellClass: 'text-sm text-gray-200',
    },
    {
      field: 'category',
      headerName: t('inventory.category', 'Catégorie'),
      width: 160,
      cellRenderer: CategoryCellRenderer,
      filter: 'agTextColumnFilter',
    },
    {
      field: 'part_class',
      headerName: t('inventory.partClass', 'Classe'),
      width: 160,
      cellClass: 'text-xs text-gray-400',
      filter: 'agTextColumnFilter',
    },
    {
      field: 'quantity',
      headerName: t('inventory.quantity', 'Qté en stock'),
      width: 145,
      cellRenderer: QuantityCellRenderer,
      sort: 'asc',
      comparator: (a, b) => a - b,
    },
    {
      field: 'min_quantity',
      headerName: t('inventory.minQty', 'Qté min'),
      width: 100,
      cellClass: 'text-xs font-mono text-gray-400',
      valueFormatter: ({ value }) => (value != null ? String(value) : '—'),
    },
    {
      field: 'unit',
      headerName: t('inventory.unit', 'Unité'),
      width: 90,
      cellClass: 'text-xs text-gray-500',
    },
    {
      colId: 'location',
      headerName: t('inventory.location', 'Emplacement'),
      width: 160,
      cellRenderer: LocationCellRenderer,
    },
    {
      field: 'unit_cost',
      headerName: t('inventory.cost', 'Coût unit.'),
      width: 110,
      cellClass: 'text-xs font-mono text-gray-400',
      valueFormatter: ({ value }) =>
        value != null ? `$${Number(value).toFixed(2)}` : '—',
    },
  ], [t]);

  const defaultColDef = useMemo<ColDef>(() => ({
    sortable: true,
    resizable: true,
  }), []);

  const onRowClicked = ({ data }: { data?: StockItem }) => {
    if (data) navigate(`/inventory/${data.id}`);
  };

  const exportCSV = () => gridRef.current?.api.exportDataAsCsv();

  const clearFilters = () =>
    setFilters({ search: '', category: '', warehouse: '', low_stock_only: false, limit: 500, skip: 0 });

  const activeFilterCount = [
    filters.search, filters.category, filters.warehouse,
  ].filter(Boolean).length + (filters.low_stock_only ? 1 : 0);

  return (
    <div className="flex flex-col h-full bg-gray-950 text-gray-100">

      {/* ── Header ── */}
      <div className="px-6 pt-6 pb-4 border-b border-gray-800">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-600/20 rounded-lg border border-indigo-500/30">
              <Boxes size={22} className="text-indigo-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white tracking-tight">
                {t('nav.inventory', 'Inventaire')}
              </h1>
              <p className="text-sm text-gray-400 mt-0.5">
                {t('inventory.subtitle', 'Pièces & matériaux · Saint-Jérôme')}
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
              <Plus size={14} /> {t('inventory.newItem', 'Nouvelle pièce')}
            </button>
          </div>
        </div>

        {/* ── KPI cards ── */}
        <div className="grid grid-cols-4 gap-3 mb-5">
          <KpiCard
            icon={<Package size={16} className="text-indigo-400" />}
            label={t('inventory.totalItems', 'Total articles')}
            value={total.toLocaleString('fr-CA')}
            color="indigo"
          />
          <KpiCard
            icon={<AlertTriangle size={16} className="text-amber-400" />}
            label={t('inventory.lowStock', 'Stock faible')}
            value={lowStockCount.toLocaleString('fr-CA')}
            color="amber"
            alert={lowStockCount > 0}
            onClick={() => setFilters(f => ({ ...f, low_stock_only: !f.low_stock_only }))}
            active={filters.low_stock_only}
          />
          <KpiCard
            icon={<TrendingDown size={16} className="text-red-400" />}
            label={t('inventory.zeroStock', 'Rupture de stock')}
            value={dashboard?.zero_stock_count?.toLocaleString('fr-CA') ?? '—'}
            color="red"
          />
          <KpiCard
            icon={<Boxes size={16} className="text-emerald-400" />}
            label={t('inventory.categories', 'Catégories')}
            value={categories.length.toLocaleString('fr-CA')}
            color="emerald"
          />
        </div>

        {/* ── Search + filter bar ── */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1 max-w-md">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              className="w-full pl-9 pr-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors"
              placeholder={t('inventory.searchPlaceholder', 'Rechercher par code, description…')}
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
            {t('common.filters', 'Filtres')}
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
              <X size={13} /> Effacer
            </button>
          )}

          <button
            onClick={load}
            className="p-2 text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>

          <span className="ml-auto text-xs text-gray-500">
            {total.toLocaleString('fr-CA')} {t('inventory.results', 'résultats')}
          </span>
        </div>

        {/* ── Expanded filters ── */}
        {showFilters && (
          <div className="mt-3 flex items-center gap-3 pt-3 border-t border-gray-800">
            <FilterSelect
              label={t('inventory.category', 'Catégorie')}
              value={filters.category ?? ''}
              options={categories}
              onChange={v => setFilters(f => ({ ...f, category: v }))}
            />
            <FilterSelect
              label={t('inventory.warehouse', 'Entrepôt')}
              value={filters.warehouse ?? ''}
              options={warehouses}
              onChange={v => setFilters(f => ({ ...f, warehouse: v }))}
            />
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={filters.low_stock_only ?? false}
                onChange={e => setFilters(f => ({ ...f, low_stock_only: e.target.checked }))}
                className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-indigo-500 focus:ring-indigo-500"
              />
              {t('inventory.lowStockOnly', 'Stock faible uniquement')}
            </label>
          </div>
        )}
      </div>

      {/* ── AG Grid ── */}
      <div className="flex-1 ag-theme-alpine-dark overflow-hidden" style={{ minHeight: 0 }}>
        <AgGridReact<StockItem>
          ref={gridRef}
          rowData={items}
          columnDefs={colDefs}
          defaultColDef={defaultColDef}
          animateRows
          rowSelection="single"
          onRowClicked={onRowClicked}
          rowClass="cursor-pointer"
          rowClassRules={{
            'ag-row-low-stock': (params) => params.data?.is_low_stock ?? false,
          }}
          overlayLoadingTemplate='<span class="text-gray-400 text-sm">Chargement…</span>'
          overlayNoRowsTemplate='<span class="text-gray-500 text-sm">Aucune pièce trouvée</span>'
          loading={loading}
          suppressCellFocus
          getRowId={({ data }) => data.id}
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
        <option value="">Tous</option>
        {options.map(o => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  );
}
