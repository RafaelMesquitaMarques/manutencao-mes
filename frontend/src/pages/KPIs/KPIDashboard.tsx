import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import ReactECharts from 'echarts-for-react';
import { Activity, Clock, CheckSquare, DollarSign, Gauge, Timer, Target, Zap, ShieldCheck } from 'lucide-react';
import {
  fetchKPISummary, fetchBacklog, fetchMTTR, fetchCostByType,
  fetchDowntimePareto, fetchOEETrend, fetchOEEByMachine, fetchEquipment,
} from '../../api/workOrders';
import type {
  KPISummary, BacklogData, MTTRItem, CostItem, Equipment,
  DowntimeParetoItem, OEETrendPoint, OEEByMachineItem,
} from '../../types';
import { humanHours } from '../../utils/duration';

const PERIOD_OPTIONS = [30, 90, 180];

// English fallbacks for cost transaction types (localized via t('costType.*')).
const COST_TYPE_FALLBACK: Record<string, string> = {
  labor: 'Labor',
  local_parts: 'Local Parts',
  external_parts: 'External Parts',
  contracts: 'Contracts',
  rentals: 'Rentals',
  other: 'Other',
  parts_used: 'Parts Used (stock)',
};

function fmtMttr(hours: number): string {
  return hours > 0 ? humanHours(hours) : '—';
}

// OEE/A/P/Q come back null until the plant records production — show "—", never a misleading 0.
const fmtPct = (v?: number | null): string => (v == null ? '—' : `${v}%`);

// Threshold colour for an OEE-style percentage (world-class ≈ 85, acceptable ≈ 65).
const oeeColor = (v?: number | null): string =>
  v == null ? '#475569' : v >= 85 ? '#22c55e' : v >= 65 ? '#f59e0b' : '#ef4444';

