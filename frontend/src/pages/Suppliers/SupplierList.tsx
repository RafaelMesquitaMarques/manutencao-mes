import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2, Plus, Search, RefreshCw, Star, X,
  Package, ShoppingCart, TrendingDown, CheckCircle2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchSupplierList, fetchSupplierDashboard } from '../../api/suppliers';
import type { Supplier, SupplierDashboard } from '../../types';

const CATEGORIES = ['Parts', 'Tools', 'Raw Materials', 'Electrical', 'Safety', 'Services'];

function RatingStars({ rating }: { rating: number | null }) {
  if (!rating) return <span className="text-gray-600 text-xs">—</span>;
  return (
    <span className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(n => (
        <Star key={n} size={12} className={n <= rating ? 'text-amber-400 fill-amber-400' : 'text-gray-700'} />
      ))}
    </span>
  );
}

export default function SupplierList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [total, setTotal] = useState(0);
  const [dashboard, setDashboard] = useState<SupplierDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, dash] = await Promise.all([
        fetchSupplierList({ search: search || undefined, category: category || undefined, active_only: activeOnly, limit: 500 }),
        fetchSupplierDashboard(),
      ]);
      setSuppliers(list.items);
      setTotal(list.total);
      setDashboard(dash);
    } finally {
      setLoading(false);
    }
  }, [search, category, activeOnly]);

  useEffect(() => { load(); }, [load]);

  const clearFilters = () => { setSearch(''); setCategory(''); setActiveOnly(false); };
  const hasFilters = !!(search || category || activeOnly);

  return (
    <div className="flex flex-col bg-gray-950 text-gray-100">
      <div className="px-6 pt-6 pb-4 border-b border-gray-800">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-600/20 rounded-lg border border-purple-500/30">
              <Building2 size={22} className="text-purple-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white tracking-tight">{t('suppliers.title', 'Suppliers')}</h1>
              <p className="text-sm text-gray-400 mt-0.5">{t('suppliers.subtitle', 'Manage suppliers and purchase orders')}</p>
            </div>
          </div>
          <button
            onClick={() => navigate('/suppliers/new')}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white bg-purple-600 hover:bg-purple-500 rounded-lg transition-colors"
          >
            <Plus size={14} /> {t('suppliers.newSupplier', 'New Supplier')}
          </button>
        </div>

        {/* KPI cards */}
        <div className="grid grid-cols-4 gap-3 mb-5">
          <KpiCard icon={<Building2 size={16} className="text-purple-400" />} label={t('suppliers.totalSuppliers', 'Total suppliers')} value={dashboard?.total_suppliers.toLocaleString() ?? '—'} color="purple" />
          <KpiCard icon={<CheckCircle2 size={16} className="text-emerald-400" />} label={t('suppliers.activeSuppliers', 'Active')} value={dashboard?.active_suppliers.toLocaleString() ?? '—'} color="emerald" />
          <KpiCard icon={<ShoppingCart size={16} className="text-blue-400" />} label={t('suppliers.openPOs', 'Open POs')} value={dashboard?.open_purchase_orders.toLocaleString() ?? '—'} color="blue" onClick={() => navigate('/supplier-orders?status=draft')} />
          <KpiCard icon={<TrendingDown size={16} className="text-red-400" />} label={t('suppliers.lowStockLinked', 'Low stock w/ supplier')} value={dashboard?.low_stock_with_supplier.toLocaleString() ?? '—'} color="red" />
        </div>

        {/* Search + filters */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 max-w-sm">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              className="w-full pl-9 pr-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-purple-500"
              placeholder={t('suppliers.searchPlaceholder', 'Search by name, code, contact…')}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <select
            value={category}
            onChange={e => setCategory(e.target.value)}
            className="bg-gray-800 border border-gray-700 text-sm text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-purple-500"
          >
            <option value="">{t('common.all', 'All')} categories</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
            <input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)}
              className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-purple-500 focus:ring-purple-500" />
            {t('suppliers.activeOnly', 'Active only')}
          </label>
          {hasFilters && (
            <button onClick={clearFilters} className="flex items-center gap-1 px-2 py-2 text-xs text-gray-400 hover:text-gray-200">
              <X size={13} /> Clear
            </button>
          )}
          <button onClick={load} className="p-2 text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-lg">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
          <span className="ml-auto text-xs text-gray-500">{total.toLocaleString()} {t('suppliers.results', 'suppliers')}</span>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
              <th className="px-4 py-3 text-left font-medium">Code</th>
              <th className="px-4 py-3 text-left font-medium">{t('suppliers.name', 'Name')}</th>
              <th className="px-4 py-3 text-left font-medium">{t('suppliers.category', 'Category')}</th>
              <th className="px-4 py-3 text-left font-medium">{t('suppliers.contact', 'Contact')}</th>
              <th className="px-4 py-3 text-left font-medium">{t('suppliers.email', 'Email')}</th>
              <th className="px-4 py-3 text-center font-medium">{t('suppliers.leadTime', 'Lead time')}</th>
              <th className="px-4 py-3 text-center font-medium">{t('suppliers.rating', 'Rating')}</th>
              <th className="px-4 py-3 text-center font-medium">{t('suppliers.items', 'Items')}</th>
              <th className="px-4 py-3 text-center font-medium">{t('suppliers.status', 'Status')}</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {loading && suppliers.length === 0 ? (
              <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-500">{t('common.loading')}</td></tr>
            ) : suppliers.length === 0 ? (
              <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-500">{t('common.noData')}</td></tr>
            ) : suppliers.map(s => (
              <tr
                key={s.id}
                onClick={() => navigate(`/suppliers/${s.id}`)}
                className="border-b border-gray-800/50 hover:bg-gray-900/50 cursor-pointer transition-colors"
              >
                <td className="px-4 py-3 font-mono text-xs text-purple-300">{s.code || '—'}</td>
                <td className="px-4 py-3 font-medium text-white">{s.name}</td>
                <td className="px-4 py-3">
                  {s.category ? (
                    <span className="px-2 py-0.5 rounded text-xs border bg-gray-800 border-gray-600 text-gray-300">{s.category}</span>
                  ) : <span className="text-gray-600">—</span>}
                </td>
                <td className="px-4 py-3 text-gray-300">{s.contact_name || '—'}</td>
                <td className="px-4 py-3 text-gray-400 text-xs">{s.email || '—'}</td>
                <td className="px-4 py-3 text-center text-gray-300">
                  {s.lead_time_days != null ? `${s.lead_time_days}d` : '—'}
                </td>
                <td className="px-4 py-3 flex justify-center"><RatingStars rating={s.rating} /></td>
                <td className="px-4 py-3 text-center text-gray-400">{s.item_count ?? 0}</td>
                <td className="px-4 py-3 text-center">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${s.is_active ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-800' : 'bg-gray-800 text-gray-500 border border-gray-700'}`}>
                    {s.is_active ? t('suppliers.active', 'Active') : t('suppliers.inactive', 'Inactive')}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={e => { e.stopPropagation(); navigate(`/suppliers/${s.id}`); }}
                    className="text-xs text-gray-400 hover:text-white px-2 py-1 hover:bg-gray-800 rounded"
                  >
                    {t('common.view', 'View')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function KpiCard({ icon, label, value, color, onClick }: {
  icon: React.ReactNode; label: string; value: string;
  color: 'purple' | 'emerald' | 'blue' | 'red';
  onClick?: () => void;
}) {
  const cm = { purple: 'border-purple-800 bg-purple-950/40', emerald: 'border-emerald-800 bg-emerald-950/40', blue: 'border-blue-800 bg-blue-950/40', red: 'border-red-800 bg-red-950/40' };
  return (
    <div onClick={onClick} className={`p-4 rounded-xl border transition-all ${cm[color]} ${onClick ? 'cursor-pointer hover:scale-[1.02]' : ''}`}>
      <div className="flex items-center gap-2 mb-1">{icon}<span className="text-xs text-gray-400">{label}</span></div>
      <span className="text-2xl font-bold tracking-tight text-white">{value}</span>
    </div>
  );
}
