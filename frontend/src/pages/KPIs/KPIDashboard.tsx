import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import ReactECharts from 'echarts-for-react';
import { Activity, Clock, CheckSquare, Gauge, Timer, Target, Zap, ShieldCheck } from 'lucide-react';
import {
  fetchKPISummary, fetchBacklog, fetchMTTR,
  fetchDowntimePareto, fetchOEETrend, fetchOEEByMachine, fetchEquipment,
} from '../../api/workOrders';
import type {
  KPISummary, BacklogData, MTTRItem, Equipment,
  DowntimeParetoItem, DowntimeParetoSub, OEETrendPoint, OEEByMachineItem,
} from '../../types';
import { humanHours } from '../../utils/duration';

const PERIOD_OPTIONS = [30, 90, 180];

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
  // Custom calendar range (ISO YYYY-MM-DD). When both are set they override the
  // day-preset period for every KPI query.
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const rangeActive = !!(customStart && customEnd && customStart <= customEnd);
  const [machines, setMachines] = useState<Equipment[]>([]);
  const [machineId, setMachineId] = useState<string>('');
  const [summary, setSummary] = useState<KPISummary | null>(null);
  const [backlog, setBacklog] = useState<BacklogData | null>(null);
  const [mttr, setMttr] = useState<MTTRItem[]>([]);
  const [pareto, setPareto] = useState<DowntimeParetoItem[]>([]);
  const [trend, setTrend] = useState<OEETrendPoint[]>([]);
  const [byMachine, setByMachine] = useState<OEEByMachineItem[]>([]);
  const [loading, setLoading] = useState(true);

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
    const range = rangeActive ? { start: customStart, end: customEnd } : undefined;
    Promise.allSettled([
      fetchKPISummary(period, mid, range),
      fetchBacklog(mid),
      fetchMTTR(period, mid, range),
      fetchDowntimePareto(period, mid, range),
      fetchOEETrend(period, mid, range),
      fetchOEEByMachine(period, range),
    ]).then(([s, b, m, p, tr, bm]) => {
      if (s.status === 'fulfilled') setSummary(s.value);
      if (b.status === 'fulfilled') setBacklog(b.value);
      if (m.status === 'fulfilled') setMttr(m.value);
      if (p.status === 'fulfilled') setPareto(p.value);
      if (tr.status === 'fulfilled') setTrend(tr.value);
      if (bm.status === 'fulfilled') setByMachine(bm.value);
      setLoading(false);
    });
  }, [period, machineId, rangeActive, customStart, customEnd]);

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

  // Downtime Pareto — classic form: descending bars (hours) + cumulative % line on
  // a secondary axis. Drill up/down the group → subgroup hierarchy.
  const pctOf = (mins: number, whole: number) => (whole > 0 ? Math.round((mins / whole) * 100) : 0);
  const anyDrillable = pareto.some((p) => (p.subcategories?.length ?? 0) > 0);

  // Localized subcategory name (falls back across locales, then to a generic label).
  const subName = (s: DowntimeParetoSub): string =>
    (lang === 'fr' ? s.name_fr : lang === 'es' ? s.name_es : s.name_en) || s.name || t('kpis.unspecified');

  type ParetoRow = { label: string; minutes: number; color: string };

  // Build a classic Pareto option from rows already sorted biggest-first.
  const paretoChart = (rows: ParetoRow[]) => {
    const total = rows.reduce((s, r) => s + r.minutes, 0) || 1;
    let run = 0;
    const cumulative = rows.map((r) => { run += r.minutes; return +((run / total) * 100).toFixed(1); });
    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (ps: { dataIndex: number }[]) => {
          const i = ps[0].dataIndex;
          const h = +(rows[i].minutes / 60).toFixed(1);
          return `${rows[i].label}<br/>${h} h · ${pctOf(rows[i].minutes, total)}%<br/>${t('kpis.cumulative')}: ${cumulative[i]}%`;
        },
      },
      legend: {
        data: [t('kpis.hours'), t('kpis.cumulative')],
        textStyle: { color: '#94a3b8' }, top: 0, itemWidth: 14, itemHeight: 8,
      },
      grid: { left: '3%', right: '3%', top: '16%', bottom: '2%', containLabel: true },
      xAxis: {
        type: 'category', data: rows.map((r) => r.label),
        axisLabel: { color: '#94a3b8', interval: 0, rotate: rows.length > 4 ? 32 : 0, width: 90, overflow: 'truncate', hideOverlap: false },
      },
      yAxis: [
        { type: 'value', axisLabel: { color: '#94a3b8', formatter: '{value}h' }, splitLine: { lineStyle: { color: '#1e293b' } } },
        { type: 'value', min: 0, max: 100, axisLabel: { color: '#94a3b8', formatter: '{value}%' }, splitLine: { show: false } },
      ],
      series: [
        {
          name: t('kpis.hours'), type: 'bar',
          data: rows.map((r) => ({ value: +(r.minutes / 60).toFixed(1), itemStyle: { color: r.color, borderRadius: [3, 3, 0, 0] } })),
        },
        {
          name: t('kpis.cumulative'), type: 'line', yAxisIndex: 1, data: cumulative,
          smooth: false, symbol: 'circle', symbolSize: 7,
          lineStyle: { color: '#cbd5e1', width: 2 }, itemStyle: { color: '#38bdf8' }, z: 3,
        },
      ],
    };
  };

  // ── Pareto #1 — primary categories (TPM buckets): planned / unplanned /
  // maintenance / uncategorized. Categories that share a type are summed. ──
  const TYPE_COLOR: Record<string, string> = {
    planned: '#3b82f6', unplanned: '#ef4444', maintenance: '#eab308', uncategorized: '#6b7280',
  };
  const typeLabel = (ty: string) =>
    ty === 'uncategorized' ? t('kpis.uncategorized') : t(`kpis.type_${ty}`, ty);
  const typeAgg: Record<string, number> = {};
  for (const c of pareto) {
    const key = c.type ?? 'uncategorized';
    typeAgg[key] = (typeAgg[key] ?? 0) + c.minutes;
  }
  const categoryRows: ParetoRow[] = Object.entries(typeAgg)
    .map(([ty, minutes]) => ({ label: typeLabel(ty), minutes, color: TYPE_COLOR[ty] ?? '#6b7280' }))
    .sort((a, b) => b.minutes - a.minutes);
  const categoryOption = paretoChart(categoryRows);

  // ── Pareto #2 — all subcategories flattened across every category, biggest
  // first, with one "unspecified" bucket for stops that carried no subcategory. ──
  const subRows: ParetoRow[] = [];
  let unspecified = 0;
  for (const c of pareto) {
    const subs = c.subcategories ?? [];
    for (const s of subs) subRows.push({ label: subName(s), minutes: s.minutes, color: s.color });
    unspecified += c.minutes - subs.reduce((sm, s) => sm + s.minutes, 0);
  }
  if (unspecified > 0) subRows.push({ label: t('kpis.unspecified'), minutes: unspecified, color: '#475569' });
  subRows.sort((a, b) => b.minutes - a.minutes);
  const subOption = paretoChart(subRows);

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
                onClick={() => { setPeriod(days); setCustomStart(''); setCustomEnd(''); }}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  period === days && !rangeActive
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {t('kpis.nDays', { days })}
              </button>
            ))}
          </div>
          {/* Custom calendar range — overrides the presets when both dates are set. */}
          <div className={`flex items-center gap-1.5 bg-[#0d1421] border rounded-lg px-2 py-1 ${rangeActive ? 'border-blue-500' : 'border-white/[0.06]'}`}>
            <input
              type="date"
              value={customStart}
              max={customEnd || undefined}
              onChange={(e) => setCustomStart(e.target.value)}
              title={t('kpis.from')}
              className="bg-transparent text-xs text-gray-200 focus:outline-none [color-scheme:dark]"
            />
            <span className="text-gray-600 text-xs">→</span>
            <input
              type="date"
              value={customEnd}
              min={customStart || undefined}
              onChange={(e) => setCustomEnd(e.target.value)}
              title={t('kpis.to')}
              className="bg-transparent text-xs text-gray-200 focus:outline-none [color-scheme:dark]"
            />
            {rangeActive && (
              <button
                onClick={() => { setCustomStart(''); setCustomEnd(''); }}
                title={t('common.clear', 'Clear')}
                className="text-gray-500 hover:text-gray-300 text-xs px-1"
              >
                ✕
              </button>
            )}
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
      </div>

      {/* OEE trend — full width */}
      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">{t('kpis.oeeTrend')}</h3>
        {trend.length === 0 ? <Empty /> : <ReactECharts option={trendOption} style={{ height: 320 }} theme="dark" />}
      </div>

      {/* Downtime Pareto #1 — primary categories (planned / unplanned / maintenance / uncategorized) */}
      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-1">{t('kpis.paretoByType')}</h3>
        <p className="text-xs text-gray-600 mb-3">{t('kpis.paretoByTypeSub')}</p>
        {categoryRows.length === 0 ? <Empty /> : <ReactECharts option={categoryOption} style={{ height: 360 }} theme="dark" />}
      </div>

      {/* Downtime Pareto #2 — subcategories */}
      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-1">{t('kpis.paretoBySub')}</h3>
        <p className="text-xs text-gray-600 mb-3">{t('kpis.paretoBySubSub')}</p>
        {subRows.length === 0 ? <Empty /> : <ReactECharts option={subOption} style={{ height: 420 }} theme="dark" />}
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
