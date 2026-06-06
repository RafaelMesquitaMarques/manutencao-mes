import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Cpu, MapPin, Clock, Gauge, AlertCircle, Calendar } from 'lucide-react';
import { fetchEquipmentById, fetchWorkOrders, fetchMaintenancePlans } from '../../api/workOrders';
import type { Equipment, WorkOrder, MaintenancePlan } from '../../types';
import { format } from 'date-fns';

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-green-500/15 text-green-400 border-green-500/20',
  in_maintenance: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
  stopped: 'bg-red-500/15 text-red-400 border-red-500/20',
  scrapped: 'bg-gray-500/15 text-gray-400 border-gray-500/20',
};

const WO_STATUS_COLORS: Record<string, string> = {
  open: 'bg-blue-500/15 text-blue-400',
  in_progress: 'bg-amber-500/15 text-amber-400',
  completed: 'bg-green-500/15 text-green-400',
  on_hold: 'bg-gray-500/15 text-gray-400',
  cancelled: 'bg-red-500/15 text-red-400',
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'text-red-400',
  high: 'text-orange-400',
  medium: 'text-amber-400',
  low: 'text-green-400',
};

type TabId = 'overview' | 'workorders' | 'plans';

export default function EquipmentDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabId>('overview');
  const [equipment, setEquipment] = useState<Equipment | null>(null);
  const [wos, setWOs] = useState<WorkOrder[]>([]);
  const [plans, setPlans] = useState<MaintenancePlan[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    Promise.allSettled([
      fetchEquipmentById(id),
      fetchWorkOrders({ equipment_id: id, limit: '50' }),
      fetchMaintenancePlans(id),
    ]).then(([eq, wo, pl]) => {
      if (eq.status === 'fulfilled') setEquipment(eq.value);
      if (wo.status === 'fulfilled') setWOs(wo.value);
      if (pl.status === 'fulfilled') setPlans(pl.value);
      setLoading(false);
    });
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500 text-sm">
        {t('common.loading')}
      </div>
    );
  }

  if (!equipment) {
    return (
      <div className="p-6 text-center text-gray-500">
        {t('equipment.notFound')}
      </div>
    );
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: 'overview', label: t('equipment.tabOverview') },
    { id: 'workorders', label: `${t('equipment.tabWorkOrders')} (${wos.length})` },
    { id: 'plans', label: `${t('equipment.tabPlans')} (${plans.length})` },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Back + Header */}
      <div>
        <button
          onClick={() => navigate('/equipment')}
          className="flex items-center gap-1.5 text-gray-500 hover:text-gray-300 text-sm mb-4 transition-colors"
        >
          <ArrowLeft size={15} />
          {t('equipment.title')}
        </button>

        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center flex-shrink-0">
              <Cpu size={24} className="text-blue-400" />
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold text-white">{equipment.name}</h1>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${STATUS_COLORS[equipment.status] ?? STATUS_COLORS.stopped}`}>
                  {equipment.status.replace('_', ' ')}
                </span>
              </div>
              <div className="flex items-center gap-4 mt-1">
                <span className="text-gray-500 text-sm font-mono">{equipment.code}</span>
                {equipment.location && (
                  <div className="flex items-center gap-1 text-gray-500 text-sm">
                    <MapPin size={13} />
                    {equipment.location}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Hour meter */}
          <div className="text-right">
            <div className="flex items-center gap-1.5 text-gray-400">
              <Gauge size={15} />
              <span className="text-sm">{t('equipment.hourMeter')}</span>
            </div>
            <p className="text-2xl font-bold text-white mt-0.5">
              {equipment.hour_meter.toLocaleString()}
              <span className="text-sm font-normal text-gray-500 ml-1">h</span>
            </p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-white/[0.06]">
        <div className="flex gap-0">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              onClick={() => setTab(tb.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                tab === tb.id
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              {tb.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Specs */}
          <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-300">{t('equipment.specifications')}</h3>
            <SpecRow label={t('equipment.manufacturer')} value={equipment.manufacturer} />
            <SpecRow label={t('equipment.model')} value={equipment.model} />
            <SpecRow label={t('equipment.serialNumber')} value={equipment.serial_number} />
            <SpecRow label={t('equipment.year')} value={equipment.manufacturing_year?.toString()} />
            <SpecRow label={t('equipment.criticality')} value={equipment.criticality} />
            {equipment.description && (
              <div className="pt-2 border-t border-white/[0.04]">
                <p className="text-xs text-gray-600 mb-1">{t('common.description')}</p>
                <p className="text-sm text-gray-300">{equipment.description}</p>
              </div>
            )}
          </div>

          {/* Quick stats */}
          <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
            <h3 className="text-sm font-semibold text-gray-300 mb-3">{t('equipment.stats')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <StatCard label={t('equipment.totalWOs')} value={String(wos.length)} icon={<AlertCircle size={16} className="text-blue-400" />} />
              <StatCard label={t('equipment.openWOs')} value={String(wos.filter((w) => w.status === 'open' || w.status === 'in_progress').length)} icon={<Clock size={16} className="text-amber-400" />} />
              <StatCard label={t('equipment.activePlans')} value={String(plans.length)} icon={<Calendar size={16} className="text-green-400" />} />
              <StatCard label={t('equipment.avgRepair')} value={`${(wos.filter((w) => w.repair_hours).reduce((a, w) => a + (w.repair_hours ?? 0), 0) / Math.max(wos.filter((w) => w.repair_hours).length, 1)).toFixed(1)}h`} icon={<Gauge size={16} className="text-purple-400" />} />
            </div>
          </div>
        </div>
      )}

      {tab === 'workorders' && (
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl overflow-hidden">
          {wos.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-gray-600 text-sm">
              {t('workOrders.noResults')}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  <th className="text-left text-xs text-gray-600 font-medium px-4 py-3">{t('workOrders.woNumber')}</th>
                  <th className="text-left text-xs text-gray-600 font-medium px-4 py-3">{t('workOrders.titleField')}</th>
                  <th className="text-left text-xs text-gray-600 font-medium px-4 py-3">{t('common.type')}</th>
                  <th className="text-left text-xs text-gray-600 font-medium px-4 py-3">{t('common.priority')}</th>
                  <th className="text-left text-xs text-gray-600 font-medium px-4 py-3">{t('common.status')}</th>
                  <th className="text-left text-xs text-gray-600 font-medium px-4 py-3">{t('workOrders.openedAt')}</th>
                </tr>
              </thead>
              <tbody>
                {wos.map((wo) => (
                  <tr key={wo.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <Link to={`/work-orders/${wo.id}`} className="text-blue-400 hover:text-blue-300 font-mono text-xs">
                        {wo.wo_number}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-gray-300 max-w-xs truncate">{wo.title}</td>
                    <td className="px-4 py-3 text-gray-400 capitalize">{wo.type}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium capitalize ${PRIORITY_COLORS[wo.priority] ?? 'text-gray-400'}`}>
                        {wo.priority}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${WO_STATUS_COLORS[wo.status] ?? 'text-gray-400'}`}>
                        {wo.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {format(new Date(wo.opened_at), 'MMM dd, yyyy')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'plans' && (
        <div className="space-y-3">
          {plans.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-gray-600 text-sm bg-[#0d1421] border border-white/[0.06] rounded-xl">
              {t('equipment.noPlans')}
            </div>
          ) : (
            plans.map((plan) => (
              <div key={plan.id} className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-white font-medium text-sm">{plan.name}</p>
                    {plan.description && (
                      <p className="text-gray-500 text-xs mt-0.5">{plan.description}</p>
                    )}
                    <div className="flex items-center gap-3 mt-2 text-xs text-gray-600">
                      <span>{plan.trigger_type}</span>
                      {plan.interval_days && <span>Every {plan.interval_days} days</span>}
                    </div>
                  </div>
                  {plan.next_execution_at && (
                    <div className="text-right">
                      <p className="text-xs text-gray-600">Next</p>
                      <p className="text-sm text-amber-400 font-medium">
                        {format(new Date(plan.next_execution_at), 'MMM dd, yyyy')}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SpecRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-white/[0.03] last:border-0">
      <span className="text-xs text-gray-600">{label}</span>
      <span className="text-sm text-gray-300">{value ?? '—'}</span>
    </div>
  );
}

function StatCard({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="bg-white/[0.02] rounded-lg p-3">
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <span className="text-xs text-gray-600">{label}</span>
      </div>
      <p className="text-lg font-bold text-white">{value}</p>
    </div>
  );
}
