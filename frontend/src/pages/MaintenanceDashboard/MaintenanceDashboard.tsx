import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Bell, Ticket, AlertTriangle, Clock, RefreshCw, BarChart2, Wrench, TrendingUp, Zap, Timer, CalendarClock, ListChecks, CheckCircle2, Percent, ArrowRight } from 'lucide-react';
import ReactECharts from 'echarts-for-react';
import { fetchMaintenanceDashboard } from '../../api/maintenance';
import { fetchPmDashboard } from '../../api/maintenancePlans';
import type { MaintenanceDashboardData, PmDashboard } from '../../types';
import Spinner from '../../components/ui/Spinner';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';
import api from '../../api/axios';

interface InterventionKpis {
  total_interventions: number;
  period_days: number;
  mttr_minutes: number | null;
  mtbf_hours: number | null;
  avg_response_time_minutes: number | null;
  avg_duration_minutes: number | null;
  avg_downtime_minutes: number | null;
  by_equipment: {
    equipment_id: string;
    name: string;
    intervention_count: number;
    avg_duration_minutes: number | null;
    avg_response_minutes: number | null;
  }[];
}

const CHART_TEXT   = '#9ca3af';
const CHART_LINE   = 'rgba(255,255,255,0.05)';

interface KPICardProps {
  title:      string;
  value:      number | string;
  icon:       React.ElementType;
  iconBg:     string;
  iconColor:  string;
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

function barOpts(
  data: { label: string; count: number }[],
  title: string,
  color = '#3b82f6',
): object {
  return {
    tooltip: { trigger: 'axis', backgroundColor: '#111827', borderColor: 'rgba(255,255,255,0.1)', textStyle: { color: '#e5e7eb' } },
    grid:    { left: 16, right: 16, top: 12, bottom: 40, containLabel: true },
    xAxis:   { type: 'category', data: data.map((d) => d.label), axisLabel: { color: CHART_TEXT, fontSize: 11 }, axisLine: { lineStyle: { color: CHART_LINE } }, splitLine: { show: false } },
    yAxis:   { type: 'value', axisLabel: { color: CHART_TEXT, fontSize: 11 }, splitLine: { lineStyle: { color: CHART_LINE } }, minInterval: 1 },
    series:  [{ data: data.map((d) => d.count), type: 'bar', barMaxWidth: 36, itemStyle: { color, borderRadius: [4, 4, 0, 0] }, label: { show: true, position: 'top', color: CHART_TEXT, fontSize: 10 } }],
  };
}

function donutOpts(
  data: { name: string; value: number }[],
  colors: string[],
): object {
  return {
    tooltip:  { trigger: 'item', backgroundColor: '#111827', borderColor: 'rgba(255,255,255,0.1)', textStyle: { color: '#e5e7eb' } },
    legend:   { orient: 'vertical', right: 16, top: 'center', textStyle: { color: CHART_TEXT, fontSize: 11 } },
    series: [{
      type:         'pie',
      radius:       ['45%', '70%'],
      center:       ['35%', '50%'],
      data,
      color:        colors,
      label:        { show: false },
      labelLine:    { show: false },
      emphasis:     { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.5)' } },
    }],
  };
}

const PIE_COLORS  = ['#3b82f6','#f59e0b','#10b981','#ef4444','#8b5cf6','#ec4899','#14b8a6','#f97316','#64748b'];

export default function MaintenanceDashboard() {
  const { t } = useTranslation();
  const [data, setData]       = useState<MaintenanceDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [kpiData, setKpiData] = useState<InterventionKpis | null>(null);
  const [kpiPeriod, setKpiPeriod] = useState<7 | 30 | 90>(30);
  const [pmData, setPmData] = useState<PmDashboard | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const d = await fetchMaintenanceDashboard();
      setData(d);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    api.get(`/api/maintenance/intervention-kpis?days=${kpiPeriod}`)
      .then(r => setKpiData(r.data))
      .catch(() => {});
  }, [kpiPeriod]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetchPmDashboard().then(setPmData).catch(() => {});
  }, []);

  const { lastUpdatedAt, isRefreshing, hasError, manualRefresh } = useAutoRefresh(
    () => load(true),
  );

  if (loading || !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-3">
          <Spinner size="lg" />
          <p className="text-gray-500 text-sm">{t('common.loading')}</p>
        </div>
      </div>
    );
  }

  const d = data;

  const byMachineData   = d.by_machine.map((x) => ({ label: x.machine, count: x.count }));
  const byTechData      = d.by_technician.map((x) => ({ label: x.technician, count: x.count }));
  const byEscalData     = d.by_escalation.map((x) => ({ label: x.level, count: x.count }));
  const problemTypePie  = d.by_problem_type.map((x, i) => ({ name: t(`problemType.${x.type}`, x.type), value: x.count, itemStyle: { color: PIE_COLORS[i % PIE_COLORS.length] } }));
  const ticketStatusPie = d.by_ticket_status.map((x, i) => ({ name: t(`ticketStatus.${x.status}`, x.status), value: x.count, itemStyle: { color: PIE_COLORS[i % PIE_COLORS.length] } }));

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <BarChart2 size={22} className="text-blue-400" />
            {t('maintenanceDash.title')}
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">{t('maintenanceDash.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {hasError && <span className="text-xs text-amber-500 hidden sm:inline">⚠ Last update failed</span>}
          {lastUpdatedAt && !hasError && (
            <span className="text-xs text-gray-600 font-mono hidden sm:inline">
              {lastUpdatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          <button onClick={manualRefresh} disabled={isRefreshing} className="btn-secondary py-1.5 px-3">
            <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 xl:grid-cols-5 gap-3 md:gap-4">
        <KPICard
          title={t('maintenanceDash.openAlerts')}
          value={d.open_alerts}
          icon={Bell}
          iconBg="bg-amber-500/15"
          iconColor="text-amber-400"
          valueColor="text-amber-400"
        />
        <KPICard
          title={t('maintenanceDash.openTickets')}
          value={d.open_tickets}
          icon={Ticket}
          iconBg="bg-blue-500/15"
          iconColor="text-blue-400"
          valueColor="text-blue-400"
        />
        <KPICard
          title={t('maintenanceDash.criticalTickets')}
          value={d.critical_tickets}
          icon={AlertTriangle}
          iconBg="bg-red-500/15"
          iconColor="text-red-400"
          valueColor="text-red-400"
        />
        <KPICard
          title={t('maintenanceDash.overdueAlerts')}
          value={d.overdue_alerts}
          icon={Clock}
          iconBg="bg-orange-500/15"
          iconColor="text-orange-400"
          valueColor="text-orange-400"
        />
        <KPICard
          title={t('maintenanceDash.avgResolution')}
          value={`${d.avg_resolution_hours}h`}
          icon={Clock}
          iconBg="bg-green-500/15"
          iconColor="text-green-400"
          valueColor="text-green-400"
        />
      </div>

      {/* Preventive Maintenance */}
      {pmData && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-white font-semibold flex items-center gap-2">
              <CalendarClock size={16} className="text-blue-400" />
              {t('pm.dashboardTitle')}
            </h2>
            <Link to="/maintenance/plans" className="text-blue-400 hover:text-blue-300 text-xs flex items-center gap-1">
              {t('pm.viewAllPlans')}
              <ArrowRight size={12} />
            </Link>
          </div>

          <div className="grid grid-cols-2 xl:grid-cols-6 gap-3 md:gap-4">
            <KPICard
              title={t('pm.totalPlans')}
              value={pmData.total_plans}
              icon={ListChecks}
              iconBg="bg-blue-500/15"
              iconColor="text-blue-400"
              valueColor="text-blue-400"
            />
            <KPICard
              title={t('pm.activePlans')}
              value={pmData.active_plans}
              icon={CheckCircle2}
              iconBg="bg-green-500/15"
              iconColor="text-green-400"
              valueColor="text-green-400"
            />
            <KPICard
              title={t('pm.overdueOccurrences')}
              value={pmData.overdue_occurrences}
              icon={AlertTriangle}
              iconBg="bg-red-500/15"
              iconColor="text-red-400"
              valueColor="text-red-400"
            />
            <KPICard
              title={t('pm.dueThisWeek')}
              value={pmData.due_this_week}
              icon={CalendarClock}
              iconBg="bg-amber-500/15"
              iconColor="text-amber-400"
              valueColor="text-amber-400"
            />
            <KPICard
              title={t('pm.completedThisMonth')}
              value={pmData.completed_this_month}
              icon={Wrench}
              iconBg="bg-purple-500/15"
              iconColor="text-purple-400"
              valueColor="text-purple-400"
            />
            <KPICard
              title={t('pm.complianceRate')}
              value={`${pmData.compliance_rate.toFixed(0)}%`}
              icon={Percent}
              iconBg="bg-sky-500/15"
              iconColor="text-sky-400"
              valueColor="text-sky-400"
            />
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <div className="glass-card p-5">
              <h3 className="text-white font-semibold text-sm mb-3">{t('pm.overdueOccurrences')}</h3>
              {pmData.overdue.length === 0 ? <Empty /> : (
                <div className="space-y-1.5">
                  {pmData.overdue.slice(0, 8).map((occ) => (
                    <Link
                      key={occ.id}
                      to={`/maintenance/plans/${occ.plan_id}`}
                      className="flex items-center justify-between text-sm bg-white/[0.02] hover:bg-white/[0.04] rounded px-3 py-2 transition-colors"
                    >
                      <span className="text-gray-300 truncate">
                        {occ.plan_name} · <span className="text-gray-500">{occ.equipment_name}</span>
                      </span>
                      <span className="text-red-400 text-xs font-mono flex-shrink-0 ml-2">
                        {occ.scheduled_date}{occ.days_late ? ` (${t('pm.daysLate', { count: occ.days_late })})` : ''}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
            <div className="glass-card p-5">
              <h3 className="text-white font-semibold text-sm mb-3">{t('pm.upcoming')}</h3>
              {pmData.upcoming.length === 0 ? <Empty /> : (
                <div className="space-y-1.5">
                  {pmData.upcoming.slice(0, 8).map((occ) => (
                    <Link
                      key={occ.id}
                      to={`/maintenance/plans/${occ.plan_id}`}
                      className="flex items-center justify-between text-sm bg-white/[0.02] hover:bg-white/[0.04] rounded px-3 py-2 transition-colors"
                    >
                      <span className="text-gray-300 truncate">
                        {occ.plan_name} · <span className="text-gray-500">{occ.equipment_name}</span>
                      </span>
                      <span className="text-gray-400 text-xs font-mono flex-shrink-0 ml-2">{occ.scheduled_date}</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Charts row 1 */}
      <div className="grid lg:grid-cols-2 gap-4">
        <div className="glass-card p-5">
          <h2 className="text-white font-semibold text-sm mb-4">{t('maintenanceDash.ticketsByMachine')}</h2>
          {byMachineData.length > 0 ? (
            <ReactECharts option={barOpts(byMachineData, 'Tickets by Machine', '#3b82f6')} style={{ height: 220 }} />
          ) : <Empty />}
        </div>
        <div className="glass-card p-5">
          <h2 className="text-white font-semibold text-sm mb-4">{t('maintenanceDash.alertsByProblemType')}</h2>
          {problemTypePie.length > 0 ? (
            <ReactECharts option={donutOpts(problemTypePie, PIE_COLORS)} style={{ height: 220 }} />
          ) : <Empty />}
        </div>
      </div>

      {/* Charts row 2 */}
      <div className="grid lg:grid-cols-2 gap-4">
        <div className="glass-card p-5">
          <h2 className="text-white font-semibold text-sm mb-4">{t('maintenanceDash.ticketsByTechnician')}</h2>
          {byTechData.length > 0 ? (
            <ReactECharts option={barOpts(byTechData, 'By Technician', '#10b981')} style={{ height: 220 }} />
          ) : <Empty />}
        </div>
        <div className="glass-card p-5">
          <h2 className="text-white font-semibold text-sm mb-4">{t('maintenanceDash.ticketsByStatus')}</h2>
          {ticketStatusPie.length > 0 ? (
            <ReactECharts option={donutOpts(ticketStatusPie, PIE_COLORS)} style={{ height: 220 }} />
          ) : <Empty />}
        </div>
      </div>

      {/* Escalation chart */}
      {byEscalData.length > 0 && (
        <div className="glass-card p-5">
          <h2 className="text-white font-semibold text-sm mb-4">{t('maintenanceDash.escalationByLevel')}</h2>
          <ReactECharts option={barOpts(byEscalData, 'Escalation', '#ef4444')} style={{ height: 200 }} />
        </div>
      )}

      {/* Intervention KPIs */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-white font-semibold flex items-center gap-2">
            <Wrench size={16} className="text-blue-400" />
            KPIs Interventions
          </h2>
          <div className="flex gap-1">
            {([7, 30, 90] as const).map(d => (
              <button
                key={d}
                onClick={() => setKpiPeriod(d)}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                  kpiPeriod === d
                    ? 'bg-blue-600 text-white'
                    : 'bg-white/[0.05] text-gray-400 hover:bg-white/[0.08]'
                }`}
              >{d}j</button>
            ))}
          </div>
        </div>

        {kpiData && (
          <>
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 md:gap-4">
              <KPICard
                title="MTTR (durée moy. réparation)"
                value={kpiData.mttr_minutes != null ? `${kpiData.mttr_minutes.toFixed(0)} min` : '—'}
                icon={Wrench}
                iconBg="bg-blue-500/15"
                iconColor="text-blue-400"
                valueColor="text-blue-400"
              />
              <KPICard
                title="MTBF (temps moy. entre pannes)"
                value={kpiData.mtbf_hours != null ? `${kpiData.mtbf_hours.toFixed(1)} h` : '—'}
                icon={TrendingUp}
                iconBg="bg-green-500/15"
                iconColor="text-green-400"
                valueColor="text-green-400"
              />
              <KPICard
                title="Temps de réponse moyen"
                value={kpiData.avg_response_time_minutes != null ? `${kpiData.avg_response_time_minutes.toFixed(0)} min` : '—'}
                icon={Zap}
                iconBg="bg-amber-500/15"
                iconColor="text-amber-400"
                valueColor="text-amber-400"
              />
              <KPICard
                title="Arrêt moyen par intervention"
                value={kpiData.avg_downtime_minutes != null ? `${kpiData.avg_downtime_minutes.toFixed(0)} min` : '—'}
                icon={Timer}
                iconBg="bg-red-500/15"
                iconColor="text-red-400"
                valueColor="text-red-400"
              />
            </div>

            {kpiData.by_equipment.length > 0 && (
              <div className="glass-card p-5">
                <h3 className="text-white font-semibold text-sm mb-4">Durée moy. par équipement (min)</h3>
                <ReactECharts
                  option={barOpts(
                    kpiData.by_equipment
                      .filter(e => e.avg_duration_minutes != null)
                      .map(e => ({ label: e.name, count: e.avg_duration_minutes! })),
                    'Avg Duration',
                    '#8b5cf6',
                  )}
                  style={{ height: 220 }}
                />
              </div>
            )}

            <p className="text-xs text-gray-600 text-right">
              {kpiData.total_interventions} interventions sur les {kpiPeriod} derniers jours
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Empty() {
  const { t } = useTranslation();
  return (
    <div className="h-[220px] flex items-center justify-center text-gray-600 text-sm">
      {t('common.noData')}
    </div>
  );
}
