import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactECharts from 'echarts-for-react';
import {
  Activity, Clock, Timer, Gauge, DollarSign, AlertTriangle,
  ClipboardList, CheckSquare, PhoneCall, Factory,
} from 'lucide-react';
import { fetchEquipment } from '../../api/workOrders';
import { fetchMachineReport, fetchMachineComparison } from '../../api/reports';
import type { Equipment, MachineReportData, MachineCompareItem } from '../../types';
import { humanDuration } from '../../utils/duration';

const PERIOD_OPTIONS = [
  { value: 7, label: '7d' },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
  { value: 180, label: '180d' },
];

const COST_TYPE_LABELS: Record<string, string> = {
  labor: 'Labor',
  local_parts: 'Local Parts',
  external_parts: 'External Parts',
  contracts: 'Contracts',
  rentals: 'Rentals',
  other: 'Other',
  parts_used: 'Parts Used (stock)',
};

function fmtMinutes(min: number | null | undefined): string {
  if (min == null) return '—';
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function fmtPct(v: number | null | undefined): string {
  return v == null ? '—' : `${v}%`;
}

function fmtHours(v: number | null | undefined): string {
  if (v == null) return '—';
  if (v > 0 && v < 1) return `${Math.round(v * 60)} min`;
  return `${v}h`;
}

export default function MachineReport() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'report' | 'compare'>('report');
  const [period, setPeriod] = useState(30);
  const [machines, setMachines] = useState<Equipment[]>([]);
  const [machineId, setMachineId] = useState<string>('');
  const [report, setReport] = useState<MachineReportData | null>(null);
  const [compare, setCompare] = useState<MachineCompareItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Drive the report off the Equipment catalog (same list as the Equipment page).
    // Production machines only — auxiliary (utility) assets have no MES/OEE layer.
    fetchEquipment({ asset_type: 'production' }).then((items) => {
      const active = items.filter((e) => e.active).sort((a, b) => a.name.localeCompare(b.name));
      setMachines(active);
      if (active.length > 0) setMachineId((prev) => prev || active[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (tab !== 'report' || !machineId) return;
    setLoading(true);
    fetchMachineReport(machineId, period)
      .then(setReport)
      .catch(() => setReport(null))
      .finally(() => setLoading(false));
  }, [tab, machineId, period]);

  useEffect(() => {
    if (tab !== 'compare') return;
    setLoading(true);
    fetchMachineComparison(period)
      .then((r) => setCompare(r.items))
      .catch(() => setCompare([]))
      .finally(() => setLoading(false));
  }, [tab, period]);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('machineReport.title')}</h1>
          <p className="text-gray-500 text-sm mt-0.5">{t('machineReport.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* Tabs */}
          <div className="flex gap-1 bg-[#0d1421] border border-white/[0.06] rounded-lg p-1">
            <button
              onClick={() => setTab('report')}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                tab === 'report' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {t('machineReport.tabReport')}
            </button>
            <button
              onClick={() => setTab('compare')}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                tab === 'compare' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {t('machineReport.tabCompare')}
            </button>
          </div>
          {/* Machine selector */}
          {tab === 'report' && (
            <select
              value={machineId}
              onChange={(e) => setMachineId(e.target.value)}
              className="bg-[#0d1421] border border-white/[0.06] rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
            >
              {machines.length === 0 && <option value="">{t('machineReport.noMachines')}</option>}
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}{m.code ? ` (${m.code})` : ''}
                </option>
              ))}
            </select>
          )}
          {/* Period */}
          <div className="flex gap-1 bg-[#0d1421] border border-white/[0.06] rounded-lg p-1">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPeriod(opt.value)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  period === opt.value ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {tab === 'report'
        ? <ReportView report={report} loading={loading} />
        : <CompareView items={compare} loading={loading} />}
    </div>
  );
}

// ─── Single machine report ─────────────────────────────────────────────────────

