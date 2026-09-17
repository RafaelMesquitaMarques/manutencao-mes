/**
 * Supplier depth: monthly evolution, the same period a year earlier, spend
 * concentration, emergency vs planned buying and unit-price drift.
 *
 * Price drift only compares items that ARE comparable — the same stock item, or
 * an identical description. Two different parts are never put on the same scale.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactECharts from 'echarts-for-react';
import { ArrowUpDown, Info, PieChart, TrendingUp, Zap } from 'lucide-react';
import {
  fetchSupplierAnalysis, type CostSite, type SupplierAnalysis,
} from '../../api/costs';
import Spinner from '../../components/ui/Spinner';
import { Panel, Stat, compactMoney, money, signedMoney, varianceClass } from './shared';

export default function SupplierInsightsPanel({
  year, site, months, monthLabel, periodLabel, onPickSupplier,
}: {
  year: number;
  site: CostSite | null;
  months: number[];
  monthLabel: (slot: number) => string;
  periodLabel: string;
  onPickSupplier?: (supplier: string) => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<SupplierAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);

  const monthFrom = Math.min(...months);
  const monthTo = Math.max(...months);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchSupplierAnalysis({ year, site, month_from: monthFrom, month_to: monthTo }));
    } finally {
      setLoading(false);
    }
  }, [year, site, monthFrom, monthTo]);
  useEffect(() => { load(); }, [load]);

  const rows = data?.suppliers ?? [];
  const selected = useMemo(
    () => rows.find((r) => r.supplier === picked) ?? rows[0] ?? null, [rows, picked]);

  const evolutionOption = useMemo(() => {
    if (!selected) return null;
    const labels = months.map((m) => monthLabel(m));
    return {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis', valueFormatter: (v: number | null) => (v == null ? '—' : money(v)) },
      legend: { textStyle: { color: '#94a3b8' }, top: 0, itemWidth: 14, itemHeight: 8 },
      grid: { left: '3%', right: '4%', top: '18%', bottom: '4%', containLabel: true },
      xAxis: { type: 'category', data: labels, axisLabel: { color: '#94a3b8' } },
      yAxis: { type: 'value', axisLabel: { color: '#94a3b8', formatter: (v: number) => compactMoney(v) },
        splitLine: { lineStyle: { color: '#1e293b' } } },
      series: [
        { name: String(year), type: 'bar', barMaxWidth: 24,
          data: months.map((m) => Math.round(selected.monthly[m - 1] ?? 0)),
          itemStyle: { color: '#3b82f6', borderRadius: [4, 4, 0, 0] } },
        { name: String(data?.prev_year ?? year - 1), type: 'line', smooth: true,
          symbol: months.length === 1 ? 'circle' : 'none', symbolSize: 7,
          data: months.map((m) => Math.round(selected.prev_monthly[m - 1] ?? 0)),
          lineStyle: { color: '#64748b', width: 1.5 }, itemStyle: { color: '#64748b' } },
      ],
    };
  }, [selected, months, monthLabel, year, data]);

  if (loading) return <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>;
  if (!data) return null;

  const conc = data.concentration;
  const hasPrev = data.prev_total > 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Panel icon={<PieChart size={15} className="text-gray-500" />} title={t('costs.supConcentration')}
          subtitle={t('costs.supConcentrationSub')}>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 mt-1">
            <Stat label={t('costs.supTop3')} value={conc.top3_pct == null ? '—' : `${conc.top3_pct}%`} />
            <Stat label={t('costs.supTop5')} value={conc.top5_pct == null ? '—' : `${conc.top5_pct}%`} />
            <Stat label={t('costs.supCount')} value={String(conc.supplier_count)} />
            <Stat label="HHI" value={conc.hhi == null ? '—' : String(Math.round(conc.hhi))}
              hint={t('costs.supHhiHint')} />
            <Stat label={t('costs.supEmergency')}
              value={money(rows.reduce((s, r) => s + r.emergency, 0))}
              hint={t('costs.supEmergencyHint', { days: data.emergency_rule.lead_days })} />
            <Stat label={t('costs.supPlanned')} value={money(rows.reduce((s, r) => s + r.planned, 0))} />
          </div>
          <p className="text-[11px] text-gray-600 mt-3">{t('costs.supConcentrationNote')}</p>
        </Panel>

        <Panel className="xl:col-span-2" icon={<TrendingUp size={15} className="text-gray-500" />}
          title={t('costs.supEvolution', { supplier: selected?.supplier ?? '—' })}
          subtitle={hasPrev ? t('costs.supEvolutionSub', { prev: data.prev_year })
            : t('costs.supNoPrevYear', { prev: data.prev_year })}
          right={
            <select value={selected?.supplier ?? ''} onChange={(e) => setPicked(e.target.value)}
              className="input-field text-xs py-1.5 px-2 max-w-[220px]">
              {rows.map((r) => <option key={r.supplier} value={r.supplier}>{r.supplier}</option>)}
            </select>
          }>
          {!evolutionOption ? (
            <div className="flex items-center justify-center h-64 text-gray-600 text-sm">{t('common.noData')}</div>
          ) : (
            <>
              <div className="flex items-center gap-6 flex-wrap mb-1">
                <Stat label={periodLabel} value={money(selected?.total ?? 0)} />
                <Stat label={String(data.prev_year)} value={money(selected?.prev_total ?? 0)} />
                <Stat label={t('costs.supDelta')} value={signedMoney(selected?.delta ?? 0)}
                  valueClass={varianceClass(-(selected?.delta ?? 0))} />
                <Stat label={t('costs.committed')} value={money(selected?.committed ?? 0)} />
              </div>
              <ReactECharts option={evolutionOption} style={{ height: 260 }} theme="dark" notMerge />
            </>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel icon={<ArrowUpDown size={15} className="text-gray-500" />} title={t('costs.supYoY')}
          subtitle={t('costs.supYoYSub', { prev: data.prev_year })}>
          {rows.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-gray-600 text-sm">{t('common.noData')}</div>
          ) : (
            <div className="overflow-x-auto max-h-[320px]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[#0d1421]">
                  <tr className="border-b border-white/[0.06] text-gray-500 text-xs uppercase tracking-wider">
                    <th className="text-left py-2 pr-3 font-medium">{t('costs.supplier')}</th>
                    <th className="text-right py-2 px-3 font-medium">{periodLabel}</th>
                    <th className="text-right py-2 px-3 font-medium">{data.prev_year}</th>
                    <th className="text-right py-2 pl-3 font-medium">{t('costs.supDelta')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 25).map((r) => (
                    <tr key={r.supplier}
                      onClick={() => { setPicked(r.supplier); onPickSupplier?.(r.supplier); }}
                      className="border-b border-white/[0.03] hover:bg-white/[0.02] cursor-pointer">
                      <td className="py-2 pr-3 text-gray-200 truncate max-w-[200px]">{r.supplier}</td>
                      <td className="py-2 px-3 text-right font-mono text-gray-100">{money(r.total)}</td>
                      <td className="py-2 px-3 text-right font-mono text-gray-500">
                        {hasPrev ? money(r.prev_total) : '—'}
                      </td>
                      <td className={`py-2 pl-3 text-right font-mono ${
                        hasPrev ? varianceClass(-r.delta) : 'text-gray-600'}`}>
                        {hasPrev ? `${signedMoney(r.delta)}${r.delta_pct == null ? '' : ` (${r.delta_pct > 0 ? '+' : ''}${r.delta_pct}%)`}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel icon={<Zap size={15} className="text-gray-500" />} title={t('costs.supPriceDrift')}
          subtitle={t('costs.supPriceDriftSub')}>
          {data.price_drift.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-gray-600 text-sm gap-2">
              <span>{t('costs.supNoComparable')}</span>
              <span className="text-[11px] text-gray-700 flex items-center gap-1.5">
                <Info size={12} /> {t('costs.supPriceDriftRule')}
              </span>
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[320px]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[#0d1421]">
                  <tr className="border-b border-white/[0.06] text-gray-500 text-xs uppercase tracking-wider">
                    <th className="text-left py-2 pr-3 font-medium">{t('costs.supItem')}</th>
                    <th className="text-right py-2 px-3 font-medium">{t('costs.supFirstPrice')}</th>
                    <th className="text-right py-2 px-3 font-medium">{t('costs.supLastPrice')}</th>
                    <th className="text-right py-2 pl-3 font-medium">{t('costs.supChange')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.price_drift.map((p, i) => (
                    <tr key={`${p.item}-${i}`} className="border-b border-white/[0.03]">
                      <td className="py-2 pr-3 text-gray-300 truncate max-w-[220px]"
                        title={`${p.suppliers.join(', ')} · ${p.purchases}`}>
                        {p.item}
                        <span className="block text-[10px] text-gray-600">
                          {t(`costs.driftBasis_${p.basis}`)} · {p.purchases}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-gray-500">{money(p.first_price)}</td>
                      <td className="py-2 px-3 text-right font-mono text-gray-200">{money(p.last_price)}</td>
                      <td className={`py-2 pl-3 text-right font-mono ${
                        p.change_pct > 0 ? 'text-red-400' : 'text-green-400'}`}>
                        {p.change_pct > 0 ? '+' : ''}{p.change_pct}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
