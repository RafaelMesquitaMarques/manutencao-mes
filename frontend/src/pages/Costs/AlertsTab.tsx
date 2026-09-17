/**
 * Cost alerts and the action plan behind them.
 *
 * Every alert is evaluated live and ships the figures that produced it, so the
 * user can see WHY it fired and drill to the detail. Savings are kept in three
 * separate buckets — potential, implemented, verified — and the UI says plainly
 * that a deferred expense or a maintenance that was skipped is not a saving.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, BellRing, CheckCircle2, ClipboardList, Loader2, Plus, Save,
  SlidersHorizontal, Trash2, X,
} from 'lucide-react';
import {
  createCostAction, deleteCostAction, fetchCostActions, fetchCostAlertRules,
  fetchCostAlerts, saveCostAlertRules, updateCostAction,
  type ActionStatus, type CostActionRow, type CostActions, type CostAlert,
  type CostAlertRule, type CostAlerts, type CostScope, type CostSite,
  type MonthMapEntry, type SavingsType,
} from '../../api/costs';
import { fetchUsers } from '../../api/users';
import type { User } from '../../types';
import Spinner from '../../components/ui/Spinner';
import { Card, Panel, SEVERITY_CLASS, money, signedMoney } from './shared';

const ACTION_STATUSES: ActionStatus[] = ['open', 'in_progress', 'done', 'cancelled'];
const SAVINGS_TYPES: SavingsType[] = ['none', 'potential', 'implemented', 'verified'];

export default function AlertsTab({
  year, site, months, canEdit, monthYearLabel, onDrill,
}: {
  year: number;
  site: CostSite | null;
  months: number[];
  canEdit: boolean;
  monthYearLabel: (e: MonthMapEntry) => string;
  onDrill: (drill: CostAlert['drill']) => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || 'en').slice(0, 2);
  // Alerts are evaluated per envelope — the OPEX and CAPEX thresholds are not
  // the same conversation.
  const [scope, setScope] = useState<CostScope>('opex');
  const [alerts, setAlerts] = useState<CostAlerts | null>(null);
  const [actions, setActions] = useState<CostActions | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRules, setShowRules] = useState(false);
  const [newAction, setNewAction] = useState<{ title: string; alert?: CostAlert } | null>(null);

  const monthFrom = Math.min(...months);
  const monthTo = Math.max(...months);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, ac] = await Promise.all([
        fetchCostAlerts({ year, site, kind: scope, month_from: monthFrom, month_to: monthTo }),
        fetchCostActions({ year, site }),
      ]);
      setAlerts(a);
      setActions(ac);
    } finally {
      setLoading(false);
    }
  }, [year, site, scope, monthFrom, monthTo]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { fetchUsers().then(setUsers).catch(() => setUsers([])); }, []);

  const overdueActions = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return (actions?.actions ?? []).filter(
      (a) => a.due_date && a.due_date < today && a.status !== 'done' && a.status !== 'cancelled').length;
  }, [actions]);

  if (loading) return <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>;
  if (!alerts || !actions) return null;

  const patch = async (id: string, p: Parameters<typeof updateCostAction>[1]) => {
    await updateCostAction(id, p);
    load();
  };

  return (
    <div className="space-y-5">
      <div className="flex gap-1 bg-[#0d1421] border border-white/[0.06] rounded-lg p-1 w-fit">
        {(['opex', 'capex'] as CostScope[]).map((s) => (
          <button key={s} onClick={() => setScope(s)}
            className={`px-3 py-1.5 rounded text-xs font-semibold tracking-wide transition-colors ${
              scope === s ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
            {t(s === 'opex' ? 'costs.scopeOpex' : 'costs.scopeCapex')}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <Card icon={<AlertTriangle size={20} className="text-red-400" />} label={t('costs.alertCritical')}
          value={String(alerts.counts.critical)} sub={t('costs.alertLive')} color="red"
          valueClass={alerts.counts.critical ? 'text-red-400' : 'text-gray-400'} />
        <Card icon={<BellRing size={20} className="text-amber-400" />} label={t('costs.alertHigh')}
          value={String(alerts.counts.high + alerts.counts.medium)} sub={t('costs.alertLive')} color="amber" />
        <Card icon={<ClipboardList size={20} className="text-blue-400" />} label={t('costs.actionsOpen')}
          value={String(actions.counts.open + actions.counts.in_progress)}
          sub={t('costs.actionsOverdue', { count: overdueActions })} color="blue" />
        <Card icon={<CheckCircle2 size={20} className="text-gray-400" />} label={t('costs.savingsPotential')}
          value={money(actions.savings.potential)} sub={t('costs.savingsPotentialSub')} color="gray" />
        <Card icon={<CheckCircle2 size={20} className="text-cyan-400" />} label={t('costs.savingsImplemented')}
          value={money(actions.savings.implemented)} sub={t('costs.savingsImplementedSub')} color="cyan" />
        <Card icon={<CheckCircle2 size={20} className="text-green-400" />} label={t('costs.savingsVerified')}
          value={money(actions.savings.verified)} sub={t('costs.savingsVerifiedSub')} color="green" />
      </div>

      <p className="text-[11px] text-gray-600">{t('costs.savingsRule')}</p>

      <Panel icon={<BellRing size={15} className="text-gray-500" />} title={t('costs.alertsTitle')}
        subtitle={t('costs.alertsSub')}
        right={canEdit && (
          <button onClick={() => setShowRules(true)} className="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5">
            <SlidersHorizontal size={13} /> {t('costs.alertRules')}
          </button>
        )}>
        {alerts.alerts.length === 0 ? (
          <p className="text-sm text-gray-600 py-8 text-center">{t('costs.alertsNone')}</p>
        ) : (
          <div className="space-y-2">
            {alerts.alerts.map((a, i) => (
              <div key={`${a.kind}-${i}`}
                className="border border-white/[0.06] rounded-lg px-3 py-2.5 hover:border-white/[0.12] transition-colors">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${
                        SEVERITY_CLASS[a.severity]}`}>
                        {t(`costs.severity_${a.severity}`)}
                      </span>
                      <span className="text-sm text-gray-200">
                        {t(`costs.alertKind_${a.kind}`, {
                          subject: a.subject ?? '', value: a.value, threshold: a.threshold,
                        })}
                      </span>
                      {a.amount != null && a.amount !== 0 && (
                        <span className="text-sm font-mono text-gray-400">{signedMoney(a.amount)}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-x-4 gap-y-1 flex-wrap mt-1">
                      {a.evidence.map((e) => (
                        <span key={e.key} className="text-[11px] text-gray-500">
                          {t(`costs.evidence_${e.key}`)}:{' '}
                          <span className="text-gray-400 font-mono">
                            {formatEvidence(e.value, monthYearLabel, lang)}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button onClick={() => onDrill(a.drill)}
                      className="text-xs text-blue-400 hover:text-blue-300">
                      {t('costs.alertDrill')}
                    </button>
                    {canEdit && (
                      <button onClick={() => setNewAction({
                        title: t(`costs.alertKind_${a.kind}`, {
                          subject: a.subject ?? '', value: a.value, threshold: a.threshold }),
                        alert: a,
                      })}
                        className="text-xs btn-secondary py-1 px-2 flex items-center gap-1">
                        <Plus size={11} /> {t('costs.alertCreateAction')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel icon={<ClipboardList size={15} className="text-gray-500" />} title={t('costs.actionsTitle')}
        subtitle={t('costs.actionsSub')}
        right={canEdit && (
          <button onClick={() => setNewAction({ title: '' })} className="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5">
            <Plus size={13} /> {t('costs.actionNew')}
          </button>
        )}>
        {actions.actions.length === 0 ? (
          <p className="text-sm text-gray-600 py-8 text-center">{t('costs.actionsNone')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] text-gray-500 text-xs uppercase tracking-wider">
                  <th className="text-left py-2 pr-3 font-medium">{t('costs.actionTitle')}</th>
                  <th className="text-left py-2 px-3 font-medium">{t('costs.actionOwner')}</th>
                  <th className="text-left py-2 px-3 font-medium">{t('costs.actionDue')}</th>
                  <th className="text-left py-2 px-3 font-medium">{t('costs.actionStatus')}</th>
                  <th className="text-left py-2 px-3 font-medium">{t('costs.actionSavings')}</th>
                  <th className="text-right py-2 px-3 font-medium">{t('costs.actionAmount')}</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {actions.actions.map((a) => (
                  <ActionRow key={a.id} action={a} users={users} canEdit={canEdit}
                    onPatch={patch} onDelete={async (id) => { await deleteCostAction(id); load(); }} lang={lang} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {showRules && (
        <RulesModal site={site} onClose={() => setShowRules(false)}
          onSaved={() => { setShowRules(false); load(); }} canEdit={canEdit} />
      )}
      {newAction && (
        <NewActionModal initialTitle={newAction.title} alert={newAction.alert} users={users}
          year={year} site={site} onClose={() => setNewAction(null)}
          onSaved={() => { setNewAction(null); load(); }} />
      )}
    </div>
  );
}

function formatEvidence(
  value: unknown,
  monthYearLabel: (e: MonthMapEntry) => string,
  lang: string,
): string {
  if (value == null) return '—';
  if (Array.isArray(value)) {
    if (value.length === 2 && value.every((v) => typeof v === 'number')) {
      return `${money(value[0] as number)} – ${money(value[1] as number)}`;
    }
    return value.map(String).join(', ');
  }
  if (typeof value === 'object') {
    const v = value as MonthMapEntry;
    return v?.month ? monthYearLabel(v) : JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return Math.abs(value) >= 1000 ? money(value) : String(Math.round(value * 10) / 10);
  }
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? new Date(s).toLocaleDateString(lang) : s;
}

function ActionRow({ action, users, canEdit, onPatch, onDelete, lang }: {
  action: CostActionRow;
  users: User[];
  canEdit: boolean;
  onPatch: (id: string, patch: Parameters<typeof updateCostAction>[1]) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  lang: string;
}) {
  const { t } = useTranslation();
  const overdue = action.due_date && action.due_date < new Date().toISOString().slice(0, 10)
    && action.status !== 'done' && action.status !== 'cancelled';
  return (
    <tr className="border-b border-white/[0.03] hover:bg-white/[0.02]">
      <td className="py-2 pr-3 text-gray-200">
        {action.title}
        {action.context_ref && (
          <span className="block text-[11px] text-gray-600">
            {t(`costs.context_${action.context_kind}`)}: {action.context_ref}
          </span>
        )}
      </td>
      <td className="py-2 px-3">
        {canEdit ? (
          <select value={action.owner_id ?? ''} onChange={(e) => onPatch(action.id, { owner_id: e.target.value || null })}
            className="input-field text-xs py-1 px-2 w-36">
            <option value="">{t('costs.actionNoOwner')}</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        ) : (
          <span className="text-gray-400 text-xs">{action.owner_name ?? '—'}</span>
        )}
      </td>
      <td className="py-2 px-3">
        {canEdit ? (
          <input type="date" value={action.due_date ?? ''}
            onChange={(e) => onPatch(action.id, { due_date: e.target.value || null })}
            className={`input-field text-xs py-1 px-2 ${overdue ? 'text-red-400' : ''}`} />
        ) : (
          <span className={`text-xs ${overdue ? 'text-red-400' : 'text-gray-400'}`}>
            {action.due_date ? new Date(`${action.due_date}T00:00:00`).toLocaleDateString(lang) : '—'}
          </span>
        )}
      </td>
      <td className="py-2 px-3">
        {canEdit ? (
          <select value={action.status} onChange={(e) => onPatch(action.id, { status: e.target.value as ActionStatus })}
            className="input-field text-xs py-1 px-2">
            {ACTION_STATUSES.map((s) => <option key={s} value={s}>{t(`costs.actionStatus_${s}`)}</option>)}
          </select>
        ) : (
          <span className="text-xs text-gray-400">{t(`costs.actionStatus_${action.status}`)}</span>
        )}
      </td>
      <td className="py-2 px-3">
        {canEdit ? (
          <select value={action.savings_type}
            onChange={(e) => onPatch(action.id, { savings_type: e.target.value as SavingsType })}
            className="input-field text-xs py-1 px-2">
            {SAVINGS_TYPES.map((s) => <option key={s} value={s}>{t(`costs.savings_${s}`)}</option>)}
          </select>
        ) : (
          <span className="text-xs text-gray-400">{t(`costs.savings_${action.savings_type}`)}</span>
        )}
      </td>
      <td className="py-2 px-3 text-right font-mono text-gray-300">
        {action.savings_amount == null ? '—' : money(action.savings_amount)}
      </td>
      <td className="py-2 text-right">
        {canEdit && (
          <button onClick={() => onDelete(action.id)} className="text-gray-600 hover:text-red-400">
            <Trash2 size={14} />
          </button>
        )}
      </td>
    </tr>
  );
}

function NewActionModal({ initialTitle, alert, users, year, site, onClose, onSaved }: {
  initialTitle: string;
  alert?: CostAlert;
  users: User[];
  year: number;
  site: CostSite | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState('');
  const [due, setDue] = useState('');
  const [savingsType, setSavingsType] = useState<SavingsType>('none');
  const [savingsAmount, setSavingsAmount] = useState('');
  const [saving, setSaving] = useState(false);

  const contextKind = alert?.drill?.equipment_id ? 'equipment'
    : alert?.drill?.cost_center ? 'cost_center'
      : alert?.kind === 'stale_commitments' ? 'purchase_order'
        : alert?.kind === 'stale_import' ? 'import' : 'other';

  const submit = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await createCostAction({
        title: title.trim(), description: description || undefined,
        alert_kind: alert?.kind ?? null, context_kind: contextKind,
        context_ref: alert?.subject ?? alert?.drill?.cost_center ?? null,
        owner_id: owner || null, due_date: due || null, fiscal_year: year,
        savings_type: savingsType,
        savings_amount: savingsAmount ? Number(savingsAmount) : null,
      }, site);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[#0d1421] border border-white/10 rounded-xl w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
          <h3 className="text-sm font-semibold text-white">{t('costs.actionNew')}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-3">
          <label className="block text-xs text-gray-500">
            {t('costs.actionTitle')}
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="input-field mt-1 w-full text-sm" />
          </label>
          <label className="block text-xs text-gray-500">
            {t('costs.actionDescription')}
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
              className="input-field mt-1 w-full text-sm" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-gray-500">
              {t('costs.actionOwner')}
              <select value={owner} onChange={(e) => setOwner(e.target.value)} className="input-field mt-1 w-full text-sm">
                <option value="">{t('costs.actionNoOwner')}</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
            <label className="block text-xs text-gray-500">
              {t('costs.actionDue')}
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="input-field mt-1 w-full text-sm" />
            </label>
            <label className="block text-xs text-gray-500">
              {t('costs.actionSavings')}
              <select value={savingsType} onChange={(e) => setSavingsType(e.target.value as SavingsType)}
                className="input-field mt-1 w-full text-sm">
                {SAVINGS_TYPES.map((s) => <option key={s} value={s}>{t(`costs.savings_${s}`)}</option>)}
              </select>
            </label>
            <label className="block text-xs text-gray-500">
              {t('costs.actionAmount')}
              <input value={savingsAmount} onChange={(e) => setSavingsAmount(e.target.value)} inputMode="decimal"
                className="input-field mt-1 w-full text-sm" disabled={savingsType === 'none'} />
            </label>
          </div>
          <p className="text-[11px] text-gray-600">{t('costs.savingsRule')}</p>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="btn-secondary py-1.5 px-3 text-sm">{t('common.cancel')}</button>
            <button onClick={submit} disabled={saving || !title.trim()}
              className="btn-primary py-1.5 px-3 text-sm flex items-center gap-1.5 disabled:opacity-40">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RulesModal({ site, onClose, onSaved, canEdit }: {
  site: CostSite | null;
  onClose: () => void;
  onSaved: () => void;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const [rules, setRules] = useState<CostAlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchCostAlertRules(site).then((r) => setRules(r.rules)).finally(() => setLoading(false));
  }, [site]);

  const save = async () => {
    setSaving(true);
    try {
      await saveCostAlertRules(
        rules.map((r) => ({ kind: r.kind, enabled: r.enabled, threshold: r.threshold, scope: r.scope })),
        site);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[#0d1421] border border-white/10 rounded-xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
          <div>
            <h3 className="text-sm font-semibold text-white">{t('costs.alertRules')}</h3>
            <p className="text-xs text-gray-500">{t('costs.alertRulesSub')}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={18} /></button>
        </div>
        <div className="p-5 overflow-y-auto space-y-2">
          {loading ? <Spinner /> : rules.map((r, i) => (
            <div key={r.kind} className="flex items-center gap-3 border-b border-white/[0.04] pb-2">
              <input type="checkbox" checked={r.enabled} disabled={!canEdit}
                onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))}
                className="accent-blue-500" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-200">{t(`costs.ruleName_${r.kind}`)}</p>
                <p className="text-[11px] text-gray-600">{t(`costs.ruleHint_${r.kind}`)}</p>
              </div>
              <input value={r.threshold} disabled={!canEdit} inputMode="decimal"
                onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, threshold: Number(e.target.value) || 0 } : x)))}
                className="input-field text-xs py-1 px-2 w-24 text-right" />
              <span className="text-[11px] text-gray-600 w-16">{t(`costs.ruleUnit_${r.kind}`)}</span>
            </div>
          ))}
        </div>
        {canEdit && (
          <div className="flex justify-end gap-2 px-5 py-3 border-t border-white/[0.06]">
            <button onClick={onClose} className="btn-secondary py-1.5 px-3 text-sm">{t('common.cancel')}</button>
            <button onClick={save} disabled={saving} className="btn-primary py-1.5 px-3 text-sm flex items-center gap-1.5">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} {t('common.save')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