export default function KPIDashboard() {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || 'en').slice(0, 2);
  const [period, setPeriod] = useState(30);
  const [machines, setMachines] = useState<Equipment[]>([]);
  const [machineId, setMachineId] = useState<string>('');
  const [summary, setSummary] = useState<KPISummary | null>(null);
  const [backlog, setBacklog] = useState<BacklogData | null>(null);
  const [mttr, setMttr] = useState<MTTRItem[]>([]);
  const [costs, setCosts] = useState<CostItem[]>([]);
  const [pareto, setPareto] = useState<DowntimeParetoItem[]>([]);
  const [trend, setTrend] = useState<OEETrendPoint[]>([]);
  const [byMachine, setByMachine] = useState<OEEByMachineItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Localized stop-reason name for the Pareto chart (falls back across locales).
  const reasonName = (p: DowntimeParetoItem): string =>
    (lang === 'fr' ? p.name_fr : lang === 'es' ? p.name_es : p.name_en) || p.name || t('kpis.uncategorized');
  const costLabel = (type: string): string => t(`costType.${type}`, COST_TYPE_FALLBACK[type] ?? type);

  useEffect(() => {
    // Drive the picker off the Equipment catalog (production only) — same source as
    // the Equipment page and Machine Reports — so it has no duplicate/orphan or
    // no-longer-existing machine rows. KPI endpoints filter by equipment_id too.
    fetchEquipment({ asset_type: 'production', limit: '200' })
      .then((items) => setMachines(items.filter((e) => e.active).sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => setMachines([]));
  }, []);

  useEffect(() => {
    setLoading(true);
    const mid = machineId || undefined;
    Promise.allSettled([
      fetchKPISummary(period, mid),
      fetchBacklog(mid),
      fetchMTTR(period, mid),
      fetchCostByType(period, mid),
      fetchDowntimePareto(period, mid),
      fetchOEETrend(period, mid),
      fetchOEEByMachine(period),
    ]).then(([s, b, m, c, p, tr, bm]) => {
      if (s.status === 'fulfilled') setSummary(s.value);
      if (b.status === 'fulfilled') setBacklog(b.value);
      if (m.status === 'fulfilled') setMttr(m.value);
      if (c.status === 'fulfilled') setCosts(c.value);
      if (p.status === 'fulfilled') setPareto(p.value);
      if (tr.status === 'fulfilled') setTrend(tr.value);
      if (bm.status === 'fulfilled') setByMachine(bm.value);
      setLoading(false);
    });
  }, [period, machineId]);

  const backlogOption = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: '5%', right: '8%', top: '8%', bottom: '8%', containLabel: true },
    xAxis: { type: 'value', axisLabel: { color: '#94a3b8' }, splitLine: { lineStyle: { color: '#1e293b' } } },
    yAxis: {
      type: 'category',
      data: backlog?.buckets.map((b) => b.label) ?? [],
      axisLabel: { color: '#94a3b8' },
    },
    series: [{
      type: 'bar',
      data: backlog?.buckets.map((b) => b.count) ?? [],
      itemStyle: {
        color: (params: { dataIndex: number }) =>
          params.dataIndex === 0 ? '#22c55e' : params.dataIndex === 1 ? '#f59e0b' : '#ef4444',
        borderRadius: [0, 4, 4, 0],
      },
      label: { show: true, position: 'right', color: '#cbd5e1' },
    }],
  };

  const mttrOption = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: '{b}: {c} hrs' },
    grid: { left: '5%', right: '8%', top: '8%', bottom: '8%', containLabel: true },
    xAxis: { type: 'value', axisLabel: { color: '#94a3b8', formatter: '{value}h' }, splitLine: { lineStyle: { color: '#1e293b' } } },
    yAxis: {
      type: 'category',
      data: mttr.map((m) => m.code),
      axisLabel: { color: '#94a3b8' },
    },
    series: [{
      type: 'bar',
      data: mttr.map((m) => m.avg_repair_hours),
      itemStyle: { color: '#3b82f6', borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right', color: '#cbd5e1', formatter: '{c}h' },
    }],
  };

  const costTotal = costs.reduce((s, c) => s + c.total, 0);
  const costOption = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item', formatter: '{b}: ${c} ({d}%)' },
    legend: { bottom: '5%', left: 'center', textStyle: { color: '#94a3b8' }, itemWidth: 10, itemHeight: 10 },
    series: [{
      type: 'pie',
      radius: ['45%', '70%'],
      center: ['50%', '42%'],
      avoidLabelOverlap: true,
      label: { show: false },
      emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold', color: '#fff' } },
      data: costs.map((c) => ({ name: costLabel(c.type), value: c.total })),
      itemStyle: { borderRadius: 4, borderColor: '#0b1120', borderWidth: 2 },
    }],
  };

  const pmGaugeOption = {
    backgroundColor: 'transparent',
    series: [{
      type: 'gauge',
      startAngle: 200,
      endAngle: -20,
      min: 0,
      max: 100,
      radius: '88%',
      pointer: { show: false },
      progress: {
        show: true,
        overlap: false,
        roundCap: true,
        clip: false,
        itemStyle: {
          color: (summary?.pm_compliance_pct ?? 0) >= 80 ? '#22c55e' : (summary?.pm_compliance_pct ?? 0) >= 50 ? '#f59e0b' : '#ef4444',
        },
      },
      axisLine: { lineStyle: { width: 12, color: [[1, '#1e293b']] } },
      splitLine: { show: false },
      axisTick: { show: false },
      axisLabel: { show: false },
      data: [{ value: summary?.pm_compliance_pct ?? 0 }],
      title: { show: false },
      detail: {
        valueAnimation: true,
        fontSize: 28,
        fontWeight: 'bold',
        color: '#f1f5f9',
        formatter: '{value}%',
        offsetCenter: [0, '10%'],
      },
    }],
  };

  // OEE trend — OEE bold over its A/P/Q components.
  const trendOption = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', valueFormatter: (v: number | null) => (v == null ? '—' : `${v}%`) },
    legend: {
      data: [t('kpis.oee'), t('kpis.availability'), t('kpis.performance'), t('kpis.quality')],
      textStyle: { color: '#94a3b8' }, top: 0, itemWidth: 14, itemHeight: 8,
    },
    grid: { left: '3%', right: '4%', top: '16%', bottom: '6%', containLabel: true },
    xAxis: { type: 'category', data: trend.map((p) => p.date.slice(5)), axisLabel: { color: '#94a3b8' } },
    yAxis: { type: 'value', min: 0, max: 100, axisLabel: { color: '#94a3b8', formatter: '{value}%' }, splitLine: { lineStyle: { color: '#1e293b' } } },
    series: [
      { name: t('kpis.oee'), type: 'line', smooth: true, showSymbol: false, data: trend.map((p) => p.oee_pct), lineStyle: { width: 3 }, itemStyle: { color: '#6366f1' }, areaStyle: { opacity: 0.1 } },
      { name: t('kpis.availability'), type: 'line', smooth: true, showSymbol: false, data: trend.map((p) => p.availability_pct), itemStyle: { color: '#22c55e' } },
      { name: t('kpis.performance'), type: 'line', smooth: true, showSymbol: false, data: trend.map((p) => p.performance_pct), itemStyle: { color: '#3b82f6' } },
      { name: t('kpis.quality'), type: 'line', smooth: true, showSymbol: false, data: trend.map((p) => p.quality_pct), itemStyle: { color: '#f59e0b' } },
    ],
  };

  // Downtime Pareto — biggest loss reason on top; bars carry the category's own colour.
  const paretoRev = [...pareto].reverse();
  const paretoOption = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps: { name: string; value: number }[]) => `${ps[0].name}: ${ps[0].value} h` },
    grid: { left: '3%', right: '10%', top: '4%', bottom: '4%', containLabel: true },
    xAxis: { type: 'value', axisLabel: { color: '#94a3b8', formatter: '{value}h' }, splitLine: { lineStyle: { color: '#1e293b' } } },
    yAxis: { type: 'category', data: paretoRev.map(reasonName), axisLabel: { color: '#94a3b8' } },
    series: [{
      type: 'bar',
      data: paretoRev.map((p) => ({ value: +(p.minutes / 60).toFixed(1), itemStyle: { color: p.color, borderRadius: [0, 4, 4, 0] } })),
      label: { show: true, position: 'right', color: '#cbd5e1', formatter: '{c}h' },
    }],
  };

  // OEE by machine — worst first (only meaningful plant-wide).
  const bmFiltered = byMachine.filter((m) => m.oee_pct != null);
  const bmRev = [...bmFiltered].reverse();
  const byMachineOption = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: '{b}: {c}%' },
    grid: { left: '3%', right: '8%', top: '2%', bottom: '2%', containLabel: true },
    xAxis: { type: 'value', min: 0, max: 100, axisLabel: { color: '#94a3b8', formatter: '{value}%' }, splitLine: { lineStyle: { color: '#1e293b' } } },
    yAxis: { type: 'category', data: bmRev.map((m) => m.code || m.name), axisLabel: { color: '#94a3b8' } },
    series: [{
      type: 'bar',
      data: bmRev.map((m) => ({ value: m.oee_pct, itemStyle: { color: oeeColor(m.oee_pct), borderRadius: [0, 4, 4, 0] } })),
      label: { show: true, position: 'right', color: '#cbd5e1', formatter: '{c}%' },
    }],
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('kpis.title')}</h1>
          <p className="text-gray-500 text-sm mt-0.5">{t('kpis.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={machineId}
            onChange={(e) => setMachineId(e.target.value)}
            className="bg-[#0d1421] border border-white/[0.06] rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
          >
            <option value="">{t('kpis.allMachines')}</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}{m.code ? ` (${m.code})` : ''}
              </option>
            ))}
          </select>
          <div className="flex gap-1 bg-[#0d1421] border border-white/[0.06] rounded-lg p-1">
            {PERIOD_OPTIONS.map((days) => (
              <button
                key={days}
                onClick={() => setPeriod(days)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  period === days
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {t('kpis.nDays', { days })}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <KPICard
          icon={<Target size={20} className="text-indigo-400" />}
          label={t('kpis.oee')}
          value={loading ? '—' : fmtPct(summary?.oee_pct)}
          sub={t('kpis.oeeSub')}
          color="indigo"
        />
        <KPICard
          icon={<Gauge size={20} className="text-green-400" />}
          label={t('kpis.availability', 'Availability')}
          value={loading ? '—' : fmtPct(summary?.availability_pct)}
          sub={t('kpis.availabilitySub')}
          color="green"
        />
        <KPICard
          icon={<Zap size={20} className="text-blue-400" />}
          label={t('kpis.performance')}
          value={loading ? '—' : fmtPct(summary?.performance_pct)}
          sub={t('kpis.performanceSub')}
          color="blue"
        />
        <KPICard
          icon={<ShieldCheck size={20} className="text-amber-400" />}
          label={t('kpis.quality')}
          value={loading ? '—' : fmtPct(summary?.quality_pct)}
          sub={t('kpis.qualitySub')}
          color="amber"
        />
        <KPICard
          icon={<Timer size={20} className="text-cyan-400" />}
          label={t('kpis.mtbf', 'MTBF')}
          value={loading || summary?.mtbf_hours == null ? '—' : fmtMttr(summary.mtbf_hours)}
          sub={t('kpis.meanBetweenFailures', 'Mean time between failures')}
          color="blue"
        />
        <KPICard
          icon={<Clock size={20} className="text-blue-400" />}
          label={t('kpis.mttr')}
          value={loading ? '—' : fmtMttr(summary?.mttr_hours ?? 0)}
          sub={t('kpis.avgRepair')}
          color="blue"
        />
        <KPICard
          icon={<Clock size={20} className="text-yellow-400" />}
          label={t('kpis.mtta', 'Response time')}
          value={loading || summary?.mtta_minutes == null ? '—' : `${Math.round(summary.mtta_minutes)} min`}
          sub={t('kpis.avgResponse', 'Avg call → technician start')}
          color="amber"
        />
        <KPICard
          icon={<Activity size={20} className="text-amber-400" />}
          label={t('kpis.backlog')}
          value={loading ? '—' : String(summary?.backlog_count ?? 0)}
          sub={t('kpis.openWOs')}
          color="amber"
        />
        <KPICard
          icon={<CheckSquare size={20} className="text-green-400" />}
          label={t('kpis.pmCompliance')}
          value={loading ? '—' : `${summary?.pm_compliance_pct ?? 0}%`}
          sub={t('kpis.onTimeRate')}
          color="green"
        />
        <KPICard
          icon={<DollarSign size={20} className="text-purple-400" />}
          label={t('kpis.totalCost')}
          value={loading ? '—' : `$${(summary?.total_cost_cad ?? 0).toLocaleString()}`}
          sub={t('kpis.periodCost')}
          color="purple"
        />
      </div>

      {/* OEE row: trend + downtime Pareto */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4 lg:col-span-2">
          <h3 className="text-sm font-semibold text-gray-300 mb-3">{t('kpis.oeeTrend')}</h3>
          {trend.length === 0 ? <Empty /> : <ReactECharts option={trendOption} style={{ height: 260 }} theme="dark" />}
        </div>
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-1">{t('kpis.downtimePareto')}</h3>
          <p className="text-xs text-gray-600 mb-3">{t('kpis.downtimeParetoSub')}</p>
          {pareto.length === 0 ? <Empty /> : <ReactECharts option={paretoOption} style={{ height: 232 }} theme="dark" />}
        </div>
      </div>

      {/* OEE by machine — plant-wide only (redundant when one machine is selected) */}
      {!machineId && (
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-1">{t('kpis.oeeByMachine')}</h3>
          <p className="text-xs text-gray-600 mb-3">{t('kpis.oeeByMachineSub')}</p>
          {bmFiltered.length === 0
            ? <Empty />
            : <ReactECharts option={byMachineOption} style={{ height: Math.max(220, bmFiltered.length * 24) }} theme="dark" />}
        </div>
      )}

      {/* Maintenance charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Backlog by age */}
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3">{t('kpis.backlogByAge')}</h3>
          {!backlog || backlog.total === 0 ? (
            <Empty />
          ) : (
            <ReactECharts option={backlogOption} style={{ height: 200 }} theme="dark" />
          )}
        </div>

        {/* MTTR by equipment */}
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3">{t('kpis.mttrByEquipment')}</h3>
          {mttr.length === 0 ? (
            <Empty />
          ) : (
            <ReactECharts option={mttrOption} style={{ height: 200 }} theme="dark" />
          )}
        </div>

        {/* PM Compliance gauge */}
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3">{t('kpis.pmComplianceGauge')}</h3>
          <ReactECharts option={pmGaugeOption} style={{ height: 200 }} theme="dark" />
        </div>
      </div>

      {/* Cost chart */}
      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-1">{t('kpis.costByType')}</h3>
        <p className="text-xs text-gray-600 mb-3">
          {t('kpis.totalLabel')}: <span className="text-gray-300">${costTotal.toLocaleString()} CAD</span>
        </p>
        {costs.length === 0 ? (
          <Empty />
        ) : (
          <ReactECharts option={costOption} style={{ height: 280 }} theme="dark" />
        )}
      </div>
    </div>
  );
}

function KPICard({ icon, label, value, sub, color }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  color: 'blue' | 'amber' | 'green' | 'purple' | 'indigo';
}) {
  const bg: Record<string, string> = {
    blue: 'bg-blue-500/10',
    amber: 'bg-amber-500/10',
    green: 'bg-green-500/10',
    purple: 'bg-purple-500/10',
    indigo: 'bg-indigo-500/10',
  };
  return (
    <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">{label}</p>
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${bg[color]}`}>
          {icon}
        </div>
      </div>
      <p className="text-2xl font-bold text-white">{value}</p>
      <p className="text-xs text-gray-600 mt-1">{sub}</p>
    </div>
  );
}

function Empty() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-center h-[200px] text-gray-600 text-sm">
      {t('common.noData')}
    </div>
  );
}
