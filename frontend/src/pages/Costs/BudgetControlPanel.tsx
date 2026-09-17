/**
 * Budget control + year-end projection, on a coherent time basis.
 *
 * The distinction this panel exists to make: the ANNUAL envelope minus a PARTIAL
 * actual is the available balance, not a favourable variance. The real variance
 * compares budget and actual over the same months — those up to the cut-off.
 *
 * The cut-off is the ledger's, not the calendar's: on a SAP year it is the last
 * posted month. Elapsed months with nothing imported are shown as `awaiting`,
 * never as months that cost nothing.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactECharts from 'echarts-for-react';
import {
  AlertTriangle, CalendarClock, Check, Info, Loader2, Plus, SlidersHorizontal,
  Trash2, TrendingUp, Wallet, X,
} from 'lucide-react';
import {
  createForecastAdjustment, deleteForecastAdjustment,
  type CostForecast, type CostScope, type CostSite, type ForecastAdjustmentRow,
  type MonthMapEntry, type SlotStatus,
} from '../../api/costs';
import {
  Panel, SLOT_COLORS, SLOT_DOT, Stat, compactMoney, money, signedMoney, varianceClass,
} from './shared';

const SLOT_ORDER: SlotStatus[] = ['closed', 'partial', 'awaiting', 'future'];
const ADJ_KINDS = ['major_intervention', 'contract', 'extraordinary', 'other'] as const;

export default function BudgetControlPanel({
  data, months, monthLabel, monthYearLabel, scope, site, canEdit, onChanged, periodLabel,
}: {
  data: CostForecast;
  months: number[];
  monthLabel: (slot: number) => string;
  monthYearLabel: (e: MonthMapEntry) => string;
  scope: CostScope;
  site: CostSite | null;
  canEdit: boolean;
  onChanged: () => void;
  periodLabel: string;
}) {
  const { t } = useTranslation();
  const [showAdj, setShowAdj] = useState(false);
  const [scenario, setScenario] = useState<'base' | 'favorable' | 'unfavorable'>('base');

  const asOf = data.as_of;
  const cutoffLabel = asOf.cutoff_period ? monthYearLabel(asOf.cutoff_period) : '—';
  const picked = months.map((m) => data.slots[m - 1]).filter(Boolean);
  const scenarioSlots = data.scenarios[scenario].slots;
  const pickedScenario = months.map((m) => scenarioSlots[m - 1]).filter(Boolean);
  const overdue = data.scenarios[scenario].overdue_committed;

  // ── Landing walk: what the projection is actually made of. The blocks below
  // sum EXACTLY to the scenario total, so the chart and the headline agree. ──
  const walk = useMemo(() => {
    const byStatus: Record<SlotStatus, number> = { closed: 0, partial: 0, awaiting: 0, future: 0 };
    let adjustments = 0;
    pickedScenario.forEach((s) => {
      byStatus[s.status] += s.forecast - s.adjustment;
      adjustments += s.adjustment;
    });
    const blocks: { key: string; label: string; value: number; color: string }[] = SLOT_ORDER
      .filter((k) => Math.round(byStatus[k]) !== 0)
      .map((k) => ({ key: k as string, label: t(`costs.slotStatus_${k}`), value: byStatus[k], color: SLOT_COLORS[k] }));
    if (Math.round(overdue) !== 0) {
      blocks.push({ key: 'overdue', label: t('costs.bridgeOverdue'), value: overdue, color: '#06b6d4' });
    }
    if (Math.round(adjustments) !== 0) {
      blocks.push({ key: 'adjustments', label: t('costs.bridgeAdjustments'), value: adjustments, color: '#ec4899' });
    }
    const total = blocks.reduce((s, b) => s + b.value, 0);
    return { blocks, total };
  }, [pickedScenario, overdue, t]);

  const bridgeOption = useMemo(() => {
    const labels = [t('costs.budget'), ...walk.blocks.map((b) => b.label), t('costs.projLanding')];
    const base: number[] = [0];
    const visible: { value: number; signed?: number; itemStyle: object }[] = [
      { value: Math.round(data.period_budget), itemStyle: { color: '#a855f7', borderRadius: [4, 4, 0, 0] } },
    ];
    let cum = 0;
    walk.blocks.forEach((b) => {
      base.push(Math.min(cum, cum + b.value));
      visible.push({
        value: Math.round(Math.abs(b.value)), signed: Math.round(b.value),
        itemStyle: { color: b.color, borderRadius: [4, 4, 0, 0] },
      });
      cum += b.value;
    });
    base.push(0);
    visible.push({ value: Math.round(cum), itemStyle: { color: '#3b82f6', borderRadius: [4, 4, 0, 0] } });
    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        formatter: (p: { name: string; value: number; data?: { signed?: number } }) =>
          `${p.name}: ${signedMoney(p.data?.signed ?? p.value)}`,
      },
      grid: { left: '3%', right: '4%', top: '12%', bottom: '4%', containLabel: true },
      xAxis: { type: 'category', data: labels, axisLabel: { color: '#94a3b8', rotate: 24, fontSize: 10 } },
      yAxis: {
        type: 'value', axisLabel: { color: '#94a3b8', formatter: (v: number) => compactMoney(v) },
        splitLine: { lineStyle: { color: '#1e293b' } },
      },
      series: [
        { type: 'bar', stack: 'w', silent: true, itemStyle: { color: 'transparent' },
          emphasis: { itemStyle: { color: 'transparent' } }, tooltip: { show: false }, data: base },
        { type: 'bar', stack: 'w', barMaxWidth: 34, data: visible,
          label: { show: true, position: 'top', color: '#94a3b8', fontSize: 10,
            formatter: (p: { value: number; data?: { signed?: number } }) =>
              compactMoney(p.data?.signed ?? p.value) } },
      ],
    };
  }, [walk, data.period_budget, t]);

  // ── Month strip: budget line over bars coloured by slot state ──
  const monthlyOption = useMemo(() => ({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      formatter: (ps: { dataIndex: number; seriesName: string; value: number }[]) => {
        const i = ps[0]?.dataIndex ?? 0;
        const s = pickedScenario[i];
        if (!s) return '';
        return [
          `<b>${monthLabel(s.slot)}</b> · ${t(`costs.slotStatus_${s.status}`)}`,
          `${t('costs.budget')}: ${money(s.budget)}`,
          `${t('costs.actual')}: ${money(s.actual)}`,
          s.committed ? `${t('costs.committed')}: ${money(s.committed)}` : '',
          s.adjustment ? `${t('costs.bridgeAdjustments')}: ${money(s.adjustment)}` : '',
          `${t('costs.projLanding')}: ${money(s.forecast)}`,
        ].filter(Boolean).join('<br/>');
      },
    },
    legend: { textStyle: { color: '#94a3b8' }, top: 0, itemWidth: 14, itemHeight: 8 },
    grid: { left: '3%', right: '4%', top: '16%', bottom: '4%', containLabel: true },
    xAxis: { type: 'category', data: pickedScenario.map((s) => monthLabel(s.slot)),
      axisLabel: { color: '#94a3b8' } },
    yAxis: { type: 'value', axisLabel: { color: '#94a3b8', formatter: (v: number) => compactMoney(v) },
      splitLine: { lineStyle: { color: '#1e293b' } } },
    series: [
      { name: t('costs.projLanding'), type: 'bar', barMaxWidth: 26,
        data: pickedScenario.map((s) => ({
          value: Math.round(s.forecast),
          itemStyle: { color: SLOT_COLORS[s.status], borderRadius: [4, 4, 0, 0] },
        })) },
      { name: t('costs.budget'), type: 'line', step: 'middle',
        symbol: pickedScenario.length === 1 ? 'circle' : 'none', symbolSize: 7,
        data: pickedScenario.map((s) => Math.round(s.budget)),
        lineStyle: { color: '#a855f7', width: 2, type: 'dashed' }, itemStyle: { color: '#a855f7' } },
    ],
  }), [pickedScenario, monthLabel, t]);

  const staleImport = asOf.import_age_days != null && asOf.import_age_days > 45;
  const hasGap = asOf.unposted_elapsed_months > 0;

  return (
    <div className="space-y-4">
      {/* Cut-off banner — the single most important caveat on this page */}
      <div className={`rounded-xl border px-4 py-3 flex items-start gap-3 flex-wrap ${
        hasGap || staleImport
          ? 'bg-amber-500/[0.07] border-amber-500/25'
          : 'bg-[#0d1421] border-white/[0.06]'}`}>
        <CalendarClock size={16} className={hasGap || staleImport ? 'text-amber-400 mt-0.5' : 'text-gray-500 mt-0.5'} />
        <div className="flex-1 min-w-[260px]">
          <p className="text-sm text-gray-200">
            {t('costs.cutoffLine', { period: cutoffLabel, method: t(`costs.cutoffMethod_${asOf.method}`) })}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            {asOf.last_import_at
              ? t('costs.lastImportLine', {
                  date: new Date(asOf.last_import_at).toLocaleDateString(),
                  days: asOf.import_age_days ?? 0,
                })
              : t('costs.noImportYet')}
          </p>
          {hasGap && (
            <p className="text-xs text-amber-300/90 mt-1 flex items-center gap-1.5">
              <AlertTriangle size={12} />
              {t('costs.unpostedWarning', {
                count: asOf.unposted_elapsed_months,
                months: asOf.awaiting_slots.map((s) => monthLabel(s)).join(', '),
              })}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {SLOT_ORDER.map((k) => (
            <span key={k} className="flex items-center gap-1.5 text-[11px] text-gray-400">
              <span className={`w-2 h-2 rounded-sm ${SLOT_DOT[k]}`} />
              {t(`costs.slotStatus_${k}`)}
            </span>
          ))}
        </div>
      </div>

      {/* Budget control read-out */}
      <Panel
        icon={<Wallet size={15} className="text-gray-500" />}
        title={t('costs.budgetControl')}
        subtitle={t('costs.budgetControlSub', { period: periodLabel, cutoff: cutoffLabel })}
        right={canEdit && (
          <button onClick={() => setShowAdj(true)}
            className="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5">
            <SlidersHorizontal size={13} /> {t('costs.adjustments')}
            {data.adjustment_rows.length > 0 && (
              <span className="bg-pink-500/20 text-pink-300 rounded px-1.5">{data.adjustment_rows.length}</span>
            )}
          </button>
        )}>
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-x-6 gap-y-3">
          <Stat label={t('costs.annualBudget')} value={money(data.annual_budget)} />
          <Stat label={t('costs.budgetToDate')} value={money(data.budget_to_date)}
            hint={t('costs.budgetToDateHint', { cutoff: cutoffLabel })} />
          <Stat label={t('costs.actualToDate')} value={money(data.actual_to_date)}
            hint={t('costs.actualToDateHint', { cutoff: cutoffLabel })} />
          <Stat label={t('costs.varianceToDate')}
            value={`${signedMoney(data.variance_to_date)}${
              data.variance_to_date_pct == null ? '' : ` (${data.variance_to_date_pct > 0 ? '+' : ''}${data.variance_to_date_pct}%)`}`}
            valueClass={varianceClass(data.variance_to_date)}
            hint={t('costs.varianceToDateHint')} />
          <Stat label={t('costs.remainingBudgetCard')} value={signedMoney(data.remaining_budget)}
            valueClass="text-gray-200" hint={t('costs.remainingBudgetHint')} />
          <Stat label={t('costs.committedOpen')} value={money(data.committed_open)}
            valueClass="text-cyan-300" hint={t('costs.committedOpenHint')} />
          <Stat label={t('costs.projLanding')} value={money(data.forecast)} valueClass="text-white" />
          <Stat label={t('costs.projVariance')} value={signedMoney(data.projected_variance)}
            valueClass={varianceClass(data.projected_variance)} />
        </div>
      </Panel>

      {/* Scenarios + landing */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel
          icon={<TrendingUp size={15} className="text-gray-500" />}
          title={t('costs.landingWalk')}
          subtitle={t('costs.landingWalkSub')}
          right={
            <div className="flex gap-1 bg-[#0b1120] border border-white/[0.06] rounded-lg p-1">
              {(['favorable', 'base', 'unfavorable'] as const).map((s) => (
                <button key={s} onClick={() => setScenario(s)}
                  className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                    scenario === s ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
                  {t(`costs.scenario_${s}`)}
                </button>
              ))}
            </div>
          }>
          <div className="flex items-center gap-5 flex-wrap mb-1">
            {(['favorable', 'base', 'unfavorable'] as const).map((s) => (
              <Stat key={s} label={t(`costs.scenario_${s}`)} value={money(data.forecast_scenarios[s])}
                valueClass={s === scenario ? 'text-white' : 'text-gray-500'} />
            ))}
            <Stat label={t('costs.budget')} value={money(data.period_budget)} />
          </div>
          <ReactECharts option={bridgeOption} style={{ height: 270 }} theme="dark" notMerge />
          <p className="text-[11px] text-gray-600 mt-1">
            {t('costs.landingReconciles', { total: money(walk.total) })}
          </p>
        </Panel>

        <Panel
          icon={<CalendarClock size={15} className="text-gray-500" />}
          title={t('costs.monthlyForecastTitle')}
          subtitle={t('costs.monthlyForecastSub')}>
          <ReactECharts option={monthlyOption} style={{ height: 300 }} theme="dark" notMerge />
        </Panel>
      </div>

      {/* Assumptions — the method, in the open */}
      <Panel icon={<Info size={15} className="text-gray-500" />} title={t('costs.assumptions')}
        subtitle={t('costs.assumptionsSub')}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2">
          {data.assumptions.map((a) => (
            <div key={a.key} className="flex items-baseline justify-between gap-2 border-b border-white/[0.04] pb-1">
              <span className="text-xs text-gray-500">{t(`costs.assumption_${a.key}`)}</span>
              <span className="text-xs text-gray-300 font-mono text-right">
                {formatAssumption(a.key, a.value, monthYearLabel, t)}
              </span>
            </div>
          ))}
        </div>
        {picked.length > 0 && (
          <p className="text-[11px] text-gray-600 mt-2">{t('costs.forecastRuleNote')}</p>
        )}
      </Panel>

      {showAdj && (
        <AdjustmentsModal
          rows={data.adjustment_rows} monthMap={data.month_map} scope={scope} site={site}
          canEdit={canEdit} onClose={() => setShowAdj(false)} onSaved={onChanged}
          monthYearLabel={monthYearLabel} />
      )}
    </div>
  );
}

function formatAssumption(
  key: string, value: unknown,
  monthYearLabel: (e: MonthMapEntry) => string,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  if (value == null) return '—';
  if (key === 'cutoff') {
    const v = value as MonthMapEntry;
    return v?.month ? monthYearLabel(v) : '—';
  }
  if (key === 'commitmentRule') return t('costs.commitmentRuleMax');
  if (key === 'runRate' || key === 'runRateRecent' || key === 'adjustments') return money(Number(value));
  return String(value);
}

// ─── Justified forecast adjustments ──────────────────────────────────────────

function AdjustmentsModal({
  rows, monthMap, scope, site, canEdit, onClose, onSaved, monthYearLabel,
}: {
  rows: ForecastAdjustmentRow[];
  monthMap: MonthMapEntry[];
  scope: CostScope;
  site: CostSite | null;
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
  monthYearLabel: (e: MonthMapEntry) => string;
}) {
  const { t } = useTranslation();
  const [slot, setSlot] = useState(1);
  const [kind, setKind] = useState<string>('major_intervention');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const value = Number(amount);
    if (!reason.trim() || !Number.isFinite(value) || value === 0) {
      setError(t('costs.adjValidation'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const entry = monthMap[slot - 1];
      await createForecastAdjustment(
        { year: entry.year, month: entry.month, scope, kind, amount: value, reason: reason.trim() },
        site,
      );
      setAmount('');
      setReason('');
      onSaved();
    } catch {
      setError(t('costs.adjSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    await deleteForecastAdjustment(id);
    onSaved();
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}>
      <div className="bg-[#0d1421] border border-white/10 rounded-xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
          <div>
            <h3 className="text-sm font-semibold text-white">{t('costs.adjustments')}</h3>
            <p className="text-xs text-gray-500">{t('costs.adjustmentsSub')}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={18} /></button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4">
          {canEdit && (
            <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">
              <label className="text-xs text-gray-500 sm:col-span-1">
                {t('costs.adjMonth')}
                <select value={slot} onChange={(e) => setSlot(Number(e.target.value))}
                  className="input-field mt-1 w-full text-sm">
                  {monthMap.map((e, i) => (
                    <option key={`${e.year}-${e.month}`} value={i + 1}>{monthYearLabel(e)}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-gray-500 sm:col-span-1">
                {t('costs.adjKind')}
                <select value={kind} onChange={(e) => setKind(e.target.value)}
                  className="input-field mt-1 w-full text-sm">
                  {ADJ_KINDS.map((k) => <option key={k} value={k}>{t(`costs.adjKind_${k}`)}</option>)}
                </select>
              </label>
              <label className="text-xs text-gray-500 sm:col-span-1">
                {t('costs.adjAmount')}
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal"
                  className="input-field mt-1 w-full text-sm" placeholder="0" />
              </label>
              <label className="text-xs text-gray-500 sm:col-span-2">
                {t('costs.adjReason')}
                <input value={reason} onChange={(e) => setReason(e.target.value)}
                  className="input-field mt-1 w-full text-sm" placeholder={t('costs.adjReasonPlaceholder')} />
              </label>
              <div className="sm:col-span-5 flex items-center gap-3">
                <button onClick={submit} disabled={saving}
                  className="btn-primary py-1.5 px-3 text-sm flex items-center gap-1.5">
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  {t('common.add')}
                </button>
                {error && <span className="text-xs text-red-400">{error}</span>}
              </div>
            </div>
          )}

          {rows.length === 0 ? (
            <p className="text-sm text-gray-600 py-6 text-center">{t('costs.noAdjustments')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] text-gray-500 text-xs uppercase tracking-wider">
                  <th className="text-left py-2 pr-3 font-medium">{t('costs.adjMonth')}</th>
                  <th className="text-left py-2 px-3 font-medium">{t('costs.adjKind')}</th>
                  <th className="text-right py-2 px-3 font-medium">{t('costs.adjAmount')}</th>
                  <th className="text-left py-2 px-3 font-medium">{t('costs.adjReason')}</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-white/[0.03]">
                    <td className="py-2 pr-3 text-gray-300">
                      {monthYearLabel({ year: r.year, month: r.month })}
                    </td>
                    <td className="py-2 px-3 text-gray-400">{t(`costs.adjKind_${r.kind}`)}</td>
                    <td className="py-2 px-3 text-right font-mono text-gray-200">{signedMoney(r.amount)}</td>
                    <td className="py-2 px-3 text-gray-400 text-xs">{r.reason}</td>
                    <td className="py-2 text-right">
                      {canEdit && (
                        <button onClick={() => remove(r.id)} className="text-gray-600 hover:text-red-400">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="text-[11px] text-gray-600 flex items-start gap-1.5">
            <Check size={12} className="mt-0.5 flex-shrink-0" /> {t('costs.adjustmentNote')}
          </p>
        </div>
      </div>
    </div>
  );
}
