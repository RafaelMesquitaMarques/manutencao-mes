/**
 * SAP × KAIZO reconciliation.
 *
 * The page's premise: SAP is the official actual, KAIZO carries the operational
 * detail. This tab measures how much of the official ledger the platform can
 * actually explain, and lets a user attach the missing records line by line.
 *
 * Two rules are visible in the UI itself:
 *   · a linked amount EXPLAINS a GL line, it is never added to it;
 *   · an ambiguous suggestion is never confirmed automatically.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, CheckCircle2, Copy, FileSearch, Landmark, Link2, Link2Off,
  Loader2, Search, Trash2, Unlink, X,
} from 'lucide-react';
import {
  createSapLink, deleteSapLink, fetchCostReconciliation, fetchLinkSuggestions, fetchSapLines,
  type CostReconciliation, type CostSite, type LinkSuggestions, type MonthMapEntry,
  type SapLine, type SapLines,
} from '../../api/costs';
import Spinner from '../../components/ui/Spinner';
import { Card, Panel, money, signedMoney } from './shared';

export default function ReconciliationTab({
  year, site, months, monthLabel, monthYearLabel, periodLabel, ccLabel, canEdit,
}: {
  year: number;
  site: CostSite | null;
  months: number[];
  monthLabel: (slot: number) => string;
  monthYearLabel: (e: MonthMapEntry) => string;
  periodLabel: string;
  ccLabel: (cc: string) => string;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<CostReconciliation | null>(null);
  const [loading, setLoading] = useState(true);
  const [linkFilter, setLinkFilter] = useState<'all' | 'linked' | 'unlinked'>('all');
  const [ccFilter, setCcFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [lines, setLines] = useState<SapLines | null>(null);
  const [linesLoading, setLinesLoading] = useState(false);
  const [linkTarget, setLinkTarget] = useState<SapLine | null>(null);

  const monthFrom = Math.min(...months);
  const monthTo = Math.max(...months);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchCostReconciliation({ year, site, month_from: monthFrom, month_to: monthTo }));
    } finally {
      setLoading(false);
    }
  }, [year, site, monthFrom, monthTo]);
  useEffect(() => { load(); }, [load]);

  const loadLines = useCallback(async () => {
    setLinesLoading(true);
    try {
      setLines(await fetchSapLines({
        year, site, month_from: monthFrom, month_to: monthTo,
        link: linkFilter, cost_center: ccFilter ?? undefined, q: query || undefined,
      }));
    } finally {
      setLinesLoading(false);
    }
  }, [year, site, monthFrom, monthTo, linkFilter, ccFilter, query]);
  useEffect(() => { loadLines(); }, [loadLines]);

  const unclassifiedTotal = useMemo(() => {
    if (!data) return 0;
    return Object.values(data.unclassified).reduce((s, v) => s + v.amount, 0);
  }, [data]);

  if (loading) return <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>;
  if (!data) return null;

  if (data.source !== 'sap') {
    return (
      <Panel icon={<Landmark size={15} className="text-gray-500" />} title={t('costs.reconTitle')}>
        <p className="text-sm text-gray-500 py-8 text-center">{t('costs.reconNoSap', { year })}</p>
      </Panel>
    );
  }

  const asOf = data.as_of;
  const cutoff = asOf.cutoff_period ? monthYearLabel(asOf.cutoff_period) : '—';

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <Card icon={<Landmark size={20} className="text-purple-400" />} label={t('costs.reconSapTotal')}
          value={money(data.sap_total)} sub={periodLabel} color="purple" />
        <Card icon={<Link2 size={20} className="text-green-400" />} label={t('costs.reconLinked')}
          value={data.linked_pct == null ? '—' : `${data.linked_pct}%`}
          sub={money(data.linked_total)} color="green"
          valueClass={(data.linked_pct ?? 0) >= 50 ? 'text-green-400' : 'text-amber-400'} />
        <Card icon={<Link2Off size={20} className="text-amber-400" />} label={t('costs.reconUnlinked')}
          value={money(data.unlinked_total)}
          sub={t('costs.reconUnlinkedSub', { pct: data.unlinked_pct ?? 0 })} color="amber" />
        <Card icon={<AlertTriangle size={20} className="text-red-400" />} label={t('costs.reconUnclassified')}
          value={money(unclassifiedTotal)}
          sub={t('costs.reconUnclassifiedSub', {
            count: Object.values(data.unclassified).reduce((s, v) => s + v.count, 0) })}
          color="red" valueClass={unclassifiedTotal > 0 ? 'text-red-400' : 'text-gray-400'} />
        <Card icon={<Copy size={20} className="text-amber-400" />} label={t('costs.reconDuplicates')}
          value={String(data.duplicates.length)}
          sub={t('costs.reconDuplicatesSub', {
            amount: money(data.duplicates.reduce((s, d) => s + d.amount, 0)) })}
          color="amber" valueClass={data.duplicates.length ? 'text-amber-400' : 'text-gray-400'} />
        <Card icon={<FileSearch size={20} className="text-blue-400" />} label={t('costs.reconLastPosted')}
          value={cutoff}
          sub={asOf.last_import_at
            ? t('costs.reconImportedAgo', { days: asOf.import_age_days ?? 0 })
            : t('costs.noImportYet')}
          color="blue"
          valueClass={asOf.unposted_elapsed_months > 0 ? 'text-amber-400' : 'text-white'} />
      </div>

      {/* The coverage statement, spelled out so nobody adds the two sources */}
      <div className="rounded-xl border border-white/[0.06] bg-[#0d1421] px-4 py-3">
        <p className="text-xs text-gray-400 flex items-start gap-2">
          <CheckCircle2 size={14} className="text-blue-400 mt-0.5 flex-shrink-0" />
          {t('costs.reconNeverSummed', {
            sap: money(data.sap_total),
            tracked: money(data.tracked_total),
            pct: data.tracked_coverage_pct ?? 0,
          })}
        </p>
        {asOf.unposted_elapsed_months > 0 && (
          <p className="text-xs text-amber-300/90 flex items-start gap-2 mt-1.5">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            {t('costs.unpostedWarning', {
              count: asOf.unposted_elapsed_months,
              months: asOf.awaiting_slots.map((s) => monthLabel(s)).join(', '),
            })}
          </p>
        )}
      </div>

      {/* Coverage per cost center */}
      <Panel icon={<Landmark size={15} className="text-gray-500" />} title={t('costs.reconByCc')}
        subtitle={t('costs.reconByCcSub')}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] text-gray-500 text-xs uppercase tracking-wider">
                <th className="text-left py-2 pr-4 font-medium">{t('costs.costCenter')}</th>
                <th className="text-right py-2 px-3 font-medium">{t('costs.reconSapTotal')}</th>
                <th className="text-right py-2 px-3 font-medium">{t('costs.reconLinked')}</th>
                <th className="text-right py-2 px-3 font-medium">{t('costs.reconUnlinked')}</th>
                <th className="text-right py-2 px-3 font-medium">{t('costs.reconCoverage')}</th>
                <th className="text-right py-2 pl-3 font-medium">{t('costs.reconLines')}</th>
              </tr>
            </thead>
            <tbody>
              {data.by_cost_center.map((r) => (
                <tr key={r.cost_center}
                  onClick={() => setCcFilter(ccFilter === r.cost_center ? null : r.cost_center)}
                  className={`border-b border-white/[0.03] cursor-pointer transition-colors ${
                    ccFilter === r.cost_center ? 'bg-blue-500/[0.07]' : 'hover:bg-white/[0.02]'}`}>
                  <td className="py-2 pr-4 text-gray-200">
                    <span className="inline-flex items-baseline gap-1.5">
                      {r.code && <span className="text-[11px] font-mono text-gray-500">{r.code}</span>}
                      {ccLabel(r.cost_center)}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-gray-100">{money(r.sap_total)}</td>
                  <td className="py-2 px-3 text-right font-mono text-green-400">{money(r.linked)}</td>
                  <td className="py-2 px-3 text-right font-mono text-amber-400">{money(r.unlinked)}</td>
                  <td className="py-2 px-3 text-right font-mono text-gray-400">
                    {r.linked_pct == null ? '—' : `${r.linked_pct}%`}
                  </td>
                  <td className="py-2 pl-3 text-right font-mono text-gray-500">
                    {r.linked_lines}/{r.lines}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* Data-quality findings */}
      {(data.duplicates.length > 0 || data.reversals.length > 0 || data.orphan_links.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {data.duplicates.length > 0 && (
            <Panel icon={<Copy size={15} className="text-amber-400" />} title={t('costs.reconDuplicates')}
              subtitle={t('costs.reconDuplicatesHint')}>
              <ul className="space-y-1.5 max-h-56 overflow-y-auto">
                {data.duplicates.map((d, i) => (
                  <li key={i} className="text-xs text-gray-400 flex items-baseline justify-between gap-2">
                    <span className="truncate">{ccLabel(d.cost_center)} · {d.account}</span>
                    <span className="font-mono text-gray-300 flex-shrink-0">
                      {money(d.amount)} ×{d.occurrences} ({d.positions.map((p) => monthLabel(p)).join(', ')})
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          {data.reversals.length > 0 && (
            <Panel icon={<Unlink size={15} className="text-blue-400" />} title={t('costs.reconReversals')}
              subtitle={t('costs.reconReversalsHint')}>
              <ul className="space-y-1.5 max-h-56 overflow-y-auto">
                {data.reversals.map((d, i) => (
                  <li key={i} className="text-xs text-gray-400 flex items-baseline justify-between gap-2">
                    <span className="truncate">{ccLabel(d.cost_center)} · {d.account}</span>
                    <span className="font-mono text-gray-300 flex-shrink-0">
                      {money(d.amount)} ({d.positions.map((p) => monthLabel(p)).join(', ')})
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          {data.orphan_links.length > 0 && (
            <Panel icon={<AlertTriangle size={15} className="text-red-400" />} title={t('costs.reconOrphans')}
              subtitle={t('costs.reconOrphansHint')}>
              <ul className="space-y-1.5 max-h-56 overflow-y-auto">
                {data.orphan_links.map((o, i) => (
                  <li key={i} className="text-xs text-gray-400 flex items-baseline justify-between gap-2">
                    <span className="font-mono truncate">{o.cost_center_code} · {o.account_code}</span>
                    <span className="font-mono text-gray-300">{money(o.amount)} ({o.links})</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      )}

      {/* GL lines drill-down */}
      <Panel icon={<FileSearch size={15} className="text-gray-500" />} title={t('costs.reconLinesTitle')}
        subtitle={t('costs.reconLinesSub')}
        right={
          <div className="flex items-center gap-2 flex-wrap">
            {ccFilter && (
              <button onClick={() => setCcFilter(null)}
                className="text-xs bg-blue-500/15 text-blue-300 rounded px-2 py-1 flex items-center gap-1">
                {ccLabel(ccFilter)} <X size={11} />
              </button>
            )}
            <div className="relative">
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-600" />
              <input value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder={t('common.search')}
                className="input-field text-xs py-1.5 pl-7 pr-2 w-40" />
            </div>
            <div className="flex gap-1 bg-[#0b1120] border border-white/[0.06] rounded-lg p-1">
              {(['all', 'unlinked', 'linked'] as const).map((f) => (
                <button key={f} onClick={() => setLinkFilter(f)}
                  className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                    linkFilter === f ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
                  {t(`costs.reconFilter_${f}`)}
                </button>
              ))}
            </div>
          </div>
        }>
        {linesLoading ? (
          <div className="flex items-center justify-center h-40"><Spinner /></div>
        ) : !lines || lines.lines.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-gray-600 text-sm">{t('common.noData')}</div>
        ) : (
          <>
            <div className="overflow-x-auto max-h-[480px]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[#0d1421]">
                  <tr className="border-b border-white/[0.06] text-gray-500 text-xs uppercase tracking-wider">
                    <th className="text-left py-2 pr-3 font-medium">{t('costs.month')}</th>
                    <th className="text-left py-2 px-3 font-medium">{t('costs.costCenter')}</th>
                    <th className="text-left py-2 px-3 font-medium">{t('costs.account')}</th>
                    <th className="text-right py-2 px-3 font-medium">{t('costs.actual')}</th>
                    <th className="text-left py-2 px-3 font-medium">{t('costs.reconLinkedTo')}</th>
                    <th className="w-24" />
                  </tr>
                </thead>
                <tbody>
                  {lines.lines.map((ln, i) => (
                    <tr key={`${ln.pos}-${ln.cost_center_code}-${ln.account_code}-${i}`}
                      className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                      <td className="py-2 pr-3 text-gray-400 capitalize">{monthLabel(ln.pos)}</td>
                      <td className="py-2 px-3 text-gray-300">{ccLabel(ln.cost_center)}</td>
                      <td className="py-2 px-3 text-gray-400 text-xs">{ln.account}</td>
                      <td className="py-2 px-3 text-right font-mono text-gray-100">{signedMoney(ln.actual)}</td>
                      <td className="py-2 px-3">
                        {ln.links.length === 0 ? (
                          <span className="text-xs text-gray-600">{t('costs.reconNoLink')}</span>
                        ) : (
                          <div className="space-y-0.5">
                            {ln.links.map((l) => (
                              <span key={l.id} className="flex items-center gap-1.5 text-xs text-green-400">
                                <Link2 size={11} />
                                <span className="truncate max-w-[220px]">{l.label ?? l.target_kind}</span>
                                <span className="font-mono text-gray-500">{money(l.amount)}</span>
                                {canEdit && (
                                  <button onClick={async () => { await deleteSapLink(l.id); loadLines(); load(); }}
                                    className="text-gray-600 hover:text-red-400">
                                    <Trash2 size={11} />
                                  </button>
                                )}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="py-2 text-right">
                        {canEdit && (
                          <button onClick={() => setLinkTarget(ln)}
                            className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 ml-auto">
                            <Link2 size={12} /> {t('costs.reconLink')}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-gray-600 mt-2">
              {t('costs.reconLinesCount', { count: lines.count, total: money(lines.total_actual) })}
              {lines.truncated ? ` · ${t('costs.reconTruncated')}` : ''}
            </p>
          </>
        )}
      </Panel>

      {linkTarget && (
        <LinkModal line={linkTarget} site={site} monthLabel={monthLabel}
          onClose={() => setLinkTarget(null)}
          onLinked={() => { setLinkTarget(null); loadLines(); load(); }} />
      )}
    </div>
  );
}

// ─── Link a GL line to a KAIZO record ────────────────────────────────────────

function LinkModal({ line, site, monthLabel, onClose, onLinked }: {
  line: SapLine;
  site: CostSite | null;
  monthLabel: (slot: number) => string;
  onClose: () => void;
  onLinked: () => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<LinkSuggestions | null>(null);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  const [amount, setAmount] = useState(String(Math.abs(line.actual - line.linked_amount)));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchLinkSuggestions({
      fiscal_year: line.fiscal_year, pos: line.pos,
      cost_center_code: line.cost_center_code, account_code: line.account_code, site,
    }).then(setData).finally(() => setLoading(false));
  }, [line, site]);

  const candidate = data?.candidates.find((c) => c.id === picked);

  const save = async () => {
    if (!candidate) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value === 0) { setError(t('costs.adjValidation')); return; }
    setSaving(true);
    setError(null);
    try {
      await createSapLink({
        fiscal_year: line.fiscal_year, pos: line.pos,
        cost_center_code: line.cost_center_code, account_code: line.account_code,
        target_kind: candidate.kind, target_id: candidate.id,
        amount: line.actual < 0 ? -value : value,
        note: note || undefined, origin: 'suggested',
      });
      onLinked();
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(detail === 'sap_link_exceeds_line' ? t('costs.reconLinkExceeds') : t('costs.reconLinkFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}>
      <div className="bg-[#0d1421] border border-white/10 rounded-xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 py-3 border-b border-white/[0.06]">
          <div>
            <h3 className="text-sm font-semibold text-white">{t('costs.reconLinkTitle')}</h3>
            <p className="text-xs text-gray-500 capitalize">
              {monthLabel(line.pos)} · {line.cost_center} · {line.account} · {signedMoney(line.actual)}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={18} /></button>
        </div>

        <div className="p-5 overflow-y-auto space-y-3">
          {loading ? (
            <div className="flex items-center justify-center h-32"><Spinner /></div>
          ) : !data || data.candidates.length === 0 ? (
            <p className="text-sm text-gray-500 py-6 text-center">{t('costs.reconNoCandidates')}</p>
          ) : (
            <>
              {data.ambiguous && (
                <p className="text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2 flex items-start gap-2">
                  <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
                  {t('costs.reconAmbiguous')}
                </p>
              )}
              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {data.candidates.map((c) => (
                  <button key={`${c.kind}-${c.id}`} onClick={() => setPicked(c.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${
                      picked === c.id
                        ? 'border-blue-500/50 bg-blue-500/10'
                        : 'border-white/[0.06] hover:border-white/[0.14]'}`}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-gray-200 truncate">{c.label}</span>
                      <span className="text-xs font-mono text-gray-400 flex-shrink-0">{money(c.amount)}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-gray-500 mt-0.5">
                      <span>{t(`costs.linkKind_${c.kind}`)}</span>
                      <span>·</span>
                      <span>{c.date}</span>
                      {c.detail && <><span>·</span><span className="truncate">{c.detail}</span></>}
                      <span className="ml-auto">{t('costs.reconMatchScore', { score: c.score })}</span>
                    </div>
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-white/[0.06]">
                <label className="text-xs text-gray-500">
                  {t('costs.reconLinkAmount')}
                  <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal"
                    className="input-field mt-1 w-full text-sm" />
                </label>
                <label className="text-xs text-gray-500 sm:col-span-2">
                  {t('costs.reconLinkNote')}
                  <input value={note} onChange={(e) => setNote(e.target.value)}
                    className="input-field mt-1 w-full text-sm" />
                </label>
              </div>
              <p className="text-[11px] text-gray-600">{t('costs.reconLinkExplains')}</p>
              {error && <p className="text-xs text-red-400">{error}</p>}
              <div className="flex justify-end gap-2">
                <button onClick={onClose} className="btn-secondary py-1.5 px-3 text-sm">{t('common.cancel')}</button>
                <button onClick={save} disabled={!candidate || saving}
                  className="btn-primary py-1.5 px-3 text-sm flex items-center gap-1.5 disabled:opacity-40">
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
                  {t('costs.reconConfirmLink')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
