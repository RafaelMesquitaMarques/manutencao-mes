import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bell, MessageSquare, Mail, Clock, Trash2, Plus, Send, CheckCircle,
  AlertTriangle, RefreshCw,
} from 'lucide-react';
import {
  fetchEscalationSettings, updateEscalationSettings,
  addEscalationContact, updateEscalationContact, deleteEscalationContact,
  fetchNotificationLog, sendTestSms,
  type EscalationSettings as Settings, type EscalationContact, type NotificationLogEntry,
} from '../../api/escalation';
import { fetchUsers } from '../../api/users';
import type { User } from '../../types';

const STATUS_STYLE: Record<string, string> = {
  sent:      'bg-green-900/40 text-green-300 border-green-700',
  simulated: 'bg-gray-800 text-gray-400 border-gray-600',
  failed:    'bg-red-900/40 text-red-300 border-red-700',
};

export default function EscalationSettingsPage() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [contacts, setContacts] = useState<EscalationContact[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [log, setLog] = useState<NotificationLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [testResult, setTestResult] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cfg, allUsers, entries] = await Promise.all([
        fetchEscalationSettings(),
        fetchUsers().catch(() => [] as User[]),
        fetchNotificationLog(50).catch(() => [] as NotificationLogEntry[]),
      ]);
      setSettings(cfg.settings);
      setContacts(cfg.contacts);
      setUsers(allUsers.filter(u => u.active));
      setLog(entries);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const patch = (changes: Partial<Settings>) =>
    setSettings(s => (s ? { ...s, ...changes } : s));

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const updated = await updateEscalationSettings(settings);
      setSettings(updated);
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

  const toggleContact = async (c: EscalationContact, field: 'via_sms' | 'via_email') => {
    const updated = await updateEscalationContact(c.id, { [field]: !c[field] });
    setContacts(prev => prev.map(x => (x.id === c.id ? updated : x)));
  };

  const removeContact = async (c: EscalationContact) => {
    await deleteEscalationContact(c.id);
    setContacts(prev => prev.filter(x => x.id !== c.id));
  };

  const handleTestSms = async () => {
    setTestResult('…');
    try {
      const r = await sendTestSms(testPhone || undefined);
      setTestResult(`${r.status} → ${r.phone}`);
      setLog(await fetchNotificationLog(50));
    } catch {
      setTestResult(t('escalation.testFailed', 'failed — check the phone number'));
    }
  };

  if (loading || !settings) {
    return <div className="p-6 text-gray-500 text-sm">{t('common.loading', 'Loading…')}</div>;
  }

  const maxLevel = Math.min(Math.max(settings.max_escalation_level || 3, 1), 5);
  const levels = Array.from({ length: maxLevel }, (_, i) => i + 1);

  return (
    <div className="p-6 space-y-6 max-w-5xl">
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
            {savedFlash ? <CheckCircle size={15} /> : null}
            {savedFlash ? t('common.saved', 'Saved') : saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
          </button>
        </div>
      </div>

      {/* SLA thresholds */}
      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-300 mb-1 flex items-center gap-2">
          <Clock size={15} className="text-blue-400" />
          {t('escalation.slaTitle', 'SLA thresholds (minutes before escalation)')}
        </h3>
        <p className="text-xs text-gray-600 mb-4">
          {t('escalation.slaHint', 'An open alert escalates one level each time this delay passes, up to the max level.')}
        </p>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <SlaInput label={t('escalation.critical', 'Critical')} color="text-red-400"
            value={settings.sla_critical_minutes} onChange={v => patch({ sla_critical_minutes: v })} />
          <SlaInput label={t('escalation.high', 'High')} color="text-orange-400"
            value={settings.sla_high_minutes} onChange={v => patch({ sla_high_minutes: v })} />
          <SlaInput label={t('escalation.medium', 'Medium')} color="text-amber-400"
            value={settings.sla_medium_minutes} onChange={v => patch({ sla_medium_minutes: v })} />
          <SlaInput label={t('escalation.low', 'Low')} color="text-green-400"
            value={settings.sla_low_minutes} onChange={v => patch({ sla_low_minutes: v })} />
          <SlaInput label={t('escalation.maxLevel', 'Max level')} color="text-purple-400"
            value={settings.max_escalation_level} onChange={v => patch({ max_escalation_level: Math.min(Math.max(v, 1), 5) })} />
        </div>
      </div>

      {/* Channels & triggers */}
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
        </div>
      </div>

      {/* Ticket open/close notification group (level 0) */}
      <div className="bg-[#0d1421] border border-teal-500/20 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-1 flex items-center gap-2">
          <Bell size={14} className="text-teal-400" />
          {t('escalation.ticketGroupTitle', 'Ticket notifications group (open & close)')}
        </h3>
        <p className="text-[11px] text-gray-600 mb-3">
          {t('escalation.ticketGroupHint', 'These contacts receive an SMS/email every time a ticket is opened or completed — regardless of priority.')}
        </p>
        <div className="space-y-2 mb-3">
          {contacts.filter(c => c.level === 0 && c.is_active).length === 0 && (
            <p className="text-xs text-gray-600 italic">
              {t('escalation.ticketGroupEmpty', 'No contacts — these notifications are not sent to anyone yet.')}
            </p>
          )}
          {contacts.filter(c => c.level === 0 && c.is_active).map(c => (
            <div key={c.id} className="flex items-center gap-2 bg-gray-800/50 rounded-lg px-3 py-2 max-w-md">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-200 truncate">{c.user_name}</p>
                <p className="text-[11px] text-gray-600 font-mono truncate">
                  {c.user_phone || t('escalation.noPhone', 'no phone!')}
                </p>
              </div>
              <button
                onClick={() => toggleContact(c, 'via_sms')}
                title="SMS"
                className={`p-1.5 rounded ${c.via_sms ? 'text-green-400 bg-green-500/10' : 'text-gray-600'}`}
              >
                <MessageSquare size={13} />
              </button>
              <button
                onClick={() => toggleContact(c, 'via_email')}
                title="Email"
                className={`p-1.5 rounded ${c.via_email ? 'text-blue-400 bg-blue-500/10' : 'text-gray-600'}`}
              >
                <Mail size={13} />
              </button>
              <button onClick={() => removeContact(c)} className="p-1.5 text-gray-600 hover:text-red-400">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1.5 max-w-md">
          <Plus size={13} className="text-gray-600" />
          <select
            value=""
            onChange={e => addContact(0, e.target.value)}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-teal-500"
          >
            <option value="">{t('escalation.addContact', 'Add user…')}</option>
            {users.filter(u => !contacts.some(c => c.level === 0 && c.is_active && c.user_id === u.id)).map(u => (
              <option key={u.id} value={u.id}>
                {u.name}{u.phone ? '' : ` (${t('escalation.noPhone', 'no phone!')})`}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Contacts per level */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {levels.map(level => {
          const levelContacts = contacts.filter(c => c.level === level && c.is_active);
          const available = users.filter(u => !levelContacts.some(c => c.user_id === u.id));
          return (
            <div key={level} className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-1">
                {t('escalation.level', 'Level')} {level}
              </h3>
              <p className="text-[11px] text-gray-600 mb-3">
                {level === 1 && t('escalation.level1Hint', 'First escalation + new critical alerts')}
                {level === 2 && t('escalation.level2Hint', 'Second escalation')}
                {level >= 3 && t('escalation.level3Hint', 'Final escalation')}
              </p>
              <div className="space-y-2 mb-3">
                {levelContacts.length === 0 && (
                  <p className="text-xs text-gray-600 italic">
                    {t('escalation.fallback', 'No contacts — falls back to users by role.')}
                  </p>
                )}
                {levelContacts.map(c => (
                  <div key={c.id} className="flex items-center gap-2 bg-gray-800/50 rounded-lg px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-200 truncate">{c.user_name}</p>
                      <p className="text-[11px] text-gray-600 font-mono truncate">
                        {c.user_phone || t('escalation.noPhone', 'no phone!')}
                      </p>
                    </div>
                    <button
                      onClick={() => toggleContact(c, 'via_sms')}
                      title="SMS"
                      className={`p-1.5 rounded ${c.via_sms ? 'text-green-400 bg-green-500/10' : 'text-gray-600'}`}
                    >
                      <MessageSquare size={13} />
                    </button>
                    <button
                      onClick={() => toggleContact(c, 'via_email')}
                      title="Email"
                      className={`p-1.5 rounded ${c.via_email ? 'text-blue-400 bg-blue-500/10' : 'text-gray-600'}`}
                    >
                      <Mail size={13} />
                    </button>
                    <button onClick={() => removeContact(c)} className="p-1.5 text-gray-600 hover:text-red-400">
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <Plus size={13} className="text-gray-600" />
                <select
                  value=""
                  onChange={e => addContact(level, e.target.value)}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
                >
                  <option value="">{t('escalation.addContact', 'Add user…')}</option>
                  {available.map(u => (
                    <option key={u.id} value={u.id}>
                      {u.name}{u.phone ? '' : ` (${t('escalation.noPhone', 'no phone!')})`}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}
      </div>

      {/* Test SMS */}
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

      {/* Notification log */}
      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-300">
            {t('escalation.logTitle', 'Recent notifications')}
          </h3>
          <button onClick={() => fetchNotificationLog(50).then(setLog)} className="ml-auto p-1.5 text-gray-500 hover:text-gray-300">
            <RefreshCw size={13} />
          </button>
        </div>
        {log.length === 0 ? (
          <p className="text-sm text-gray-600 text-center py-8">{t('escalation.logEmpty', 'No notifications yet')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-gray-600 uppercase tracking-wider border-b border-white/[0.06]">
                <th className="px-4 py-2">{t('escalation.logDate', 'Date')}</th>
                <th className="px-3 py-2">{t('escalation.logType', 'Type')}</th>
                <th className="px-3 py-2">{t('escalation.logRecipient', 'Recipient')}</th>
                <th className="px-3 py-2">{t('escalation.logMessage', 'Message')}</th>
                <th className="px-3 py-2 text-center">{t('escalation.logStatus', 'Status')}</th>
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SlaInput({ label, color, value, onChange }: {
  label: string;
  color: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className={`block text-xs font-medium mb-1.5 ${color}`}>{label}</label>
      <input
        type="number"
        min={1}
        value={value}
        onChange={e => onChange(parseInt(e.target.value, 10) || 1)}
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
