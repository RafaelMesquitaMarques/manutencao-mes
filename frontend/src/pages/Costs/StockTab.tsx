/**
 * Maintenance stock, read from the Inventory module.
 *
 * The accounting rule this tab exists to keep straight: buying a part, putting
 * it on the shelf and consuming it are ONE economic event seen three times. The
 * purchase is the expense that reaches the SAP ledger; the receipt is a stock
 * movement; the consumption is an internal reclass. The three figures are shown
 * side by side and never added together.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import ReactECharts from 'echarts-for-react';
import {
  AlertTriangle, Archive, Boxes, Info, PackageX, Timer, Zap,
} from 'lucide-react';
import {
  fetchInventoryAnalysis, type CostSite, type InventoryAnalysis,
} from '../../api/costs';
import Spinner from '../../components/ui/Spinner';
import { Card, Panel, compactMoney, money } from './shared';

export default function StockTab({ year, site, months, periodLabel }: {
  year: number;
  site: CostSite | null;
  months: number[];
  periodLabel: string;
}) {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || 'en').slice(0, 2);
  const [data, setData] = useState<InventoryAnalysis | null>(null);
  const [loading, setLoading] = useState(true);

  const monthFrom = Math.min(...months);
  const monthTo = Math.max(...months);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchInventoryAnalysis({ year, site, month_from: monthFrom, month_to: monthTo }));
    } finally {
      setLoading(false);
    }
  }, [year, site, monthFrom, monthTo]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>;
  if (!data) return null;

  const top = data.top_consumption.slice(0, 15);
  const consumptionOption = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => money(v) },
    grid: { left: '3%', right: '4%', top: '8%', bottom: '4%', containLabel: true },
    xAxis: { type: 'value', axisLabel: { color: '#94a3b8', formatter: (v: number) => compactMoney(v) },
      splitLine: { lineStyle: { color: '#1e293b' } } },
    yAxis: { type: 'category', inverse: true, axisLabel: { color: '#94a3b8', fontSize: 10, width: 150, overflow: 'truncate' },
      data: top.map((c) => c.item) },
    series: [{ type: 'bar', barMaxWidth: 16, data: top.map((c) => Math.round(c.value)),
      itemStyle: { color: '#8b5cf6', borderRadius: [0, 4, 4, 0] } }],
  };

  const fmtDate = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(lang) : '—');

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <Card icon={<Boxes size={20} className="text-blue-400" />} label={t('costs.stockValue')}
          value={money(data.stock_value)}
          sub={t('costs.stockValuedItems', { valued: data.valuation.valued_items, total: data.items_total })}
          color="blue" />
        <Card icon={<Archive size={20} className="text-purple-400" />} label={t('costs.stockConsumption')}
          value={money(data.consumption_value)} sub={periodLabel} color="purple" />
        <Card icon={<PackageX size={20} className="text-red-400" />} label={t('costs.stockStockouts')}
          value={data.has_min_levels ? String(data.stockout_count) : '—'}
          sub={data.has_min_levels ? t('costs.stockStockoutsSub') : t('costs.stockNoMinLevels')}
          color="red" valueClass={data.stockout_count ? 'text-red-400' : 'text-gray-400'} />
        <Card icon={<AlertTriangle size={20} className="text-amber-400" />} label={t('costs.stockCritical')}
          value={data.has_min_levels ? String(data.critical_count) : '—'}
          sub={data.has_min_levels ? t('costs.stockCriticalSub') : t('costs.stockNoMinLevels')}
          color="amber" valueClass={data.critical_count ? 'text-amber-400' : 'text-gray-400'} />
        <Card icon={<Timer size={20} className="text-gray-400" />} label={t('costs.stockDormant')}
          value={money(data.dormant_value)}
          sub={t('costs.stockDormantSub', { count: data.dormant_count, days: data.dormant_days })}
          color="gray" title={data.dormant_unvalued
            ? t('costs.stockDormantUnvalued', { count: data.dormant_unvalued })
            : undefined} />
        <Card icon={<Zap size={20} className="text-amber-400" />} label={t('costs.stockEmergency')}
          value={money(data.emergency_total)}
          sub={t('costs.stockEmergencySub', { days: data.emergency_rule.lead_days })} color="amber" />
      </div>

      {/* How these figures relate to the ledger — stated, not implied */}
      <div className="rounded-xl border border-white/[0.06] bg-[#0d1421] px-4 py-3">
        <p className="text-xs text-gray-400 flex items-start gap-2">
          <Info size={14} className="text-blue-400 mt-0.5 flex-shrink-0" />
          {t('costs.stockAccountingNote')}
        </p>
        {data.movement_rows === 0 && (
          <p className="text-xs text-amber-300/90 flex items-start gap-2 mt-1.5">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            {t('costs.stockNoMovements')}
          </p>
        )}
        {data.valuation.unvalued_items > data.valuation.valued_items && (
          <p className="text-xs text-amber-300/90 flex items-start gap-2 mt-1.5">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            {t('costs.stockValuationGap', {
              unvalued: data.valuation.unvalued_items, total: data.items_total })}
          </p>
        )}
        {!data.has_min_levels && (
          <p className="text-xs text-amber-300/90 flex items-start gap-2 mt-1.5">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            {t('costs.stockNoMinLevelsLong')}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel icon={<Archive size={15} className="text-gray-500" />} title={t('costs.stockTopConsumption')}
          subtitle={t('costs.stockTopConsumptionSub')}>
          {top.length === 0 ? (
            <div className="flex items-center justify-center h-64 text-gray-600 text-sm">{t('common.noData')}</div>
          ) : (
            <ReactECharts option={consumptionOption} style={{ height: 320 }} theme="dark" notMerge />
          )}
        </Panel>

        <Panel icon={<Boxes size={15} className="text-gray-500" />} title={t('costs.stockByEquipment')}
          subtitle={t('costs.stockByEquipmentSub')}>
          {data.by_equipment.length === 0 ? (
            <div className="flex items-center justify-center h-64 text-gray-600 text-sm">{t('common.noData')}</div>
          ) : (
            <div className="overflow-y-auto max-h-[320px]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[#0d1421]">
                  <tr className="border-b border-white/[0.06] text-gray-500 text-xs uppercase tracking-wider">
                    <th className="text-left py-2 pr-3 font-medium">{t('costs.machine')}</th>
                    <th className="text-right py-2 px-3 font-medium">{t('costs.stockConsumption')}</th>
                    <th className="text-right py-2 pl-3 font-medium">{t('costs.stockLines')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_equipment.map((e) => (
                    <tr key={e.equipment_id} className="border-b border-white/[0.03]">
                      <td className="py-2 pr-3 text-gray-300">
                        <Link to={`/equipment/${e.equipment_id}`} className="hover:text-blue-300">
                          {e.name ?? '—'}
                        </Link>
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-gray-200">{money(e.value)}</td>
                      <td className="py-2 pl-3 text-right font-mono text-gray-500">{e.items}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel icon={<PackageX size={15} className="text-red-400" />} title={t('costs.stockCriticalTitle')}
          subtitle={t('costs.stockCriticalTitleSub')}>
          {!data.has_min_levels ? (
            <p className="text-sm text-gray-600 py-6 text-center">{t('costs.stockNoMinLevelsLong')}</p>
          ) : data.stockout_items.length === 0 && data.critical_items.length === 0 ? (
            <p className="text-sm text-gray-600 py-6 text-center">{t('costs.stockAllHealthy')}</p>
          ) : (
            <ul className="space-y-1.5 max-h-64 overflow-y-auto">
              {data.stockout_items.map((i) => (
                <li key={i.id} className="text-xs flex items-baseline justify-between gap-2">
                  <span className="text-gray-300 truncate">{i.name ?? i.code ?? '—'}</span>
                  <span className="text-red-400 font-mono flex-shrink-0">{t('costs.stockOut')}</span>
                </li>
              ))}
              {data.critical_items.map((i) => (
                <li key={i.id} className="text-xs flex items-baseline justify-between gap-2">
                  <span className="text-gray-400 truncate">{i.name ?? i.code ?? '—'}</span>
                  <span className="text-amber-400 font-mono flex-shrink-0">
                    {i.quantity} / {i.min_quantity}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel icon={<Timer size={15} className="text-gray-500" />} title={t('costs.stockDormantTitle')}
          subtitle={t('costs.stockDormantTitleSub', { days: data.dormant_days })}>
          {data.dormant.length === 0 ? (
            <p className="text-sm text-gray-600 py-6 text-center">{t('common.noData')}</p>
          ) : (
            <ul className="space-y-1.5 max-h-64 overflow-y-auto">
              {data.dormant.map((d) => (
                <li key={d.id} className="text-xs flex items-baseline justify-between gap-2">
                  <span className="text-gray-400 truncate">{d.name ?? d.code ?? '—'}</span>
                  <span className="font-mono text-gray-300 flex-shrink-0">
                    {d.basis === 'none'
                      ? <span className="text-gray-600">{t('costs.stockUnvalued', { qty: d.quantity })}</span>
                      : money(d.value)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel icon={<Zap size={15} className="text-amber-400" />} title={t('costs.stockEmergencyTitle')}
          subtitle={t('costs.stockEmergencyTitleSub', { days: data.emergency_rule.lead_days })}>
          {data.emergency_purchases.length === 0 ? (
            <p className="text-sm text-gray-600 py-6 text-center">{t('common.noData')}</p>
          ) : (
            <ul className="space-y-1.5 max-h-64 overflow-y-auto">
              {data.emergency_purchases.map((p) => (
                <li key={p.order_number} className="text-xs flex items-baseline justify-between gap-2">
                  <span className="text-gray-400 truncate">
                    {p.order_number} · {p.supplier}
                    <span className="text-gray-600"> · {fmtDate(p.order_date)}</span>
                  </span>
                  <span className="font-mono text-gray-300 flex-shrink-0">{money(p.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
