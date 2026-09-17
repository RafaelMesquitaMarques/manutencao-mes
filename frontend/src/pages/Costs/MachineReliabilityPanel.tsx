/**
 * Cost × reliability per asset — the depth behind the By-machine tab.
 *
 * The coverage banner is deliberate: with the SAP ledger as the official actual
 * and little platform-tracked spend, most assets show no LINKED cost. That is a
 * coverage gap, not a machine that costs nothing, and the panel says so before
 * any ranking is read.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import ReactECharts from 'echarts-for-react';
import {
  Activity, AlertTriangle, ChevronDown, ChevronRight, Info, Receipt, Scale, Wrench,
} from 'lucide-react';
import {
  fetchEquipmentAnalysis, fetchRepairReplace,
  type CostSite, type EquipmentAnalysis, type EquipmentAnalysisRow, type RepairReplace,
} from '../../api/costs';
import Spinner from '../../components/ui/Spinner';
import { Panel, money } from './shared';

const CRIT_CLASS: Record<string, string> = {
  critical: 'text-red-400', high: 'text-amber-400', medium: 'text-blue-400', low: 'text-gray-500',
};

export default function MachineReliabilityPanel({
  year, site, months, periodLabel, onTransactions,
}: {
  year: number;
  site: CostSite | null;
  months: number[];
  periodLabel: string;
  onTransactions: (equipmentId: string, label: string) => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<EquipmentAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<'cost' | 'attention' | 'downtime' | 'repeat'>('attention');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rr, setRr] = useState<Record<string, RepairReplace>>({});

  const monthFrom = Math.min(...months);
  const monthTo = Math.max(...months);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchEquipmentAnalysis({ year, site, month_from: monthFrom, month_to: monthTo }));
    } finally {
      setLoading(false);
    }
  }, [year, site, monthFrom, monthTo]);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const all = (data?.equipment ?? []).filter(
      (e) => e.cost > 0 || e.corrective > 0 || e.interventions > 0 || e.downtime_hours > 0);
    const key: Record<typeof sort, (e: EquipmentAnalysisRow) => number> = {
      cost: (e) => e.cost, attention: (e) => e.attention_score,
      downtime: (e) => e.downtime_hours, repeat: (e) => e.repeat_failures,
    };
    return [...all].sort((a, b) => key[sort](b) - key[sort](a));
  }, [data, sort]);

  const top = rows.slice(0, 12);
  const scatterOption = useMemo(() => ({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      formatter: (p: { data: [number, number, string, number, number] }) => {
        const [x, y, name, cost] = p.data;
        return `<b>${name}</b><br/>${t('costs.relCorrective')}: ${x}<br/>`
          + `${t('costs.relDowntime')}: ${y} h<br/>${t('costs.cost')}: ${money(cost)}`;
      },
    },
    grid: { left: '3%', right: '4%', top: '10%', bottom: '6%', containLabel: true },
    xAxis: { type: 'value', name: t('costs.relCorrective'), nameTextStyle: { color: '#64748b', fontSize: 10 },
      axisLabel: { color: '#94a3b8' }, splitLine: { lineStyle: { color: '#1e293b' } } },
    yAxis: { type: 'value', name: t('costs.relDowntimeShort'), nameTextStyle: { color: '#64748b', fontSize: 10 },
      axisLabel: { color: '#94a3b8' }, splitLine: { lineStyle: { color: '#1e293b' } } },
    series: [{
      type: 'scatter',
      symbolSize: (d: number[]) => {
        const max = Math.max(...rows.map((r) => r.cost), 1);
        return 10 + 30 * Math.sqrt((d[3] ?? 0) / max);
      },
      data: rows.slice(0, 40).map((e) => [e.corrective, Math.round(e.downtime_hours), e.name, e.cost, e.attention_score]),
      itemStyle: {
        color: (p: { data: number[] }) => {
          const s = p.data[4] ?? 0;
          return s >= 60 ? '#ef4444' : s >= 35 ? '#f59e0b' : '#3b82f6';
        },
        opacity: 0.8,
      },
    }],
  }), [rows, t]);

  const openRepairReplace = async (id: string) => {
    if (rr[id]) return;
    const res = await fetchRepairReplace(id, { year, site, month_from: monthFrom, month_to: monthTo });
    setRr((p) => ({ ...p, [id]: res }));
  };

  if (loading) return <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>;
  if (!data) return null;

  const cov = data.coverage;
  const lowCoverage = cov.official_total > 0 && cov.tracked_total / Math.max(cov.official_total, 1) < 0.5;

  return (
    <div className="space-y-4">
      {lowCoverage && (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-3 flex items-start gap-3">
          <AlertTriangle size={16} className="text-amber-400 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm text-amber-100/90">{t('costs.relCoverageWarn')}</p>
            <p className="text-xs text-amber-200/70 mt-0.5">
              {t('costs.relCoverageDetail', {
                tracked: money(cov.tracked_total), official: money(cov.official_total),
                withCost: cov.equipment_with_cost, total: cov.equipment_total,
              })}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Panel className="xl:col-span-1" icon={<Activity size={15} className="text-gray-500" />}
          title={t('costs.relAttentionMap')} subtitle={t('costs.relAttentionMapSub')}>
          {rows.length === 0 ? (
            <div className="flex items-center justify-center h-64 text-gray-600 text-sm">{t('common.noData')}</div>
          ) : (
            <ReactECharts option={scatterOption} style={{ height: 300 }} theme="dark" notMerge />
          )}
        </Panel>

        <Panel className="xl:col-span-2" icon={<Wrench size={15} className="text-gray-500" />}
          title={t('costs.relTitle')} subtitle={t('costs.relSub', { period: periodLabel })}
          right={
            <div className="flex gap-1 bg-[#0b1120] border border-white/[0.06] rounded-lg p-1">
              {(['attention', 'cost', 'downtime', 'repeat'] as const).map((s) => (
                <button key={s} onClick={() => setSort(s)}
                  className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                    sort === s ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
                  {t(`costs.relSort_${s}`)}
                </button>
              ))}
            </div>
          }>
          {top.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-gray-600 text-sm">{t('common.noData')}</div>
          ) : (
            <div className="overflow-x-auto max-h-[420px]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[#0d1421]">
                  <tr className="border-b border-white/[0.06] text-gray-500 text-xs uppercase tracking-wider">
                    <th className="text-left py-2 pr-3 font-medium">{t('costs.machine')}</th>
                    <th className="text-right py-2 px-2 font-medium">{t('costs.cost')}</th>
                    <th className="text-right py-2 px-2 font-medium">{t('costs.relCorrectiveShort')}</th>
                    <th className="text-right py-2 px-2 font-medium">{t('costs.relRepeat')}</th>
                    <th className="text-right py-2 px-2 font-medium">{t('costs.relDowntimeShort')}</th>
                    <th className="text-right py-2 px-2 font-medium">MTBF</th>
                    <th className="text-right py-2 px-2 font-medium">MTTR</th>
                    <th className="text-right py-2 pl-2 font-medium">{t('costs.relScore')}</th>
                  </tr>
                </thead>
                <tbody>
                  {top.map((e) => {
                    const open = expanded === e.equipment_id;
                    const detail = rr[e.equipment_id];
                    return (
                      <Fragment key={e.equipment_id}>
                        <tr
                          onClick={() => {
                            setExpanded(open ? null : e.equipment_id);
                            if (!open) openRepairReplace(e.equipment_id);
                          }}
                          className="border-b border-white/[0.03] hover:bg-white/[0.02] cursor-pointer">
                          <td className="py-2 pr-3 text-gray-200">
                            <span className="flex items-center gap-1.5">
                              {open ? <ChevronDown size={13} className="text-gray-500" />
                                : <ChevronRight size={13} className="text-gray-500" />}
                              <span className="truncate max-w-[180px]">{e.name}</span>
                              <span className={`text-[10px] uppercase ${CRIT_CLASS[e.criticality] ?? 'text-gray-500'}`}>
                                {t(`costs.crit_${e.criticality}`, e.criticality)}
                              </span>
                            </span>
                          </td>
                          <td className="py-2 px-2 text-right font-mono text-gray-100">
                            {e.cost > 0 ? money(e.cost) : <span className="text-gray-600">{t('costs.relNoLinkedCost')}</span>}
                          </td>
                          <td className="py-2 px-2 text-right font-mono text-gray-300">{e.corrective}</td>
                          <td className={`py-2 px-2 text-right font-mono ${e.repeat_failures > 0 ? 'text-amber-400' : 'text-gray-500'}`}>
                            {e.repeat_failures}
                          </td>
                          <td className="py-2 px-2 text-right font-mono text-gray-300">{Math.round(e.downtime_hours)}</td>
                          <td className="py-2 px-2 text-right font-mono text-gray-400">
                            {e.mtbf_hours == null ? '—' : `${e.mtbf_hours} h`}
                          </td>
                          <td className="py-2 px-2 text-right font-mono text-gray-400">
                            {e.mttr_hours == null ? '—' : `${e.mttr_hours} h`}
                          </td>
                          <td className={`py-2 pl-2 text-right font-mono ${
                            e.attention_score >= 60 ? 'text-red-400'
                              : e.attention_score >= 35 ? 'text-amber-400' : 'text-gray-400'}`}>
                            {e.attention_score}
                          </td>
                        </tr>
                        {open && (
                          <tr className="bg-white/[0.015]">
                            <td colSpan={8} className="px-6 py-3">
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 mb-3">
                                <Figure label={t('costType.parts', 'Parts')} value={money(e.parts)} />
                                <Figure label={t('costs.relServices')} value={money(e.services)} />
                                <Figure label={t('costType.labor', 'Labor')} value={money(e.labor)} />
                                <Figure label={t('costs.relPlanned')} value={money(e.planned_cost)} />
                                <Figure label={t('costs.relUnplanned')} value={money(e.unplanned_cost)} />
                                <Figure label={t('costs.relPreventive')} value={String(e.preventive)} />
                                <Figure label={t('costs.relInterventions')} value={String(e.interventions)} />
                                <Figure label={t('costs.relCostPerHour')}
                                  value={e.cost_per_operating_hour == null
                                    ? t('costs.relNoHours')
                                    : `${money(e.cost_per_operating_hour)} / h`} />
                              </div>
                              {detail && (
                                <div className="border-t border-white/[0.05] pt-2">
                                  <p className="flex items-center gap-1.5 text-[10px] text-gray-500 uppercase tracking-wide mb-1">
                                    <Scale size={11} /> {t('costs.repairReplace')}
                                  </p>
                                  {detail.available ? (
                                    <p className="text-xs text-gray-400">
                                      {t('costs.repairReplaceReady', {
                                        annual: money(detail.annualised_cost ?? 0),
                                        replacement: money(detail.replacement_cost ?? 0),
                                        ratio: detail.cost_ratio_pct ?? 0,
                                      })}
                                    </p>
                                  ) : (
                                    <p className="text-xs text-gray-500 flex items-start gap-1.5">
                                      <Info size={12} className="mt-0.5 flex-shrink-0" />
                                      {t('costs.repairReplaceMissing', {
                                        inputs: (detail.missing_inputs ?? [])
                                          .map((k) => t(`costs.rrInput_${k}`)).join(', '),
                                      })}
                                    </p>
                                  )}
                                </div>
                              )}
                              <button onClick={(ev) => { ev.stopPropagation(); onTransactions(e.equipment_id, e.code || e.name); }}
                                className="mt-2 flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300">
                                <Receipt size={13} /> {t('costs.viewTransactions')}
                              </button>
                              <Link to={`/equipment/${e.equipment_id}`}
                                className="ml-4 text-xs text-blue-400 hover:text-blue-300">
                                {t('costs.openEquipment')}
                              </Link>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[11px] text-gray-600 mt-2">{t('costs.relScoreNote')}</p>
        </Panel>
      </div>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-gray-500 truncate">{label}</span>
      <span className="text-xs font-mono text-gray-300">{value}</span>
    </div>
  );
}
