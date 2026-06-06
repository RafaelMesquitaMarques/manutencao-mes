import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import ReactECharts from 'echarts-for-react';
import { Activity, Clock, CheckSquare, DollarSign } from 'lucide-react';
import { fetchKPISummary, fetchBacklog, fetchMTTR, fetchCostByType } from '../../api/workOrders';
import type { KPISummary, BacklogData, MTTRItem, CostItem } from '../../types';

const PERIOD_OPTIONS = [
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 180, label: '180 days' },
];

const COST_TYPE_LABELS: Record<string, string> = {
  labor: 'Labor',
  local_parts: 'Local Parts',
  external_parts: 'External Parts',
  contracts: 'Contracts',
  rentals: 'Rentals',
  other: 'Other',
};

export default function KPIDashboard() {
  const { t } = useTranslation();
  const [period, setPeriod] = useState(30);
  const [summary, setSummary] = useState<KPISummary | null>(null);
  const [backlog, setBacklog] = useState<BacklogData | null>(null);
  const [mttr, setMttr] = useState<MTTRItem[]>([]);
  const [costs, setCosts] = useState<CostItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.allSettled([
      fetchKPISummary(period),
      fetchBacklog(),
      fetchMTTR(period),
      fetchCostByType(period),
    ]).then(([s, b, m, c]) => {
      if (s.status === 'fulfilled') setSummary(s.value);
      if (b.status === 'fulfilled') setBacklog(b.value);
      if (m.status === 'fulfilled') setMttr(m.value);
      if (c.status === 'fulfilled') setCosts(c.value);
      setLoading(false);
    });
  }, [period]);

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
      data: costs.map((c) => ({
        name: COST_TYPE_LABELS[c.type] ?? c.type,
        value: c.total,
      })),
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

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('kpis.title')}</h1>
          <p className="text-gray-500 text-sm mt-0.5">{t('kpis.subtitle')}</p>
        </div>
        <div className="flex gap-1 bg-[#0d1421] border border-white/[0.06] rounded-lg p-1">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setPeriod(opt.value)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                period === opt.value
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          icon={<Clock size={20} className="text-blue-400" />}
          label={t('kpis.mttr')}
          value={loading ? '—' : `${summary?.mttr_hours ?? 0}h`}
          sub={t('kpis.avgRepair')}
          color="blue"
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

      {/* Charts Row */}
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
  color: 'blue' | 'amber' | 'green' | 'purple';
}) {
  const bg: Record<string, string> = {
    blue: 'bg-blue-500/10',
    amber: 'bg-amber-500/10',
    green: 'bg-green-500/10',
    purple: 'bg-purple-500/10',
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
  return (
    <div className="flex items-center justify-center h-[200px] text-gray-600 text-sm">
      No data available
    </div>
  );
}
