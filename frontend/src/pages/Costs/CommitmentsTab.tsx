/**
 * Purchase commitments — the investigable table behind the Committed (PO)
 * indicator. Only fields the purchase-order integration really carries are
 * shown; what it does not carry (invoice state, the asset or work order a PO
 * belongs to) is stated as missing instead of being invented.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import ReactECharts from 'echarts-for-react';
import {
  AlertTriangle, Clock, ExternalLink, Info, PackageCheck, Truck,
} from 'lucide-react';
import {
  fetchCostCommitments, type CostCommitments, type CostSite, type MonthMapEntry,
} from '../../api/costs';
import Spinner from '../../components/ui/Spinner';
import { Card, Panel, compactMoney, money } from './shared';

export default function CommitmentsTab({
  year, site, months, periodLabel, monthLabel, ccLabel,
}: {
  year: number;
  site: CostSite | null;
  months: number[];
  periodLabel: string;
  monthLabel: (slot: number) => string;
  ccLabel: (cc: string) => string;
}) {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || 'en').slice(0, 2);
  const [data, setData] = useState<CostCommitments | null>(null);
  const [loading, setLoading] = useState(true);
  const [includeReceived, setIncludeReceived] = useState(false);
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  const monthFrom = Math.min(...months);
  const monthTo = Math.max(...months);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchCostCommitments({
        year, site, month_from: monthFrom, month_to: monthTo, include_received: includeReceived,
      }));
    } finally {
      setLoading(false);
    }
  }, [year, site, monthFrom, monthTo, includeReceived]);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const all = data?.orders ?? [];
    return onlyFlagged
      ? all.filter((o) => o.overdue_days > 0 || o.partially_received || (o.age_days ?? 0) >= 60)
      : all;
  }, [data, onlyFlagged]);

  const ageingOption = useMemo(() => {
    const buckets = data?.ageing_buckets ?? [];
    return {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' },
        valueFormatter: (v: number) => money(v) },
      grid: { left: '3%', right: '4%', top: '10%', bottom: '4%', containLabel: true },
      xAxis: { type: 'category', axisLabel: { color: '#94a3b8', fontSize: 11 },
        data: buckets.map((b) => (b.to == null ? `${b.from}+` : `${b.from}–${b.to}`)) },
      yAxis: { type: 'value', axisLabel: { color: '#94a3b8', formatter: (v: number) => compactMoney(v) },
        splitLine: { lineStyle: { color: '#1e293b' } } },
      series: [{
        type: 'bar', barMaxWidth: 40,
        data: buckets.map((b, i) => ({
          value: Math.round(b.amount),
          itemStyle: { color: ['#10b981', '#3b82f6', '#f59e0b', '#ef4444'][i] ?? '#64748b',
            borderRadius: [4, 4, 0, 0] },
        })),
        label: { show: true, position: 'top', color: '#94a3b8', fontSize: 10,
          formatter: (p: { value: number }) => compactMoney(p.value) },
      }],
    };
  }, [data]);

  if (loading) return <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>;
  if (!data) return null;

  const fmtDate = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(lang) : '—');

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-2 text-xs text-gray-400">
          <input type="checkbox" checked={includeReceived} onChange={(e) => setIncludeReceived(e.target.checked)}
            className="accent-blue-500" />
          {t('costs.commIncludeReceived')}
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-400">
          <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)}
            className="accent-blue-500" />
          {t('costs.commOnlyFlagged')}
        </label>
        <span className="text-xs text-gray-600">{t('costs.commWindow', { period: periodLabel })}</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Card icon={<Truck size={20} className="text-cyan-400" />} label={t('costs.commOpenBalance')}
          value={money(data.totals.open)} sub={t('costs.commOrders', { count: data.totals.count })} color="cyan" />
        <Card icon={<PackageCheck size={20} className="text-blue-400" />} label={t('costs.commOrdered')}
          value={money(data.totals.ordered)} sub={periodLabel} color="blue" />
        <Card icon={<PackageCheck size={20} className="text-green-400" />} label={t('costs.commReceived')}
          value={money(data.totals.received)} sub={t('costs.commReceivedSub')} color="green" />
        <Card icon={<AlertTriangle size={20} className="text-red-400" />} label={t('costs.commOverdue')}
          value={money(data.totals.overdue)}
          sub={t('costs.commOverdueSub', { count: data.orders.filter((o) => o.overdue_days > 0).length })}
          color="red" valueClass={data.totals.overdue > 0 ? 'text-red-400' : 'text-gray-400'} />
        <Card icon={<Clock size={20} className="text-amber-400" />} label={t('costs.commOldest')}
          value={`${Math.max(0, ...data.orders.map((o) => o.age_days ?? 0))} ${t('costs.days')}`}
          sub={t('costs.commOldestSub')} color="amber" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel icon={<Clock size={15} className="text-gray-500" />} title={t('costs.commAgeing')}
          subtitle={t('costs.commAgeingSub')}>
          <ReactECharts option={ageingOption} style={{ height: 220 }} theme="dark" notMerge />
        </Panel>

        <Panel className="lg:col-span-2" icon={<Truck size={15} className="text-gray-500" />}
          title={t('costs.commTable')} subtitle={t('costs.commTableSub')}>
          {rows.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-gray-600 text-sm">{t('common.noData')}</div>
          ) : (
            <div className="overflow-x-auto max-h-[420px]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[#0d1421]">
                  <tr className="border-b border-white/[0.06] text-gray-500 text-xs uppercase tracking-wider">
                    <th className="text-left py-2 pr-3 font-medium">{t('costs.commPo')}</th>
                    <th className="text-left py-2 px-3 font-medium">{t('costs.supplier')}</th>
                    <th className="text-left py-2 px-3 font-medium">{t('costs.costCenter')}</th>
                    <th className="text-right py-2 px-3 font-medium">{t('costs.commOrdered')}</th>
                    <th className="text-right py-2 px-3 font-medium">{t('costs.commReceived')}</th>
                    <th className="text-right py-2 px-3 font-medium">{t('costs.commOpenBalance')}</th>
                    <th className="text-left py-2 px-3 font-medium">{t('costs.commExpected')}</th>
                    <th className="text-right py-2 pl-3 font-medium">{t('costs.commAge')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => (
                    <tr key={o.id} className={`border-b border-white/[0.03] hover:bg-white/[0.02] ${
                      o.overdue_days > 0 ? 'bg-red-500/[0.04]' : ''}`}>
                      <td className="py-2 pr-3">
                        <Link to={`/supplier-orders/${o.id}`}
                          className="text-blue-400 hover:text-blue-300 font-mono text-xs flex items-center gap-1">
                          {o.order_number} <ExternalLink size={10} />
                        </Link>
                        <span className="text-[10px] text-gray-600 uppercase">
                          {t(`poStatus.${o.status}`, o.status)} · {o.scope.toUpperCase()}
                          {o.site ? ` · ${o.site}` : ''}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-gray-300 truncate max-w-[160px]">{o.supplier}</td>
                      <td className="py-2 px-3 text-gray-400 text-xs truncate max-w-[150px]">
                        {o.cost_center ? ccLabel(o.cost_center) : '—'}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-gray-200">{money(o.ordered_amount)}</td>
                      <td className="py-2 px-3 text-right font-mono text-gray-400">
                        {money(o.received_amount)}
                        {o.partially_received && (
                          <span className="ml-1 text-[10px] text-amber-400">{t('costs.commPartial')}</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-cyan-300">{money(o.open_balance)}</td>
                      <td className="py-2 px-3 text-gray-400 text-xs">
                        {fmtDate(o.expected_date)}
                        {o.slot && <span className="text-gray-600 capitalize"> · {monthLabel(o.slot)}</span>}
                      </td>
                      <td className={`py-2 pl-3 text-right font-mono text-xs ${
                        o.overdue_days > 0 ? 'text-red-400' : 'text-gray-500'}`}>
                        {o.age_days ?? '—'}
                        {o.overdue_days > 0 && (
                          <span className="block text-[10px]">{t('costs.commLateBy', { days: o.overdue_days })}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[11px] text-gray-600 mt-2 flex items-start gap-1.5">
            <Info size={12} className="mt-0.5 flex-shrink-0" />
            {t('costs.commIntegrationNote')}
          </p>
        </Panel>
      </div>
    </div>
  );
}
