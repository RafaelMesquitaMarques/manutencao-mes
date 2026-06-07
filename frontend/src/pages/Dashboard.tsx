import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ClipboardList,
  Play,
  AlertTriangle,
  CheckCircle2,
  ArrowRight,
  RefreshCw,
  Plus,
} from 'lucide-react';
import { fetchDashboardStats, fetchWorkOrders } from '../api/workOrders';
import type { DashboardStats, WorkOrder } from '../types';
import Badge from '../components/ui/Badge';
import Spinner from '../components/ui/Spinner';
import WOBarChart from '../components/charts/WOBarChart';
import WODonutChart from '../components/charts/WODonutChart';
import { useAutoRefresh } from '../hooks/useAutoRefresh';

interface KPICardProps {
  title: string;
  value: number | string;
  icon: React.ElementType;
  iconBg: string;
  iconColor: string;
  valueColor?: string;
}

const KPICard = ({ title, value, icon: Icon, iconBg, iconColor, valueColor = 'text-white' }: KPICardProps) => (
  <div className="glass-card p-5">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-gray-500 text-xs font-medium uppercase tracking-wide truncate">{title}</p>
        <p className={`text-3xl font-mono font-bold mt-2 ${valueColor}`}>{value}</p>
      </div>
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${iconBg}`}>
        <Icon size={20} className={iconColor} />
      </div>
    </div>
  </div>
);

const Dashboard = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recentWOs, setRecentWOs] = useState<WorkOrder[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async (silent = false) => {
    if (!silent) setIsLoading(true);
    const [statsResult, wosResult] = await Promise.allSettled([
      fetchDashboardStats(),
      fetchWorkOrders({ limit: '5' }),
    ]);
    if (statsResult.status === 'fulfilled') setStats(statsResult.value);
    if (wosResult.status === 'fulfilled') setRecentWOs(wosResult.value);
    if (!silent) setIsLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const { lastUpdatedAt, isRefreshing, hasError, manualRefresh } = useAutoRefresh(
    () => load(true),
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-3">
          <Spinner size="lg" />
          <p className="text-gray-500 text-sm">{t('common.loading')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('dashboard.title')}</h1>
          <p className="text-gray-500 text-sm mt-1">{t('dashboard.subtitle')}</p>
        </div>
        <div className="hidden sm:flex items-center gap-2">
          {hasError && <span className="text-xs text-amber-500">⚠ Last update failed</span>}
          {lastUpdatedAt && !hasError && (
            <span className="text-xs text-gray-600 font-mono">
              {lastUpdatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          <button onClick={manualRefresh} disabled={isRefreshing} className="btn-secondary py-1.5 px-3">
            <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 md:gap-4">
        <KPICard
          title={t('dashboard.openWOs')}
          value={stats?.total_open ?? 0}
          icon={ClipboardList}
          iconBg="bg-blue-500/15"
          iconColor="text-blue-400"
          valueColor="text-blue-400"
        />
        <KPICard
          title={t('dashboard.inProgress')}
          value={stats?.in_progress ?? 0}
          icon={Play}
          iconBg="bg-amber-500/15"
          iconColor="text-amber-400"
          valueColor="text-amber-400"
        />
        <KPICard
          title={t('dashboard.critical')}
          value={stats?.critical ?? 0}
          icon={AlertTriangle}
          iconBg="bg-red-500/15"
          iconColor="text-red-400"
          valueColor="text-red-400"
        />
        <KPICard
          title={t('dashboard.completedToday')}
          value={stats?.completed_today ?? 0}
          icon={CheckCircle2}
          iconBg="bg-green-500/15"
          iconColor="text-green-400"
          valueColor="text-green-400"
        />
      </div>

      {/* Charts */}
      <div className="grid lg:grid-cols-2 gap-4">
        <div className="glass-card p-5">
          <h2 className="text-white font-semibold text-sm mb-4">{t('dashboard.woByType')}</h2>
          {stats?.by_type && stats.by_type.length > 0 ? (
            <WOBarChart data={stats.by_type} />
          ) : (
            <div className="h-[210px] flex items-center justify-center text-gray-600 text-sm">
              {t('common.noData')}
            </div>
          )}
        </div>
        <div className="glass-card p-5">
          <h2 className="text-white font-semibold text-sm mb-4">{t('dashboard.woByStatus')}</h2>
          {stats?.by_status && stats.by_status.length > 0 ? (
            <WODonutChart data={stats.by_status} />
          ) : (
            <div className="h-[210px] flex items-center justify-center text-gray-600 text-sm">
              {t('common.noData')}
            </div>
          )}
        </div>
      </div>

      {/* Recent WOs */}
      <div className="glass-card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <h2 className="text-white font-semibold text-sm">{t('dashboard.recentWOs')}</h2>
          <Link
            to="/work-orders"
            className="flex items-center gap-1.5 text-blue-400 hover:text-blue-300 text-xs font-medium transition-colors"
          >
            {t('dashboard.viewAll')} <ArrowRight size={12} />
          </Link>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/[0.04]">
                <th className="table-header-cell">{t('workOrders.woNumber')}</th>
                <th className="table-header-cell">{t('workOrders.titleField')}</th>
                <th className="table-header-cell hidden md:table-cell">{t('workOrders.equipment')}</th>
                <th className="table-header-cell hidden lg:table-cell">{t('common.type')}</th>
                <th className="table-header-cell">{t('common.priority')}</th>
                <th className="table-header-cell">{t('common.status')}</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const woList: WorkOrder[] = Array.isArray(recentWOs)
                  ? recentWOs
                  : ((recentWOs as unknown as { items?: WorkOrder[] })?.items ?? []);
                return woList.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-14 text-center">
                      <ClipboardList size={36} className="mx-auto text-gray-700 mb-3" />
                      <p className="text-gray-500 text-sm mb-4">{t('workOrders.noResults')}</p>
                      <Link
                        to="/work-orders/new"
                        className="btn-primary inline-flex gap-1.5 py-2 px-4 text-sm"
                      >
                        <Plus size={15} />
                        {t('workOrders.createFirst')}
                      </Link>
                    </td>
                  </tr>
                ) : woList.map((wo) => (
                  <tr
                    key={wo.id}
                    className="table-row cursor-pointer"
                    onClick={() => navigate(`/work-orders/${wo.id}`)}
                  >
                    <td className="table-cell">
                      <span className="font-mono text-blue-400 text-xs">{wo.wo_number}</span>
                    </td>
                    <td className="table-cell max-w-[200px]">
                      <span className="truncate block text-gray-200">{wo.title}</span>
                    </td>
                    <td className="table-cell hidden md:table-cell text-gray-400">
                      {wo.equipment_name ?? '—'}
                    </td>
                    <td className="table-cell hidden lg:table-cell">
                      <Badge value={wo.type} variant="type" />
                    </td>
                    <td className="table-cell">
                      <Badge value={wo.priority} variant="priority" />
                    </td>
                    <td className="table-cell">
                      <Badge value={wo.status} variant="status" />
                    </td>
                  </tr>
                ));
              })()}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