function ReportView({ report, loading }: { report: MachineReportData | null; loading: boolean }) {
  const { t } = useTranslation();

  const trendOption = useMemo(() => {
    if (!report) return {};
    const dates = Array.from(
      new Set([
        ...report.availability.trend.map((p) => p.date),
        ...report.oee.trend.map((p) => p.date),
      ]),
    ).sort();
    const availByDate = Object.fromEntries(report.availability.trend.map((p) => [p.date, p.pct]));
    const oeeByDate = Object.fromEntries(report.oee.trend.map((p) => [p.date, p.pct]));
    return {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis' },
      legend: { top: 0, textStyle: { color: '#94a3b8' } },
      grid: { left: '3%', right: '3%', top: 32, bottom: '8%', containLabel: true },
      xAxis: {
        type: 'category',
        data: dates.map((d) => d.slice(5)),
        axisLabel: { color: '#94a3b8' },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        axisLabel: { color: '#94a3b8', formatter: '{value}%' },
        splitLine: { lineStyle: { color: '#1e293b' } },
      },
      series: [
        {
          name: t('machineReport.availability'),
          type: 'line',
          smooth: true,
          showSymbol: false,
          data: dates.map((d) => availByDate[d] ?? null),
          lineStyle: { color: '#22c55e', width: 2 },
          itemStyle: { color: '#22c55e' },
        },
        {
          name: 'OEE',
          type: 'line',
          smooth: true,
          showSymbol: false,
          data: dates.map((d) => oeeByDate[d] ?? null),
          lineStyle: { color: '#3b82f6', width: 2 },
          itemStyle: { color: '#3b82f6' },
        },
      ],
    };
  }, [report, t]);

  const paretoOption = useMemo(() => {
    if (!report) return {};
    const items = report.downtime.pareto.slice(0, 10).reverse();
    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: { name: string; value: number; dataIndex: number }[]) => {
          const p = params[0];
          const item = items[p.dataIndex];
          return `${p.name}<br/>${fmtMinutes(p.value)} · ${item.count}×`;
        },
      },
      grid: { left: '3%', right: '10%', top: '5%', bottom: '5%', containLabel: true },
      xAxis: { type: 'value', axisLabel: { color: '#94a3b8' }, splitLine: { lineStyle: { color: '#1e293b' } } },
      yAxis: { type: 'category', data: items.map((i) => i.category), axisLabel: { color: '#94a3b8' } },
      series: [{
        type: 'bar',
        data: items.map((i) => ({ value: i.minutes, itemStyle: { color: i.color, borderRadius: [0, 4, 4, 0] } })),
        label: {
          show: true,
          position: 'right',
          color: '#cbd5e1',
          formatter: (p: { value: number }) => fmtMinutes(p.value),
        },
      }],
    };
  }, [report]);

  const subParetoOption = useMemo(() => {
    if (!report) return {};
    const items = (report.downtime.sub_pareto ?? []).slice(0, 10).reverse();
    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: { name: string; value: number; dataIndex: number }[]) => {
          const p = params[0];
          const item = items[p.dataIndex];
          return `${p.name}<br/>${fmtMinutes(p.value)} · ${item.count}×`;
        },
      },
      grid: { left: '3%', right: '10%', top: '5%', bottom: '5%', containLabel: true },
      xAxis: { type: 'value', axisLabel: { color: '#94a3b8' }, splitLine: { lineStyle: { color: '#1e293b' } } },
      yAxis: { type: 'category', data: items.map((i) => i.category), axisLabel: { color: '#94a3b8' } },
      series: [{
        type: 'bar',
        data: items.map((i) => ({ value: i.minutes, itemStyle: { color: i.color, borderRadius: [0, 4, 4, 0] } })),
        label: { show: true, position: 'right', color: '#cbd5e1', formatter: (p: { value: number }) => fmtMinutes(p.value) },
      }],
    };
  }, [report]);

  const costOption = useMemo(() => {
    if (!report) return {};
    return {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'item', formatter: '{b}: ${c} ({d}%)' },
      legend: { bottom: 0, left: 'center', textStyle: { color: '#94a3b8' }, itemWidth: 10, itemHeight: 10 },
      series: [{
        type: 'pie',
        radius: ['45%', '70%'],
        center: ['50%', '42%'],
        label: { show: false },
        emphasis: { label: { show: true, fontSize: 13, fontWeight: 'bold', color: '#fff' } },
        data: report.costs.by_type.map((c) => ({ name: COST_TYPE_LABELS[c.type] ?? c.type, value: c.total })),
        itemStyle: { borderRadius: 4, borderColor: '#0b1120', borderWidth: 2 },
      }],
    };
  }, [report]);

  if (loading) return <LoadingBlock />;
  if (!report) return <Empty label="No data" tall />;

  const availColor =
    report.availability.avg_pct == null ? 'gray'
      : report.availability.avg_pct >= report.machine.target_availability_pct ? 'green'
      : 'red';

  return (
    <>
      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <MetricCard
          icon={<Gauge size={18} />}
          label={t('machineReport.availability')}
          value={fmtPct(report.availability.avg_pct)}
          sub={`${t('machineReport.target')}: ${report.machine.target_availability_pct}%`}
          color={availColor}
        />
        <MetricCard
          icon={<Activity size={18} />}
          label="OEE"
          value={fmtPct(report.oee.avg_oee_pct)}
          sub={`P ${fmtPct(report.oee.avg_performance_pct)} · Q ${fmtPct(report.oee.avg_quality_pct)}`}
          color="blue"
        />
        <MetricCard
          icon={<Clock size={18} />}
          label="MTTR"
          value={fmtHours(report.mttr.hours)}
          sub={`${report.mttr.repairs} ${t('machineReport.repairs')}`}
          color="amber"
        />
        <MetricCard
          icon={<Timer size={18} />}
          label="MTBF"
          value={fmtHours(report.mtbf.hours)}
          sub={`${report.mtbf.failures} ${t('machineReport.failures')}`}
          color="purple"
        />
        <MetricCard
          icon={<AlertTriangle size={18} />}
          label={t('machineReport.downtime')}
          value={fmtMinutes(report.downtime.unplanned_minutes)}
          sub={`${report.downtime.stops_count} ${t('machineReport.stops')}`}
          color="red"
        />
        <MetricCard
          icon={<PhoneCall size={18} />}
          label={t('machineReport.responseTime')}
          value={fmtMinutes(report.interventions.avg_response_minutes)}
          sub={`${report.interventions.count} ${t('machineReport.interventions')}`}
          color="blue"
        />
        <MetricCard
          icon={<DollarSign size={18} />}
          label={t('machineReport.cost')}
          value={`$${report.costs.total.toLocaleString()}`}
          sub={t('machineReport.periodCost')}
          color="purple"
        />
        <MetricCard
          icon={<ClipboardList size={18} />}
          label={t('machineReport.backlog')}
          value={String(report.backlog.total)}
          sub={t('machineReport.openWOs')}
          color="amber"
        />
        <MetricCard
          icon={<CheckSquare size={18} />}
          label={t('machineReport.pmCompliance')}
          value={fmtPct(report.pm_compliance.pct)}
          sub={`${report.pm_compliance.on_time}/${report.pm_compliance.total} ${t('machineReport.onTime')}`}
          color="green"
        />
        <MetricCard
          icon={<Factory size={18} />}
          label={t('machineReport.ticketsOpened')}
          value={String(report.tickets.opened)}
          sub={`${t('machineReport.avgResolution')}: ${report.tickets.avg_resolution_seconds != null ? humanDuration(report.tickets.avg_resolution_seconds) : fmtHours(report.tickets.avg_resolution_hours)}`}
          color="gray"
        />
      </div>

      {/* Trend */}
      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">{t('machineReport.trendTitle')}</h3>
        {report.availability.trend.length === 0 && report.oee.trend.length === 0
          ? <Empty label={t('machineReport.noData')} />
          : <ReactECharts option={trendOption} style={{ height: 260 }} theme="dark" />}
      </div>

      {/* Downtime Paretos — by cause (category) and by subcategory */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-1">{t('machineReport.paretoTitle')}</h3>
          <p className="text-xs text-gray-600 mb-3">
            {t('machineReport.plannedDowntime')}: {fmtMinutes(report.downtime.planned_minutes)}
          </p>
          {report.downtime.pareto.length === 0
            ? <Empty label={t('machineReport.noData')} />
            : <ReactECharts option={paretoOption} style={{ height: 260 }} theme="dark" />}
        </div>
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-1">{t('machineReport.subParetoTitle')}</h3>
          <p className="text-xs text-gray-600 mb-3">{t('machineReport.subParetoSub')}</p>
          {(report.downtime.sub_pareto?.length ?? 0) === 0
            ? <Empty label={t('machineReport.noData')} />
            : <ReactECharts option={subParetoOption} style={{ height: 260 }} theme="dark" />}
        </div>
      </div>

      {/* Cost by type */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-1">{t('machineReport.costTitle')}</h3>
          <p className="text-xs text-gray-600 mb-3">
            Total: <span className="text-gray-300">${report.costs.total.toLocaleString()}</span>
          </p>
          {report.costs.by_type.length === 0
            ? <Empty label={t('machineReport.noData')} />
            : <ReactECharts option={costOption} style={{ height: 260 }} theme="dark" />}
        </div>
      </div>
    </>
  );
}

// ─── Comparison ────────────────────────────────────────────────────────────────

type CompareMetric = 'availability_pct' | 'oee_pct' | 'downtime_minutes' | 'mttr_hours'
  | 'mtbf_hours' | 'failures' | 'total_cost' | 'backlog_count' | 'avg_response_minutes';

const METRIC_DEFS: { key: CompareMetric; labelKey: string; worstFirst: 'asc' | 'desc'; fmt: (v: number | null) => string }[] = [
  { key: 'availability_pct',     labelKey: 'machineReport.availability',  worstFirst: 'asc',  fmt: fmtPct },
  { key: 'oee_pct',              labelKey: 'OEE',                          worstFirst: 'asc',  fmt: fmtPct },
  { key: 'downtime_minutes',     labelKey: 'machineReport.downtime',      worstFirst: 'desc', fmt: fmtMinutes },
  { key: 'mttr_hours',           labelKey: 'MTTR',                         worstFirst: 'desc', fmt: fmtHours },
  { key: 'mtbf_hours',           labelKey: 'MTBF',                         worstFirst: 'asc',  fmt: fmtHours },
  { key: 'failures',             labelKey: 'machineReport.failures',      worstFirst: 'desc', fmt: (v) => (v == null ? '—' : String(v)) },
  { key: 'total_cost',           labelKey: 'machineReport.cost',          worstFirst: 'desc', fmt: (v) => (v == null ? '—' : `$${v.toLocaleString()}`) },
  { key: 'backlog_count',        labelKey: 'machineReport.backlog',       worstFirst: 'desc', fmt: (v) => (v == null ? '—' : String(v)) },
  { key: 'avg_response_minutes', labelKey: 'machineReport.responseTime',  worstFirst: 'desc', fmt: fmtMinutes },
];

function CompareView({ items, loading }: { items: MachineCompareItem[]; loading: boolean }) {
  const { t } = useTranslation();
  const [metric, setMetric] = useState<CompareMetric>('availability_pct');

  const def = METRIC_DEFS.find((d) => d.key === metric)!;

  const sorted = useMemo(() => {
    const dir = def.worstFirst === 'desc' ? -1 : 1;
    return [...items].sort((a, b) => {
      const va = a[metric]; const vb = b[metric];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * dir;
    });
  }, [items, metric, def.worstFirst]);

  const chartOption = useMemo(() => {
    const data = [...sorted].reverse();
    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: { name: string; value: number }[]) =>
          `${params[0].name}: ${def.fmt(params[0].value ?? null)}`,
      },
      grid: { left: '3%', right: '10%', top: '5%', bottom: '5%', containLabel: true },
      xAxis: { type: 'value', axisLabel: { color: '#94a3b8' }, splitLine: { lineStyle: { color: '#1e293b' } } },
      yAxis: { type: 'category', data: data.map((i) => i.name), axisLabel: { color: '#94a3b8' } },
      series: [{
        type: 'bar',
        data: data.map((i) => i[metric]),
        itemStyle: { color: '#3b82f6', borderRadius: [0, 4, 4, 0] },
        label: {
          show: true,
          position: 'right',
          color: '#cbd5e1',
          formatter: (p: { value: number | null }) => def.fmt(p.value),
        },
      }],
    };
  }, [sorted, metric, def]);

  if (loading) return <LoadingBlock />;
  if (items.length === 0) return <Empty label={t('machineReport.noData')} tall />;

  return (
    <>
      {/* Metric picker */}
      <div className="flex flex-wrap gap-1 bg-[#0d1421] border border-white/[0.06] rounded-lg p-1 w-fit">
        {METRIC_DEFS.map((d) => (
          <button
            key={d.key}
            onClick={() => setMetric(d.key)}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              metric === d.key ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {d.labelKey.startsWith('machineReport.') ? t(d.labelKey) : d.labelKey}
          </button>
        ))}
      </div>

      {/* Ranking chart */}
      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">
          {t('machineReport.rankingBy')} {def.labelKey.startsWith('machineReport.') ? t(def.labelKey) : def.labelKey}
        </h3>
        <ReactECharts option={chartOption} style={{ height: Math.max(220, sorted.length * 36) }} theme="dark" />
      </div>

      {/* Full table */}
      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b border-white/[0.06]">
              <th className="px-4 py-3">{t('machineReport.machine')}</th>
              <th className="px-3 py-3">{t('machineReport.availability')}</th>
              <th className="px-3 py-3">OEE</th>
              <th className="px-3 py-3">{t('machineReport.downtime')}</th>
              <th className="px-3 py-3">{t('machineReport.stops')}</th>
              <th className="px-3 py-3">MTTR</th>
              <th className="px-3 py-3">MTBF</th>
              <th className="px-3 py-3">{t('machineReport.failures')}</th>
              <th className="px-3 py-3">{t('machineReport.cost')}</th>
              <th className="px-3 py-3">{t('machineReport.backlog')}</th>
              <th className="px-3 py-3">{t('machineReport.responseTime')}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((m) => (
              <tr key={m.machine_id} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                <td className="px-4 py-2.5">
                  <span className="text-gray-200 font-medium">{m.name}</span>
                  {m.code && <span className="text-gray-600 ml-1.5 text-xs">{m.code}</span>}
                </td>
                <td className={`px-3 py-2.5 font-medium ${
                  m.availability_pct == null ? 'text-gray-500'
                    : m.availability_pct >= m.target_availability_pct ? 'text-green-400' : 'text-red-400'
                }`}>
                  {fmtPct(m.availability_pct)}
                </td>
                <td className="px-3 py-2.5 text-gray-300">{fmtPct(m.oee_pct)}</td>
                <td className="px-3 py-2.5 text-gray-300">{fmtMinutes(m.downtime_minutes)}</td>
                <td className="px-3 py-2.5 text-gray-300">{m.stops_count}</td>
                <td className="px-3 py-2.5 text-gray-300">{fmtHours(m.mttr_hours)}</td>
                <td className="px-3 py-2.5 text-gray-300">{fmtHours(m.mtbf_hours)}</td>
                <td className="px-3 py-2.5 text-gray-300">{m.failures}</td>
                <td className="px-3 py-2.5 text-gray-300">${m.total_cost.toLocaleString()}</td>
                <td className="px-3 py-2.5 text-gray-300">{m.backlog_count}</td>
                <td className="px-3 py-2.5 text-gray-300">{fmtMinutes(m.avg_response_minutes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── Shared bits ───────────────────────────────────────────────────────────────

function MetricCard({ icon, label, value, sub, color }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  color: 'blue' | 'amber' | 'green' | 'purple' | 'red' | 'gray';
}) {
  const styles: Record<string, { bg: string; text: string }> = {
    blue:   { bg: 'bg-blue-500/10',   text: 'text-blue-400' },
    amber:  { bg: 'bg-amber-500/10',  text: 'text-amber-400' },
    green:  { bg: 'bg-green-500/10',  text: 'text-green-400' },
    purple: { bg: 'bg-purple-500/10', text: 'text-purple-400' },
    red:    { bg: 'bg-red-500/10',    text: 'text-red-400' },
    gray:   { bg: 'bg-gray-500/10',   text: 'text-gray-400' },
  };
  const s = styles[color];
  return (
    <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] text-gray-500 font-medium uppercase tracking-wide">{label}</p>
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${s.bg} ${s.text}`}>
          {icon}
        </div>
      </div>
      <p className="text-xl font-bold text-white">{value}</p>
      <p className="text-xs text-gray-600 mt-0.5">{sub}</p>
    </div>
  );
}

function LoadingBlock() {
  return (
    <div className="flex items-center justify-center h-64 text-gray-500 text-sm">
      <div className="animate-spin rounded-full h-6 w-6 border-2 border-blue-500 border-t-transparent mr-3" />
      Loading…
    </div>
  );
}

function Empty({ label, tall }: { label: string; tall?: boolean }) {
  return (
    <div className={`flex items-center justify-center ${tall ? 'h-64' : 'h-[220px]'} text-gray-600 text-sm`}>
      {label}
    </div>
  );
}
