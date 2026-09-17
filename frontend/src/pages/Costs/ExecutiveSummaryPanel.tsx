/**
 * The period read-out a maintenance manager can act on.
 *
 * Every line is assembled from the figures the other endpoints already computed
 * and carries them inline — there is no generated prose and no stated cause the
 * data cannot support. When the previous year was never imported, the "what
 * moved" block switches to the budget basis and says so.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ChevronDown, ChevronUp, ClipboardCheck, Download, FileSpreadsheet,
  Loader2, ShieldAlert, Sparkles, TrendingDown, TrendingUp,
} from 'lucide-react';
import {
  downloadExecutiveReport, fetchExecutiveSummary,
  type CostScope, type CostSite, type ExecutiveSummary, type MonthMapEntry,
} from '../../api/costs';
import Spinner from '../../components/ui/Spinner';
import { SEVERITY_CLASS, money, signedMoney, varianceClass } from './shared';

const STATE_CLASS: Record<string, string> = {
  under: 'text-green-400', on_track: 'text-green-400',
  at_risk: 'text-amber-400', over: 'text-red-400',
};

export default function ExecutiveSummaryPanel({
  year, site, scope, months, periodLabel, monthYearLabel, ccLabel, onDrill,
}: {
  year: number;
  site: CostSite | null;
  scope: CostScope;
  months: number[];
  periodLabel: string;
  monthYearLabel: (e: MonthMapEntry) => string;
  ccLabel: (cc: string) => string;
  onDrill: (drill: { tab?: string; cost_center?: string; equipment_id?: string }) => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<ExecutiveSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(true);
  const [exporting, setExporting] = useState(false);

  const monthFrom = Math.min(...months);
  const monthTo = Math.max(...months);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchExecutiveSummary({
        year, site, kind: scope, month_from: monthFrom, month_to: monthTo }));
    } finally {
      setLoading(false);
    }
  }, [year, site, scope, monthFrom, monthTo]);
  useEffect(() => { load(); }, [load]);

  const exportReport = async () => {
    setExporting(true);
    try {
      await downloadExecutiveReport({ year, site, kind: scope, month_from: monthFrom, month_to: monthTo });
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4 flex items-center justify-center h-24">
        <Spinner />
      </div>
    );
  }
  if (!data) return null;

  // A data-quality figure is a count, an amount or a period. Format each for
  // what it is: a four-digit-plus number is money, an object is a month.
  const fmtFigure = (v: unknown): string => {
    if (v == null) return '—';
    if (typeof v === 'number') return Math.abs(v) >= 1000 ? money(v) : String(Math.round(v * 10) / 10);
    if (typeof v === 'object') {
      const m = v as MonthMapEntry;
      return m?.month ? monthYearLabel(m) : '—';
    }
    return String(v);
  };

  const b = data.budget;
  const l = data.landing;
  const cutoff = data.cutoff ? monthYearLabel(data.cutoff) : '—';

  return (
    <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl overflow-hidden">
      <div className="flex items-start justify-between gap-3 flex-wrap px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Sparkles size={15} className="text-blue-400" />
            <h3 className="text-sm font-semibold text-gray-200">{t('costs.execTitle')}</h3>
            <span className={`text-xs font-semibold ${STATE_CLASS[b.state] ?? 'text-gray-400'}`}>
              {t(`costs.execState_${b.state}`)}
            </span>
          </div>
          <p className="text-sm text-gray-300 mt-1.5 leading-relaxed">
            {t('costs.execHeadline', {
              period: periodLabel,
              cutoff,
              budgetToDate: money(b.budget_to_date),
              actualToDate: money(b.actual_to_date),
              variance: signedMoney(b.variance_to_date),
              pct: b.variance_to_date_pct == null ? '—' : `${b.variance_to_date_pct}%`,
            })}
          </p>
          <p className="text-sm text-gray-400 mt-1 leading-relaxed">
            {t('costs.execLanding', {
              landing: money(l.forecast),
              budget: money(b.period_budget),
              variance: signedMoney(l.projected_variance),
              low: money(l.scenarios.favorable),
              high: money(l.scenarios.unfavorable),
            })}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={exportReport} disabled={exporting}
            className="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5">
            {exporting ? <Loader2 size={13} className="animate-spin" /> : <FileSpreadsheet size={13} />}
            {t('costs.execExport')}
          </button>
          <button onClick={() => setOpen(!open)} className="text-gray-500 hover:text-gray-300 p-1.5">
            {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
      </div>

      {open && (
        <div className="px-4 pb-4 grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-x-6 gap-y-4 border-t border-white/[0.05] pt-3">
          {/* What moved */}
          <section>
            <h4 className="text-[10px] uppercase tracking-wide text-gray-500 mb-1.5 flex items-center gap-1.5">
              {l.projected_variance < 0 ? <TrendingUp size={12} className="text-red-400" />
                : <TrendingDown size={12} className="text-green-400" />}
              {t(data.driver_basis === 'yoy' ? 'costs.execDriversYoY' : 'costs.execDriversBudget')}
            </h4>
            {data.drivers.length === 0 ? (
              <p className="text-xs text-gray-600">{t('costs.execNoDrivers')}</p>
            ) : (
              <ul className="space-y-1">
                {data.drivers.map((d) => (
                  <li key={d.cost_center}>
                    <button onClick={() => onDrill({ tab: 'pnl', cost_center: d.cost_center })}
                      className="w-full text-left text-xs text-gray-400 hover:text-gray-200 flex items-baseline justify-between gap-2">
                      <span className="truncate">{ccLabel(d.cost_center)}</span>
                      <span className={`font-mono flex-shrink-0 ${
                        data.driver_basis === 'yoy' ? varianceClass(-d.delta)
                          : varianceClass(d.variance_to_date ?? 0)}`}>
                        {data.driver_basis === 'yoy'
                          ? signedMoney(d.delta)
                          : signedMoney(d.variance_to_date ?? 0)}
                      </span>
                    </button>
                    {d.top_account && (
                      <span className="block text-[10px] text-gray-600 truncate">{d.top_account}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Assets needing attention */}
          <section>
            <h4 className="text-[10px] uppercase tracking-wide text-gray-500 mb-1.5 flex items-center gap-1.5">
              <ShieldAlert size={12} className="text-amber-400" /> {t('costs.execAttention')}
            </h4>
            {data.attention_equipment.length === 0 ? (
              <p className="text-xs text-gray-600">{t('costs.execNoAttention')}</p>
            ) : (
              <ul className="space-y-1">
                {data.attention_equipment.map((e) => (
                  <li key={e.equipment_id}>
                    <Link to={`/equipment/${e.equipment_id}`}
                      className="text-xs text-gray-400 hover:text-gray-200 flex items-baseline justify-between gap-2">
                      <span className="truncate">{e.name}</span>
                      <span className="font-mono text-gray-500 flex-shrink-0">{e.score}</span>
                    </Link>
                    <span className="block text-[10px] text-gray-600">
                      {t('costs.execAttentionDetail', {
                        corrective: e.corrective, repeat: e.repeat_failures,
                        downtime: Math.round(e.downtime_hours),
                        cost: e.cost > 0 ? money(e.cost) : t('costs.relNoLinkedCost'),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Data quality */}
          <section>
            <h4 className="text-[10px] uppercase tracking-wide text-gray-500 mb-1.5 flex items-center gap-1.5">
              <AlertTriangle size={12} className="text-amber-400" /> {t('costs.execDataQuality')}
            </h4>
            {data.data_quality.length === 0 ? (
              <p className="text-xs text-gray-600">{t('costs.execDataOk')}</p>
            ) : (
              <ul className="space-y-1">
                {data.data_quality.map((q) => (
                  <li key={q.key}>
                    <button onClick={() => onDrill({ tab: 'reconciliation' })}
                      className="w-full text-left text-xs text-gray-400 hover:text-gray-200">
                      {t(`costs.dq_${q.key}`, { value: fmtFigure(q.value), detail: fmtFigure(q.detail) })}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Priority actions */}
          <section>
            <h4 className="text-[10px] uppercase tracking-wide text-gray-500 mb-1.5 flex items-center gap-1.5">
              <ClipboardCheck size={12} className="text-blue-400" /> {t('costs.execPriorities')}
            </h4>
            {data.priority_alerts.length === 0 ? (
              <p className="text-xs text-gray-600">{t('costs.execNoPriorities')}</p>
            ) : (
              <ul className="space-y-1">
                {data.priority_alerts.map((a, i) => (
                  <li key={`${a.kind}-${i}`}>
                    <button onClick={() => onDrill(a.drill)}
                      className="w-full text-left text-xs text-gray-400 hover:text-gray-200 flex items-start gap-1.5">
                      <span className={`text-[9px] uppercase px-1 rounded border mt-0.5 flex-shrink-0 ${
                        SEVERITY_CLASS[a.severity]}`}>
                        {t(`costs.severity_${a.severity}`)}
                      </span>
                      <span className="truncate">
                        {t(`costs.alertKind_${a.kind}`, {
                          subject: a.subject ?? '', value: a.value, threshold: a.threshold })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="lg:col-span-2 xl:col-span-4 text-[11px] text-gray-600 flex items-center gap-1.5">
            <Download size={11} /> {t('costs.execSourceNote', { source: t(`costs.source_${data.source}`) })}
          </p>
        </div>
      )}
    </div>
  );
}
