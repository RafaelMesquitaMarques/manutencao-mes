import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Boxes } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchJobOrders, fetchJobOrderCostReport } from '../../api/jobOrders';
import { fetchDepartments } from '../../api/departments';
import type { JobOrder, JobOrderCostRow } from '../../types';
import { useAuthStore } from '../../store/authStore';

const STATUS_STYLE: Record<string, string> = {
  pending:     'bg-gray-800 text-gray-300 border-gray-600',
  in_progress: 'bg-blue-900/50 text-blue-300 border-blue-700',
  completed:   'bg-green-900/50 text-green-300 border-green-700',
  cancelled:   'bg-red-900/50 text-red-400 border-red-700',
};
const ALL_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'];
const selectCls = 'bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 focus:outline-none focus:border-purple-500';
const inputCls  = 'bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 focus:outline-none focus:border-purple-500';

function fmtMoney(v: number, currency: string) {
  return `${currency} $${v.toFixed(2)}`;
}
function fmtHours(mins: number) {
  return `${(mins / 60).toFixed(1)} h`;
}

export default function JobOrderList() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const canCost = useAuthStore((s) => s.can);

  const [orders, setOrders] = useState<JobOrder[]>([]);
  const [costRows, setCostRows] = useState<JobOrderCostRow[]>([]);
  const [factoryTotal, setFactoryTotal] = useState(0);
  const [factoryMinutes, setFactoryMinutes] = useState(0);
  const [currency, setCurrency] = useState('CAD');
  const [deptOptions, setDeptOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const [filters, setFilters] = useState({ status: '', department: '', job_number: '' });

  const showCost = canCost('costs', 'view');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ofRes, costRes] = await Promise.all([
        fetchJobOrders({
          status:     filters.status     || undefined,
          department: filters.department || undefined,
          job_number: filters.job_number || undefined,
        }),
        fetchJobOrderCostReport({
          status:     filters.status     || undefined,
          department: filters.department || undefined,
        }),
      ]);
      setOrders(ofRes);
      setCostRows(costRes.items);
      setFactoryTotal(costRes.factory_total_cost);
      setFactoryMinutes(costRes.total_productive_minutes);
      setCurrency(costRes.currency);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  // Department filter follows the plant's managed department registry.
  useEffect(() => {
    fetchDepartments().then((ds) => setDeptOptions(ds.map((d) => d.name))).catch(() => {});
  }, []);

  const set = (k: string, v: string) => setFilters((f) => ({ ...f, [k]: v }));

  const costByOf = useMemo(() => {
    const m: Record<string, JobOrderCostRow> = {};
    costRows.forEach((r) => { m[r.job_order_id] = r; });
    return m;
  }, [costRows]);

  // Time-first: the OFs with the most productive machine time lead the list.
  const sortedOrders = useMemo(
    () => [...orders].sort((a, b) =>
      (costByOf[b.id]?.total_productive_minutes ?? 0) - (costByOf[a.id]?.total_productive_minutes ?? 0)),
    [orders, costByOf],
  );

  return (
    <div className="flex flex-col bg-gray-950 text-gray-100">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5 border-b border-gray-800">
        <div>
          <h1 className="text-xl font-semibold text-white flex items-center gap-2">
            <Boxes size={20} className="text-purple-400" />
            {t('jobOrders.title')}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {orders.length} {t('jobOrders.count')}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500 uppercase tracking-wider">{t('jobOrders.factoryTime')}</p>
          <p className="text-2xl font-bold text-sky-300 font-mono">{fmtHours(factoryMinutes)}</p>
          {showCost && <p className="text-xs text-emerald-400/80 font-mono mt-0.5">{fmtMoney(factoryTotal, currency)}</p>}
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-800 flex-wrap">
        <select value={filters.status} onChange={(e) => set('status', e.target.value)} className={selectCls}>
          <option value="">{t('jobOrders.allStatuses')}</option>
          {ALL_STATUSES.map((s) => <option key={s} value={s}>{t(`jobOrders.status_${s}`)}</option>)}
        </select>
        <select value={filters.department} onChange={(e) => set('department', e.target.value)} className={selectCls}>
          <option value="">{t('jobOrders.allDepartments')}</option>
          {deptOptions.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <input
          value={filters.job_number}
          onChange={(e) => set('job_number', e.target.value)}
          placeholder={t('jobOrders.searchNumber')}
          className={inputCls}
        />
        <button
          onClick={() => setFilters({ status: '', department: '', job_number: '' })}
          className="text-xs text-gray-500 hover:text-gray-300 px-2 py-2"
        >
          {t('common.clearFilters', 'Clear')}
        </button>
        <button onClick={load} className="ml-auto p-2 text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded-lg">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Table */}
      <div className="overflow-auto max-h-[calc(100vh-200px)]">
        {loading && orders.length === 0 ? (
          <div className="py-24 text-center text-gray-500">{t('common.loading', 'Loading…')}</div>
        ) : orders.length === 0 ? (
          <div className="py-24 text-center text-gray-500">{t('jobOrders.empty')}</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 uppercase tracking-wider">
                <th className="sticky top-0 z-10 bg-gray-900 border-b border-gray-800 px-4 py-3 text-left">{t('jobOrders.colNumber')}</th>
                <th className="sticky top-0 z-10 bg-gray-900 border-b border-gray-800 px-4 py-3 text-left">{t('jobOrders.colProduct')}</th>
                <th className="sticky top-0 z-10 bg-gray-900 border-b border-gray-800 px-4 py-3 text-center">{t('jobOrders.colStatus')}</th>
                <th className="sticky top-0 z-10 bg-gray-900 border-b border-gray-800 px-4 py-3 text-left">{t('jobOrders.colDepartment')}</th>
                <th className="sticky top-0 z-10 bg-gray-900 border-b border-gray-800 px-4 py-3 text-right">{t('jobOrders.colTime')}</th>
                <th className="sticky top-0 z-10 bg-gray-900 border-b border-gray-800 px-4 py-3 text-right">{t('jobOrders.colPieces')}</th>
                {showCost && <th className="sticky top-0 z-10 bg-gray-900 border-b border-gray-800 px-4 py-3 text-right">{t('jobOrders.colCost')}</th>}
              </tr>
            </thead>
            <tbody>
              {sortedOrders.map((of) => {
                const c = costByOf[of.id];
                return (
                  <tr
                    key={of.id}
                    onClick={() => navigate(`/job-orders/${of.id}`)}
                    className="border-b border-gray-800/60 hover:bg-gray-900/40 cursor-pointer"
                  >
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-purple-300">{of.job_number}</span>
                    </td>
                    <td className="px-4 py-3 text-gray-200">{of.product_name || '—'}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`px-2.5 py-0.5 rounded border text-xs font-medium ${STATUS_STYLE[of.status] ?? STATUS_STYLE.pending}`}>
                        {t(`jobOrders.status_${of.status}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-400">{of.department || '—'}</td>
                    <td className="px-4 py-3 text-right text-sky-300 font-mono text-sm font-semibold">{c ? fmtHours(c.total_productive_minutes) : '—'}</td>
                    <td className="px-4 py-3 text-right text-gray-400 font-mono text-xs">{c ? c.total_pieces : '—'}</td>
                    {showCost && (
                      <td className="px-4 py-3 text-right text-emerald-300/70 font-mono text-xs">
                        {c ? fmtMoney(c.total_cost, currency) : '—'}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
