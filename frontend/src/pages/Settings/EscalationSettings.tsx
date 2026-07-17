import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bell, MessageSquare, MessagesSquare, Mail, Clock, Trash2, Plus, Send, CheckCircle,
  AlertTriangle, RefreshCw, FileText, SlidersHorizontal, Search,
  Users, History, Factory,
} from 'lucide-react';
import {
  fetchEscalationSettings, updateEscalationSettings,
  addEscalationContact, updateEscalationContact, deleteEscalationContact,
  fetchNotificationLog, resendNotification, sendTestSms, sendTestTeams, fetchShiftReportPreview,
  type EscalationSettings as Settings, type EscalationContact, type NotificationLogEntry,
} from '../../api/escalation';
import { fetchUsers } from '../../api/users';
import { fetchMachinesAll } from '../../api/machines';
import type { Machine, User } from '../../types';

type ContactChanges = Parameters<typeof updateEscalationContact>[1];
type Tab = 'rules' | 'recipients' | 'templates' | 'activity';

const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
// Triggers with a per-channel row in the matrix (reminders follow "escalation")
const TRIGGERS = [
  'critical_alert', 'escalation', 'ticket_opened',
  'ticket_completed', 'ticket_assigned', 'claimable_tech',
] as const;
const CHANNELS = ['sms', 'email', 'teams'] as const;
type Channel = (typeof CHANNELS)[number];
const TEMPLATE_KEYS = [
  'critical_alert', 'escalation', 'escalation_reminder', 'ticket_opened',
  'ticket_completed', 'ticket_assigned', 'claimable_tech',
] as const;
const LOG_TYPES = ['sms', 'email', 'teams'] as const;
const LOG_STATUSES = ['sent', 'simulated', 'failed'] as const;

const STATUS_STYLE: Record<string, string> = {
  sent:      'bg-green-900/40 text-green-300 border-green-700',
  simulated: 'bg-gray-800 text-gray-400 border-gray-600',
  failed:    'bg-red-900/40 text-red-300 border-red-700',
};

const PRIORITY_CHIP: Record<string, string> = {
  critical: 'text-red-400 border-red-500/30',
  high:     'text-orange-400 border-orange-500/30',
  medium:   'text-amber-400 border-amber-500/30',
  low:      'text-green-400 border-green-500/30',
};

