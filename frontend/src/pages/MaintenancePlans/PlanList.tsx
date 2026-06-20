import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, Search, RefreshCw, CalendarClock, AlertTriangle, CheckCircle2, ListChecks } from 'lucide-react';
import { fetchMaintenancePlans, type PlanFilters } from '../../api/maintenancePlans';
import { fetchEquipment } from '../../api/workOrders';
import type { MaintenancePlan, Equipment, PmFrequency } from '../../types';
import Spinner from '../../components/ui/Spinner';
import { usePermission } from '../../hooks/usePermission';

const FREQUENCIES: PmFrequency[] = ['daily', 'weekly', 'monthly', 'quarterly', 'semiannual', 'annual'];

function formatFrequency(plan: MaintenancePlan, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!plan.frequency_type) return '—';
  const value = plan.frequency_value ?? 1;
  if (value <= 1) return t(`pmFrequency.${plan.frequency_type}`);
  return `${t('pm.every')} ${value} ${t(`pmFrequency.unit.${plan.frequency_type}`)}`;
}

const ALL = '';

export default function PlanList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canCreate = usePermission('pm_calendar', 'create');

  const [plans, setPlans] = useState<MaintenancePlan[]>([]);
  const [equipmentList, setEquipmentList] = useState<Equipment[]>([]);
  const [total, setTotal] = useState(0);
  const [overdueCount, setOverdueCount] = useState(0);
  const [dueThisWeek, setDueThisWeek] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState('');
  const [equipmentFilter, setEquipmentFilter] = useState('');
  const [frequencyFilter, setFrequencyFilter] = useState<PmFrequency | ''>(ALL);
  const [statusFilter, setStatusFilter] = useState<'true' | 'false' | ''>('true');

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const params: PlanFilters = { limit: 200 };
      if (search) params.search = search;
      if (equipmentFilter) params.equipment_id = equipmentFilter;
      if (frequencyFilter) params.frequency_type = frequencyFilter;
      if (statusFilter !== '') params.is_active = statusFilter === 'true';
      const data = await fetchMaintenancePlans(params);
      setPlans(data.items);
      setTotal(data.total);
      setOverdueCount(data.overdue_count);
      setDueThisWeek(data.due_this_week);
    } catch {
      setPlans([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [search, equipmentFilter, frequencyFilter, statusFilter]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetchEquipment().then(setEquipmentList).catch(() => {});
  }, []);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4 animate-fade-in p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('pm.plans')}</h1>
          <p className="text-gray-500 text-sm mt-1">{t('pm.plansSubtitle')}</p>
        </div>
        {canCreate && (
          <button onClick={() => navigate('/maintenance/plans/new')} className="btn-primary flex-shrink-0">
            <Plus size={16} />
            {t('pm.newPlan')}
          </button>
        )}
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="glass-card p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-500/15 flex items-center justify-center flex-shrink-0">
            <ListChecks size={18} className="text-blue-400" />
          </div>
          <div>
            <p className="text-gray-500 text-xs uppercase tracking-wide">{t('pm.totalPlans')}</p>
            <p className="text-2xl font-mono font-bold text-white">{total}</p>
          </div>
        </div>
        <div className="glass-card p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-red-500/15 flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={18} className="text-red-400" />
          </div>
          <div>
            <p className="text-gray-500 text-xs uppercase tracking-wide">{t('pm.overdueOccurrences')}</p>
            <p className="text-2xl font-mono font-bold text-red-400">{overdueCount}</p>
          </div>
        </div>
        <div className="glass-card p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center flex-shrink-0">
            <CalendarClock size={18} className="text-amber-400" />
          </div>
          <div>
            <p className="text-gray-500 text-xs uppercase tracking-wide">{t('pm.dueThisWeek')}</p>
            <p className="text-2xl font-mono font-bold text-amber-400">{dueThisWeek}</p>
          </div>
        </div>
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
          <select
            value={equipmentFilter}
            onChange={(e) => setEquipmentFilter(e.target.value)}
            className="select-field py-1.5 pr-8 text-xs min-w-[160px]"
          >
            <option value={ALL}>{t('pm.equipment')}: {t('common.all')}</option>
            {equipmentList.map((eq) => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
          </select>
          <select
            value={frequencyFilter}
            onChange={(e) => setFrequencyFilter(e.target.value as PmFrequency | '')}
            className="select-field py-1.5 pr-8 text-xs min-w-[140px]"
          >
            <option value={ALL}>{t('pm.frequency')}: {t('common.all')}</option>
            {FREQUENCIES.map((f) => <option key={f} value={f}>{t(`pmFrequency.${f}`)}</option>)}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'true' | 'false' | '')}
            className="select-field py-1.5 pr-8 text-xs min-w-[120px]"
          >
            <option value="true">{t('pm.active')}</option>
            <option value="false">{t('pm.inactive')}</option>
            <option value={ALL}>{t('common.all')}</option>
          </select>
          <button onClick={() => load(true)} disabled={refreshing} className="btn-secondary py-1.5 px-2.5 ml-auto">
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Spinner />
        </div>
      ) : plans.length === 0 ? (
        <div className="glass-card flex flex-col items-center py-16 gap-3">
          <CalendarClock size={40} className="text-gray-700" />
          <p className="text-gray-400 text-sm">{t('pm.noPlans')}</p>
          <button onClick={() => navigate('/maintenance/plans/new')} className="btn-primary gap-1.5 py-2 px-4 text-sm">
            <Plus size={15} />
            {t('pm.newPlan')}
          </button>
        </div>
      ) : (
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="text-left text-xs text-gray-600 font-medium px-4 py-3">{t('pm.name')}</th>
                <th className="text-left text-xs text-gray-600 font-medium px-4 py-3">{t('pm.equipment')}</th>
                <th className="text-left text-xs text-gray-600 font-medium px-4 py-3">{t('pm.frequency')}</th>
                <th className="text-left text-xs text-gray-600 font-medium px-4 py-3">{t('pm.nextDue')}</th>
                <th className="text-left text-xs text-gray-600 font-medium px-4 py-3">{t('pm.assignedTechnician')}</th>
                <th className="text-left text-xs text-gray-600 font-medium px-4 py-3">{t('common.priority')}</th>
                <th className="text-left text-xs text-gray-600 font-medium px-4 py-3">{t('pm.status')}</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => {
                const overdue = !!plan.next_due_date && plan.next_due_date < today && plan.is_active;
                return (
                  <tr
                    key={plan.id}
                    onClick={() => navigate(`/maintenance/plans/${plan.id}`)}
                    className="border-b border-white/[0.03] hover:bg-white/[0.02] cursor-pointer"
                  >
                    <td className="px-4 py-3">
                      <Link to={`/maintenance/plans/${plan.id}`} className="text-blue-400 hover:text-blue-300 font-medium" onClick={(e) => e.stopPropagation()}>
                        {plan.name}
                      </Link>
                      {plan.pm_template_name && <p className="text-gray-600 text-xs mt-0.5">{plan.pm_template_name}</p>}
                    </td>
                    <td className="px-4 py-3 text-gray-400">{plan.equipment_name ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-400">{formatFrequency(plan, t)}</td>
                    <td className="px-4 py-3">
                      {plan.next_due_date ? (
                        <span className={overdue ? 'text-red-400 font-medium' : 'text-gray-300'}>
                          {plan.next_due_date}
                        </span>
                      ) : <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-400">{plan.assigned_technician_name ?? t('pm.unassigned')}</td>
                    <td className="px-4 py-3 text-gray-400 capitalize">{plan.priority ? t(`priority.${plan.priority}`, plan.priority) : '—'}</td>
                    <td className="px-4 py-3">
                      {plan.is_active ? (
                        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-500/15 text-green-400">
                          <CheckCircle2 size={11} /> {t('pm.active')}
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/15 text-gray-400">
                          {t('pm.inactive')}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