export default function EscalationSettingsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('rules');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [contacts, setContacts] = useState<EscalationContact[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [log, setLog] = useState<NotificationLogEntry[]>([]);
  const [logTotal, setLogTotal] = useState(0);
  const [logLimit, setLogLimit] = useState(50);
  const [logType, setLogType] = useState('');
  const [logStatus, setLogStatus] = useState('');
  const [logQuery, setLogQuery] = useState('');
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [testResult, setTestResult] = useState('');
  const [teamsTestResult, setTeamsTestResult] = useState('');
  const [reportPreview, setReportPreview] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cfg, allUsers, allMachines] = await Promise.all([
        fetchEscalationSettings(),
        fetchUsers().catch(() => [] as User[]),
        fetchMachinesAll().catch(() => [] as Machine[]),
      ]);
      setSettings(cfg.settings);
      setContacts(cfg.contacts);
      setUsers(allUsers.filter(u => u.active));
      setMachines(allMachines.filter(m => m.is_active));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const refreshLog = useCallback(async () => {
    try {
      const r = await fetchNotificationLog({
        limit: logLimit,
        type: logType || undefined,
        status: logStatus || undefined,
        q: logQuery.trim() || undefined,
      });
      setLog(r.items);
      setLogTotal(r.total);
    } catch {
      setLog([]);
      setLogTotal(0);
    }
  }, [logLimit, logType, logStatus, logQuery]);

  useEffect(() => { refreshLog(); }, [refreshLog]);

  const patch = (changes: Partial<Settings>) => {
    setSettings(s => (s ? { ...s, ...changes } : s));
    setDirty(true);
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const updated = await updateEscalationSettings(settings);
      setSettings(updated);
      setDirty(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const addContact = async (level: number, userId: string) => {
    if (!userId) return;
    const created = await addEscalationContact({ level, user_id: userId });
    setContacts(prev => [...prev.filter(c => c.id !== created.id), created]);
  };

  const patchContact = async (c: EscalationContact, changes: ContactChanges) => {
    const updated = await updateEscalationContact(c.id, changes);
    setContacts(prev => prev.map(x => (x.id === c.id ? updated : x)));
  };

  const removeContact = async (c: EscalationContact) => {
    await deleteEscalationContact(c.id);
    setContacts(prev => prev.filter(x => x.id !== c.id));
  };

  const handlePreviewReport = async () => {
    setReportPreview('…');
    try {
      const r = await fetchShiftReportPreview();
      setReportPreview(r.text);
    } catch {
      setReportPreview(t('escalation.shiftReportNoData', 'No ended shift window found — configure machine shifts first.'));
    }
  };

  const handleTestSms = async () => {
    setTestResult('…');
    try {
      const r = await sendTestSms(testPhone || undefined);
      setTestResult(`${r.status} → ${r.phone}`);
      await refreshLog();
    } catch {
      setTestResult(t('escalation.testFailed', 'failed — check the phone number'));
    }
  };

  const handleResend = async (n: NotificationLogEntry) => {
    setResendingId(n.id);
    try {
      await resendNotification(n.id);
      await refreshLog();
    } finally {
      setResendingId(null);
    }
  };

  const matrixOn = (trigger: string, ch: Channel): boolean => {
    const v = settings?.channel_matrix?.[trigger]?.[ch];
    return v === undefined || v === null ? true : !!v;
  };

  const toggleMatrix = (trigger: string, ch: Channel) => {
    patch({
      channel_matrix: {
        ...(settings?.channel_matrix || {}),
        [trigger]: Object.fromEntries(CHANNELS.map(c => [
          c, c === ch ? !matrixOn(trigger, c) : matrixOn(trigger, c),
        ])),
      },
    });
  };

  const handleTestTeams = async () => {
    setTeamsTestResult('…');
    try {
      const r = await sendTestTeams(settings?.teams_webhook_url || undefined);
      setTeamsTestResult(r.status);
      await refreshLog();
    } catch {
      setTeamsTestResult(t('escalation.teamsTestFailed', 'failed — check the webhook URL'));
    }
  };

  const setTemplate = (key: string, text: string) => {
    const next = { ...(settings?.sms_templates || {}) };
    if (text) next[key] = text;
    else delete next[key];
    patch({ sms_templates: next });
  };

  if (loading || !settings) {
    return <div className="p-6 text-gray-500 text-sm">{t('common.loading', 'Loading…')}</div>;
  }

  const maxLevel = Math.min(Math.max(settings.max_escalation_level || 3, 1), 5);
  const levels = Array.from({ length: maxLevel }, (_, i) => i + 1);
  const activeContacts = contacts.filter(c => c.is_active).length;

  const TABS: { id: Tab; icon: React.ReactNode; label: string; badge?: number }[] = [
    { id: 'rules',      icon: <SlidersHorizontal size={14} />, label: t('escalation.tabRules', 'Rules & SLA') },
    { id: 'recipients', icon: <Users size={14} />,             label: t('escalation.tabRecipients', 'Recipients'), badge: activeContacts },
    { id: 'templates',  icon: <MessageSquare size={14} />,     label: t('escalation.tabTemplates', 'SMS templates') },
    { id: 'activity',   icon: <History size={14} />,           label: t('escalation.tabActivity', 'Log & test'), badge: logTotal },
  ];

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Bell size={22} className="text-amber-400" />
            {t('escalation.title', 'Escalation & Notifications')}
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {t('escalation.subtitle', 'SLA thresholds, recipients per level and SMS settings')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`px-2.5 py-1 rounded-full border text-xs font-medium ${
            settings.twilio_configured
              ? 'bg-green-900/40 text-green-300 border-green-700'
              : 'bg-amber-900/30 text-amber-300 border-amber-700'
          }`}>
            {settings.twilio_configured
              ? t('escalation.twilioOn', 'Twilio connected')
              : t('escalation.twilioOff', 'Simulation mode — set TWILIO_* in .env')}
          </span>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded-xl disabled:opacity-50"
          >
            {savedFlash && <CheckCircle size={15} />}
            {dirty && !saving && !savedFlash && <span className="w-1.5 h-1.5 rounded-full bg-amber-300 animate-pulse" />}
            {savedFlash ? t('common.saved', 'Saved') : saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-white/[0.08]">
        {TABS.map(tb => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`flex items-center gap-1.5 px-3.5 py-2.5 text-sm border-b-2 -mb-px transition-colors ${
              tab === tb.id
                ? 'text-white border-blue-500 font-medium'
                : 'text-gray-500 border-transparent hover:text-gray-300'
            }`}
          >
            {tb.icon}
            {tb.label}
            {tb.badge !== undefined && tb.badge > 0 && (
              <span className={`px-1.5 py-0.5 rounded-full text-[10px] leading-none ${
                tab === tb.id ? 'bg-blue-500/20 text-blue-300' : 'bg-gray-800 text-gray-500'
              }`}>
                {tb.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Tab: rules & SLA ─────────────────────────────────────────────── */}
      {tab === 'rules' && (
        <div className="space-y-5">
          <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-5">
            <h3 className="text-sm font-semibold text-gray-300 mb-1 flex items-center gap-2">
              <Clock size={15} className="text-blue-400" />
              {t('escalation.slaTitle', 'SLA thresholds (minutes before escalation)')}
            </h3>
            <p className="text-xs text-gray-600 mb-4">
              {t('escalation.slaHint', 'An open alert escalates one level each time this delay passes, up to the max level.')}
            </p>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
              <SlaInput label={t('priority.critical', 'Critical')} color="text-red-400"
                value={settings.sla_critical_minutes} onChange={v => patch({ sla_critical_minutes: v })} />
              <SlaInput label={t('priority.high', 'High')} color="text-orange-400"
                value={settings.sla_high_minutes} onChange={v => patch({ sla_high_minutes: v })} />
              <SlaInput label={t('priority.medium', 'Medium')} color="text-amber-400"
                value={settings.sla_medium_minutes} onChange={v => patch({ sla_medium_minutes: v })} />
              <SlaInput label={t('priority.low', 'Low')} color="text-green-400"
                value={settings.sla_low_minutes} onChange={v => patch({ sla_low_minutes: v })} />
              <SlaInput label={t('escalation.maxLevel', 'Max level')} color="text-purple-400"
                value={settings.max_escalation_level} onChange={v => patch({ max_escalation_level: Math.min(Math.max(v, 1), 5) })} />
              <SlaInput label={t('escalation.reminder', 'Reminder (0 = off)')} color="text-cyan-400" min={0}
                value={settings.reminder_minutes ?? 0} onChange={v => patch({ reminder_minutes: Math.max(v, 0) })} />
            </div>
          </div>

          <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-5">
            <h3 className="text-sm font-semibold text-gray-300 mb-4">
              {t('escalation.triggersTitle', 'Channels & triggers')}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Toggle icon={<MessageSquare size={14} className="text-green-400" />}
                label={t('escalation.smsEnabled', 'SMS notifications')}
                checked={settings.sms_enabled} onChange={v => patch({ sms_enabled: v })} />
              <Toggle icon={<Mail size={14} className="text-blue-400" />}
                label={t('escalation.emailEnabled', 'Email notifications')}
                checked={settings.email_enabled} onChange={v => patch({ email_enabled: v })} />
              <Toggle icon={<MessagesSquare size={14} className="text-purple-400" />}
                label={t('escalation.teamsEnabled', 'Microsoft Teams — post each event to a channel')}
                checked={settings.teams_enabled} onChange={v => patch({ teams_enabled: v })} />
              <Toggle icon={<AlertTriangle size={14} className="text-red-400" />}
                label={t('escalation.onCritical', 'Immediate alert on new critical ticket/alert')}
                checked={settings.notify_on_critical_alert} onChange={v => patch({ notify_on_critical_alert: v })} />
              <Toggle icon={<Bell size={14} className="text-amber-400" />}
                label={t('escalation.onAssigned', 'Notify technician when a ticket is assigned')}
                checked={settings.notify_on_ticket_assigned} onChange={v => patch({ notify_on_ticket_assigned: v })} />
              <Toggle icon={<Clock size={14} className="text-purple-400" />}
                label={t('escalation.onPmOverdue', 'Notify when preventive maintenance is overdue')}
                checked={settings.notify_on_pm_overdue} onChange={v => patch({ notify_on_pm_overdue: v })} />
              <Toggle icon={<Bell size={14} className="text-green-400" />}
                label={t('escalation.onTicketOpened', 'Notify ticket group on every new ticket')}
                checked={settings.notify_on_ticket_opened} onChange={v => patch({ notify_on_ticket_opened: v })} />
              <Toggle icon={<CheckCircle size={14} className="text-teal-400" />}
                label={t('escalation.onTicketCompleted', 'Notify ticket group when a ticket is completed')}
                checked={settings.notify_on_ticket_completed} onChange={v => patch({ notify_on_ticket_completed: v })} />
              <Toggle icon={<Send size={14} className="text-amber-400" />}
                label={t('escalation.selfAssign', 'Technicians can self-assign tickets (My Work) — turn off when a supervisor dispatches')}
                checked={settings.technician_self_assign} onChange={v => patch({ technician_self_assign: v })} />
              <Toggle icon={<FileText size={14} className="text-cyan-400" />}
                label={t('escalation.shiftReport', 'End-of-shift report by SMS to shift supervisors (level 1)')}
                checked={settings.shift_report_enabled} onChange={v => patch({ shift_report_enabled: v })} />
              <Toggle icon={<Clock size={14} className="text-blue-400" />}
                label={t('escalation.pausePlanned', 'Do not escalate while the machine is in a planned stop')}
                checked={settings.pause_during_planned_stop ?? true} onChange={v => patch({ pause_during_planned_stop: v })} />
            </div>

            {/* Teams channel webhook — shown only when the channel is on */}
            {settings.teams_enabled && (
              <div className="mt-3 bg-[#0a1628] border border-purple-500/20 rounded-lg p-3">
                <label className="text-[11px] text-gray-500 block mb-1">
                  {t('escalation.teamsUrlLabel', 'Teams channel webhook URL (Workflows)')}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={settings.teams_webhook_url || ''}
                    onChange={e => patch({ teams_webhook_url: e.target.value })}
                    placeholder="https://…logic.azure.com/workflows/…"
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 font-mono focus:outline-none focus:border-purple-500"
                  />
                  <button onClick={handleTestTeams}
                    disabled={!(settings.teams_webhook_url || '').trim()}
                    className="text-xs px-3 py-1.5 rounded-lg border border-purple-700/50 text-purple-300 hover:bg-purple-900/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap">
                    {t('escalation.teamsTest', 'Send a test card')}
                  </button>
                  {teamsTestResult && <span className="text-[11px] text-gray-400">{teamsTestResult}</span>}
                </div>
                {(settings.teams_webhook_url || '').trim() !== '' &&
                  !(settings.teams_webhook_url || '').trim().toLowerCase().startsWith('https://') && (
                  <p className="text-[11px] text-red-400 mt-1">
                    {t('escalation.teamsUrlInvalid', 'The URL must start with https://')}
                  </p>
                )}
                <p className="text-[11px] text-gray-600 mt-2">
                  {t('escalation.teamsUrlHint', 'In the Teams channel: ⋯ → Workflows → "Post to a channel when a webhook request is received" → copy the URL. Anyone holding this URL can post to the channel — treat it as a secret.')}
                </p>
              </div>
            )}

            <div className="mt-3">
              <button onClick={handlePreviewReport}
                className="text-xs px-3 py-1.5 rounded-lg border border-cyan-700/50 text-cyan-300 hover:bg-cyan-900/20 transition-colors">
                {t('escalation.shiftReportPreview', 'Preview the last shift report')}
              </button>
              {reportPreview && (
                <pre className="mt-2 text-[11px] text-gray-300 bg-[#0a1628] border border-white/[0.06] rounded-lg p-3 whitespace-pre-wrap">
                  {reportPreview}
                </pre>
              )}
            </div>

            {/* Channel per trigger */}
            <div className="mt-4 border-t border-white/[0.06] pt-4">
              <h4 className="text-xs font-semibold text-gray-400 mb-2">
                {t('escalation.matrixTitle', 'Channel per event')}
              </h4>
              <table className="text-xs max-w-xl w-full">
                <thead>
                  <tr className="text-[10px] text-gray-600 uppercase tracking-wider">
                    <th className="text-left py-1 font-medium">{t('escalation.matrixEvent', 'Event')}</th>
                    <th className="w-16 text-center py-1 font-medium">SMS</th>
                    <th className="w-16 text-center py-1 font-medium">Email</th>
                    <th className="w-16 text-center py-1 font-medium">Teams</th>
                  </tr>
                </thead>
                <tbody>
                  {TRIGGERS.map(trig => (
                    <tr key={trig} className="border-t border-white/[0.04]">
                      <td className="py-1.5 text-gray-300">{t(`escalation.trigger.${trig}`)}</td>
                      {CHANNELS.map(ch => (
                        <td key={ch} className="text-center py-1.5">
                          <input
                            type="checkbox"
                            checked={matrixOn(trig, ch)}
                            onChange={() => toggleMatrix(trig, ch)}
                            className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500"
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Tab: recipients ──────────────────────────────────────────────── */}
      {tab === 'recipients' && (
        <div className="space-y-5">
          {/* Ticket open/close notification group (level 0) */}
          <div className="bg-[#0d1421] border border-teal-500/20 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-gray-300 mb-1 flex items-center gap-2">
              <Bell size={14} className="text-teal-400" />
              {t('escalation.ticketGroupTitle', 'Ticket notifications group (open & close)')}
            </h3>
            <p className="text-[11px] text-gray-600 mb-3">
              {t('escalation.ticketGroupHint', 'These contacts receive an SMS/email when a ticket is opened or completed, at or above the minimum priority below.')}
            </p>
            <div className="flex items-center gap-2 mb-3">
              <label className="text-[11px] text-gray-500">
                {t('escalation.minPriority', 'Minimum ticket priority')}
              </label>
              <select
                value={settings.ticket_group_min_priority || 'low'}
                onChange={e => patch({ ticket_group_min_priority: e.target.value as Settings['ticket_group_min_priority'] })}
                className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-teal-500"
              >
                {PRIORITIES.map(p => (
                  <option key={p} value={p}>{t(`priority.${p}`)}</option>
                ))}
              </select>
              <span className="text-[10px] text-gray-600">
                {t('escalation.minPrioritySave', 'applies after Save')}
              </span>
            </div>
            <ContactList
              contacts={contacts.filter(c => c.level === 0 && c.is_active)}
              emptyText={t('escalation.ticketGroupEmpty', 'No contacts — these notifications are not sent to anyone yet.')}
              machines={machines}
              onPatch={patchContact}
              onRemove={removeContact}
            />
            <AddContactSelect
              users={users}
              exclude={contacts.filter(c => c.level === 0 && c.is_active).map(c => c.user_id)}
              onAdd={id => addContact(0, id)}
              accent="teal"
            />
          </div>

          {/* Escalation chain */}
          <div>
            <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
              <AlertTriangle size={14} className="text-amber-400" />
              {t('escalation.levelsTitle', 'Escalation chain')}
            </h3>
            <div>
              {levels.map((level, i) => {
                const levelContacts = contacts.filter(c => c.level === level && c.is_active);
                return (
                  <div key={level} className="relative pl-11 pb-4">
                    {i < levels.length - 1 && (
                      <div className="absolute left-[15px] top-9 bottom-0 w-px bg-white/[0.08]" />
                    )}
                    <div className={`absolute left-0 top-2.5 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border ${
                      levelContacts.length > 0
                        ? 'bg-blue-500/15 text-blue-300 border-blue-500/40'
                        : 'bg-gray-800/60 text-gray-500 border-white/[0.08]'
                    }`}>
                      {level}
                    </div>
                    <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <h4 className="text-sm font-semibold text-gray-300">
                          {t('escalation.level', 'Level')} {level}
                        </h4>
                        <span className="text-[11px] text-gray-600">
                          {level === 1 && t('escalation.level1Hint', 'First escalation + new critical alerts')}
                          {level === 2 && t('escalation.level2Hint', 'Second escalation')}
                          {level >= 3 && t('escalation.level3Hint', 'Final escalation')}
                        </span>
                        <span
                          className="ml-auto flex items-center gap-1"
                          title={t('escalation.levelReachedAfter', 'An open alert reaches this level after')}
                        >
                          {PRIORITIES.slice().reverse().map(p => {
                            const sla = {
                              critical: settings.sla_critical_minutes,
                              high: settings.sla_high_minutes,
                              medium: settings.sla_medium_minutes,
                              low: settings.sla_low_minutes,
                            }[p];
                            return (
                              <span key={p} className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${PRIORITY_CHIP[p]}`}>
                                {t(`priority.${p}`)} {level * (sla || 0)}m
                              </span>
                            );
                          })}
                        </span>
                      </div>
                      <ContactList
                        contacts={levelContacts}
                        emptyText={t('escalation.fallback', 'No contacts — falls back to users by role.')}
                        machines={machines}
                        onPatch={patchContact}
                        onRemove={removeContact}
                      />
                      <AddContactSelect
                        users={users}
                        exclude={levelContacts.map(c => c.user_id)}
                        onAdd={id => addContact(level, id)}
                        accent="blue"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── Tab: SMS templates ───────────────────────────────────────────── */}
      {tab === 'templates' && (
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-300 mb-1 flex items-center gap-2">
            <MessageSquare size={15} className="text-purple-400" />
            {t('escalation.templatesTitle', 'SMS templates')}
          </h3>
          <p className="text-xs text-gray-600 mb-4">
            {t('escalation.templatesHint', 'Empty = default text. Variables:')}{' '}
            <code className="text-[11px] text-purple-300">{'{number} {machine} {priority} {description} {level} {technician}'}</code>
          </p>
          <div className="space-y-3">
            {TEMPLATE_KEYS.map(key => {
              const value = settings.sms_templates?.[key] ?? '';
              return (
                <div key={key}>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs text-gray-400">{t(`escalation.trigger.${key}`)}</label>
                    <span className="flex items-center gap-3">
                      {value && (
                        <span className={`text-[10px] font-mono ${value.length > 160 ? 'text-amber-400' : 'text-gray-600'}`}>
                          {t('escalation.charCount', '{{count}} chars', { count: value.length })}
                          {value.length > 160 && ` · ${t('escalation.smsSegments', '{{count}} SMS', { count: Math.ceil(value.length / 153) })}`}
                        </span>
                      )}
                      {value && (
                        <button
                          onClick={() => setTemplate(key, '')}
                          className="text-[11px] text-gray-500 hover:text-gray-300"
                        >
                          {t('escalation.templateReset', 'Reset to default')}
                        </button>
                      )}
                    </span>
                  </div>
                  <textarea
                    rows={2}
                    value={value}
                    placeholder={settings.sms_template_defaults?.[key] ?? ''}
                    onChange={e => setTemplate(key, e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-200 font-mono focus:outline-none focus:border-purple-500 resize-y"
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Tab: activity (test + log) ───────────────────────────────────── */}
      {tab === 'activity' && (
        <div className="space-y-5">
          <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-5">
            <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
              <Send size={15} className="text-green-400" />
              {t('escalation.testTitle', 'Send a test SMS')}
            </h3>
            <div className="flex items-center gap-3 flex-wrap">
              <input
                value={testPhone}
                onChange={e => setTestPhone(e.target.value)}
                placeholder={t('escalation.testPlaceholder', '+1 514 555 0100 (or leave empty for your profile phone)')}
                className="flex-1 min-w-[260px] bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-500"
              />
              <button
                onClick={handleTestSms}
                className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-green-600 hover:bg-green-500 rounded-lg"
              >
                <Send size={14} /> {t('escalation.testSend', 'Send test')}
              </button>
              {testResult && <span className="text-xs font-mono text-gray-400">{testResult}</span>}
            </div>
          </div>

          <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-gray-300">
                {t('escalation.logTitle', 'Recent notifications')}
              </h3>
              <span className="text-[11px] text-gray-600">({logTotal})</span>
              <div className="ml-auto flex items-center gap-2 flex-wrap">
                <div className="relative">
                  <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-600" />
                  <input
                    value={logQuery}
                    onChange={e => setLogQuery(e.target.value)}
                    placeholder={t('escalation.logSearch', 'Search…')}
                    className="pl-6 pr-2 py-1 w-40 bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-300 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <select value={logType} onChange={e => setLogType(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs text-gray-300 focus:outline-none">
                  <option value="">{t('escalation.logAllTypes', 'All types')}</option>
                  {LOG_TYPES.map(v => <option key={v} value={v}>{v.toUpperCase()}</option>)}
                </select>
                <select value={logStatus} onChange={e => setLogStatus(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs text-gray-300 focus:outline-none">
                  <option value="">{t('escalation.logAllStatuses', 'All statuses')}</option>
                  {LOG_STATUSES.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
                <button onClick={() => refreshLog()} className="p-1.5 text-gray-500 hover:text-gray-300">
                  <RefreshCw size={13} />
                </button>
              </div>
            </div>
            {log.length === 0 ? (
              <p className="text-sm text-gray-600 text-center py-8">{t('escalation.logEmpty', 'No notifications yet')}</p>
            ) : (
              <>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] text-gray-600 uppercase tracking-wider border-b border-white/[0.06]">
                      <th className="px-4 py-2">{t('escalation.logDate', 'Date')}</th>
                      <th className="px-3 py-2">{t('escalation.logType', 'Type')}</th>
                      <th className="px-3 py-2">{t('escalation.logRecipient', 'Recipient')}</th>
                      <th className="px-3 py-2">{t('escalation.logMessage', 'Message')}</th>
                      <th className="px-3 py-2 text-center">{t('escalation.logStatus', 'Status')}</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {log.map(n => (
                      <tr key={n.id} className="border-b border-white/[0.04] last:border-0">
                        <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">
                          {n.created_at ? new Date(n.created_at).toLocaleString() : '—'}
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-400 uppercase">{n.type}</td>
                        <td className="px-3 py-2">
                          <span className="text-gray-300 text-xs">{n.recipient_name || '—'}</span>
                          <span className="text-gray-600 text-[11px] font-mono ml-1.5">{n.recipient_contact}</span>
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-400 max-w-[320px] truncate" title={n.message}>{n.message}</td>
                        <td className="px-3 py-2 text-center">
                          <span className={`px-2 py-0.5 rounded border text-[10px] font-medium ${STATUS_STYLE[n.status] ?? STATUS_STYLE.simulated}`}>
                            {n.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-center">
                          {n.type === 'sms' && n.recipient_contact && (
                            <button
                              onClick={() => handleResend(n)}
                              disabled={resendingId === n.id}
                              title={t('escalation.logResend', 'Resend this SMS')}
                              className={`p-1 rounded ${n.status === 'failed' ? 'text-red-300 hover:bg-red-500/10' : 'text-gray-600 hover:text-gray-300'} disabled:opacity-40`}
                            >
                              <Send size={12} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {log.length < logTotal && (
                  <div className="text-center py-3 border-t border-white/[0.04]">
                    <button
                      onClick={() => setLogLimit(l => l + 50)}
                      className="text-xs text-blue-400 hover:text-blue-300"
                    >
                      {t('escalation.logShowMore', 'Show more')} ({log.length}/{logTotal})
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ContactList({ contacts, emptyText, machines, onPatch, onRemove }: {
  contacts: EscalationContact[];
  emptyText: string;
  machines: Machine[];
  onPatch: (c: EscalationContact, changes: ContactChanges) => void;
  onRemove: (c: EscalationContact) => void;
}) {
  if (contacts.length === 0) {
    return <p className="text-xs text-gray-600 italic mb-3">{emptyText}</p>;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-3">
      {contacts.map(c => (
        <ContactRow key={c.id} c={c} machines={machines} onPatch={onPatch} onRemove={onRemove} />
      ))}
    </div>
  );
}

function AddContactSelect({ users, exclude, onAdd, accent }: {
  users: User[];
  exclude: string[];
  onAdd: (userId: string) => void;
  accent: 'teal' | 'blue';
}) {
  const { t } = useTranslation();
  const available = users.filter(u => !exclude.includes(u.id));
  return (
    <div className="flex items-center gap-1.5 max-w-sm">
      <Plus size={13} className="text-gray-600" />
      <select
        value=""
        onChange={e => onAdd(e.target.value)}
        className={`flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 focus:outline-none ${
          accent === 'teal' ? 'focus:border-teal-500' : 'focus:border-blue-500'
        }`}
      >
        <option value="">{t('escalation.addContact', 'Add user…')}</option>
        {available.map(u => (
          <option key={u.id} value={u.id}>
            {u.name}{u.phone ? '' : ` (${t('escalation.noPhone', 'no phone!')})`}
          </option>
        ))}
      </select>
    </div>
  );
}

function ContactRow({ c, machines, onPatch, onRemove }: {
  c: EscalationContact;
  machines: Machine[];
  onPatch: (c: EscalationContact, changes: ContactChanges) => void;
  onRemove: (c: EscalationContact) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const scoped = c.scope_machine_ids.length > 0 || !!c.scope_department;
  const scheduled = !!(c.notify_start && c.notify_end);
  const bypassOff = scheduled && !c.critical_bypass;
  const smsNoPhone = c.via_sms && !c.user_phone;
  return (
    <div className="bg-gray-800/50 rounded-lg self-start">
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-200 truncate">{c.user_name}</p>
          <p className="text-[11px] text-gray-600 font-mono truncate">
            {c.user_phone || t('escalation.noPhone', 'no phone!')}
          </p>
        </div>
        <button
          onClick={() => onPatch(c, { via_sms: !c.via_sms })}
          title="SMS"
          className={`p-1.5 rounded ${c.via_sms ? 'text-green-400 bg-green-500/10' : 'text-gray-600'}`}
        >
          <MessageSquare size={13} />
        </button>
        <button
          onClick={() => onPatch(c, { via_email: !c.via_email })}
          title="Email"
          className={`p-1.5 rounded ${c.via_email ? 'text-blue-400 bg-blue-500/10' : 'text-gray-600'}`}
        >
          <Mail size={13} />
        </button>
        <button
          onClick={() => setOpen(o => !o)}
          title={t('escalation.scopeSchedule', 'Scope & schedule')}
          className={`p-1.5 rounded ${scoped || scheduled || open ? 'text-purple-300 bg-purple-500/10' : 'text-gray-600 hover:text-gray-400'}`}
        >
          <SlidersHorizontal size={13} />
        </button>
        <button onClick={() => onRemove(c)} className="p-1.5 text-gray-600 hover:text-red-400">
          <Trash2 size={13} />
        </button>
      </div>
      {(scoped || scheduled || bypassOff || smsNoPhone) && (
        <div className="flex items-center gap-1.5 flex-wrap px-3 pb-2 -mt-0.5">
          {scoped && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-purple-500/30 text-purple-300/90 text-[10px]">
              <Factory size={9} />
              {c.scope_machine_ids.length > 0
                ? t('escalation.scopeNMachines', '{{count}} machine(s)', { count: c.scope_machine_ids.length })
                : c.scope_department}
            </span>
          )}
          {scheduled && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-cyan-500/30 text-cyan-300/90 text-[10px] font-mono">
              <Clock size={9} />
              {c.notify_start}–{c.notify_end}
            </span>
          )}
          {bypassOff && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-300 text-[10px]">
              <AlertTriangle size={9} />
              {t('escalation.bypassOff', 'critical silenced outside hours')}
            </span>
          )}
          {smsNoPhone && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-red-500/40 text-red-300 text-[10px]">
              <AlertTriangle size={9} />
              {t('escalation.noPhone', 'no phone!')}
            </span>
          )}
        </div>
      )}
      {open && <ScopeSchedulePanel c={c} machines={machines} onPatch={onPatch} />}
    </div>
  );
}

function ScopeSchedulePanel({ c, machines, onPatch }: {
  c: EscalationContact;
  machines: Machine[];
  onPatch: (c: EscalationContact, changes: ContactChanges) => void;
}) {
  const { t } = useTranslation();
  const departments = Array.from(
    new Set(machines.map(m => m.department).filter((d): d is string => !!d)),
  ).sort();
  const [mode, setMode] = useState<'all' | 'department' | 'machines'>(
    c.scope_machine_ids.length > 0 ? 'machines' : c.scope_department ? 'department' : 'all',
  );
  const [machineQuery, setMachineQuery] = useState('');

  const changeMode = (m: 'all' | 'department' | 'machines') => {
    setMode(m);
    if (m === 'all') onPatch(c, { scope_department: null, scope_machine_ids: [] });
    if (m === 'department') onPatch(c, { scope_machine_ids: [], scope_department: c.scope_department ?? departments[0] ?? null });
    if (m === 'machines') onPatch(c, { scope_department: null });
  };

  const toggleMachine = (id: string) => {
    const next = c.scope_machine_ids.includes(id)
      ? c.scope_machine_ids.filter(x => x !== id)
      : [...c.scope_machine_ids, id];
    onPatch(c, { scope_machine_ids: next });
  };

  const visibleMachines = machineQuery.trim()
    ? machines.filter(m => m.name.toLowerCase().includes(machineQuery.trim().toLowerCase()))
    : machines;

  const inputCls = 'bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-purple-500';

  return (
    <div className="border-t border-white/[0.06] px-3 py-2.5 space-y-3">
      <div>
        <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">
          {t('escalation.scopeLabel', 'Receives alerts from')}
        </label>
        <select
          value={mode}
          onChange={e => changeMode(e.target.value as 'all' | 'department' | 'machines')}
          className={`w-full ${inputCls}`}
        >
          <option value="all">{t('escalation.scopeAll', 'All machines')}</option>
          {departments.length > 0 && (
            <option value="department">{t('escalation.scopeDepartment', 'A department')}</option>
          )}
          <option value="machines">{t('escalation.scopeMachines', 'Specific machines')}</option>
        </select>
        {mode === 'department' && (
          <select
            value={c.scope_department ?? ''}
            onChange={e => onPatch(c, { scope_department: e.target.value || null })}
            className={`w-full mt-1.5 ${inputCls}`}
          >
            {departments.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        {mode === 'machines' && (
          <>
            {machines.length > 8 && (
              <div className="relative mt-1.5">
                <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-600" />
                <input
                  value={machineQuery}
                  onChange={e => setMachineQuery(e.target.value)}
                  placeholder={t('common.search', 'Search…')}
                  className={`w-full pl-6 ${inputCls}`}
                />
              </div>
            )}
            <div className="mt-1.5 max-h-36 overflow-y-auto space-y-1 pr-1">
              {visibleMachines.map(m => (
                <label key={m.id} className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer hover:text-gray-100">
                  <input
                    type="checkbox"
                    checked={c.scope_machine_ids.includes(m.id)}
                    onChange={() => toggleMachine(m.id)}
                    className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-800 text-purple-500 focus:ring-purple-500"
                  />
                  <span className="truncate">{m.name}</span>
                </label>
              ))}
              {c.scope_machine_ids.length === 0 && (
                <p className="text-[10px] text-amber-400/80">
                  {t('escalation.scopeMachinesEmpty', 'No machine selected = all machines.')}
                </p>
              )}
            </div>
          </>
        )}
      </div>
      <div>
        <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">
          {t('escalation.quietLabel', 'Notify only between (empty = 24/7)')}
        </label>
        <div className="flex items-center gap-2">
          <input
            type="time"
            value={c.notify_start ?? ''}
            onChange={e => onPatch(c, { notify_start: e.target.value || null })}
            className={inputCls}
          />
          <span className="text-gray-600 text-xs">→</span>
          <input
            type="time"
            value={c.notify_end ?? ''}
            onChange={e => onPatch(c, { notify_end: e.target.value || null })}
            className={inputCls}
          />
          {(c.notify_start || c.notify_end) && (
            <button
              onClick={() => onPatch(c, { notify_start: null, notify_end: null })}
              className="text-[11px] text-gray-500 hover:text-gray-300"
            >
              {t('escalation.quietClear', 'Clear')}
            </button>
          )}
        </div>
        <label className="mt-2 flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={c.critical_bypass}
            onChange={e => onPatch(c, { critical_bypass: e.target.checked })}
            className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-800 text-red-500 focus:ring-red-500"
          />
          {t('escalation.criticalBypass', 'Critical alerts always get through')}
        </label>
      </div>
    </div>
  );
}

function SlaInput({ label, color, value, onChange, min = 1 }: {
  label: string;
  color: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
}) {
  return (
    <div>
      <label className={`block text-xs font-medium mb-1.5 ${color}`}>{label}</label>
      <input
        type="number"
        min={min}
        value={value}
        onChange={e => onChange(parseInt(e.target.value, 10) || min)}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:border-blue-500"
      />
    </div>
  );
}

function Toggle({ icon, label, checked, onChange }: {
  icon: React.ReactNode;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-3 bg-gray-800/40 rounded-lg px-3 py-2.5 cursor-pointer hover:bg-gray-800/70">
      {icon}
      <span className="flex-1 text-sm text-gray-300">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500"
      />
    </label>
  );
}
