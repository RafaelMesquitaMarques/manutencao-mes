import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Cpu, Plus, Loader2, Trash2, X, Check, Pencil, KeyRound, Circle } from 'lucide-react';
import {
  fetchAdamDevices, createAdamDevice, updateAdamDevice, deleteAdamDevice,
  provisionMachineToken,
  type AdamDevice, type AdamDeviceInput, type AdamDeviceStatus,
} from '../../api/adamDevices';
import { fetchMachinesAll } from '../../api/machines';
import type { Machine } from '../../types';
import { usePermission } from '../../hooks/usePermission';
import Spinner from '../../components/ui/Spinner';

const BLANK: AdamDeviceInput = {
  name: '', model: '6051', ip_address: '', port: 502, machine_id: null,
  enabled: true, signal_source: 'di', channel: 0, active_level: 'low',
  counter_reg: 0, idle_timeout_s: 15, poll_interval_ms: 100,
};

const STATUS_STYLE: Record<AdamDeviceStatus, string> = {
  online: 'text-green-400', offline: 'text-red-400',
  error: 'text-amber-400', unknown: 'text-gray-500',
};

const inputCls =
  'bg-[#0b1120] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500';

export default function DeviceSettings() {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || 'en').slice(0, 2);
  const canEdit = usePermission('settings_devices', 'update');

  const [devices, setDevices] = useState<AdamDevice[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<AdamDeviceInput>(BLANK);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, m] = await Promise.all([fetchAdamDevices(), fetchMachinesAll()]);
      setDevices(d);
      setMachines(m);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const flashSaved = () => { setSaved(true); setTimeout(() => setSaved(false), 2500); };

  const openAdd = () => { setEditId(null); setForm(BLANK); setShowForm(true); setErr(''); };
  const openEdit = (d: AdamDevice) => {
    setEditId(d.id);
    setForm({
      name: d.name, model: d.model, ip_address: d.ip_address, port: d.port,
      machine_id: d.machine_id, enabled: d.enabled, signal_source: d.signal_source,
      channel: d.channel, active_level: d.active_level, counter_reg: d.counter_reg,
      idle_timeout_s: d.idle_timeout_s, poll_interval_ms: d.poll_interval_ms,
    });
    setShowForm(true); setErr('');
  };
  const closeForm = () => { setShowForm(false); setEditId(null); };

  const set = <K extends keyof AdamDeviceInput>(k: K, v: AdamDeviceInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!form.name.trim() || !form.ip_address.trim()) return;
    setBusy(true); setErr('');
    try {
      if (editId) await updateAdamDevice(editId, form);
      else await createAdamDevice(form);
      closeForm();
      await load();
      flashSaved();
    } catch (e: unknown) {
      const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setErr(d === 'machine_not_found' ? t('devices.machineNotFound') : t('common.error'));
    } finally { setBusy(false); }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(t('devices.deleteConfirm'))) return;
    setErr('');
    try { await deleteAdamDevice(id); await load(); }
    catch { setErr(t('common.error')); }
  };

  const handleProvision = async (d: AdamDevice) => {
    if (!d.machine_id) return;
    const machine = machines.find((m) => m.id === d.machine_id);
    const ref = machine?.page_slug || d.machine_id;
    setErr('');
    try { await provisionMachineToken(ref); await load(); flashSaved(); }
    catch { setErr(t('common.error')); }
  };

  const fmtSeen = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(lang) : t('devices.never');
  const machineLabel = (m: Machine) =>
    `${m.display_name || m.name}${m.code ? ` (${m.code})` : ''}`;

  if (loading) return <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>;

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('devices.title')}</h1>
          <p className="text-gray-500 text-sm mt-0.5">{t('devices.subtitle')}</p>
        </div>
        {canEdit && !showForm && (
          <button onClick={openAdd} className="btn-secondary py-1.5 px-3 text-sm whitespace-nowrap">
            <Plus size={14} /> {t('devices.addDevice')}
          </button>
        )}
      </div>

      {!canEdit && (
        <div className="p-3 bg-blue-500/10 border border-blue-500/25 rounded-lg">
          <p className="text-blue-300 text-sm">{t('devices.viewOnly')}</p>
        </div>
      )}
      {err && (
        <div className="flex items-center gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
          <X size={14} className="text-red-400" /><p className="text-red-400 text-sm">{err}</p>
        </div>
      )}
      {saved && (
        <div className="flex items-center gap-2.5 p-3 bg-green-500/10 border border-green-500/25 rounded-lg">
          <Check size={14} className="text-green-400" /><p className="text-green-400 text-sm">{t('common.saved')}</p>
        </div>
      )}

      {/* Add / edit form */}
      {showForm && (
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Cpu size={16} className="text-blue-400" />
            <h3 className="text-sm font-semibold text-gray-200">
              {editId ? t('devices.editDevice') : t('devices.addDevice')}
            </h3>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('devices.name')}</span>
              <input value={form.name} onChange={(e) => set('name', e.target.value)}
                placeholder="ADAM-6051 TF-54" className={`${inputCls} w-full`} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('devices.machine')}</span>
              <select value={form.machine_id ?? ''} onChange={(e) => set('machine_id', e.target.value || null)}
                className={`${inputCls} w-full`}>
                <option value="">{t('devices.unlinked')}</option>
                {machines.map((m) => <option key={m.id} value={m.id}>{machineLabel(m)}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('devices.ipAddress')}</span>
              <input value={form.ip_address} onChange={(e) => set('ip_address', e.target.value)}
                placeholder="192.168.63.10" className={`${inputCls} w-full`} />
            </label>
            <div className="grid grid-cols-2 gap-4">
              <label className="space-y-1">
                <span className="text-xs text-gray-400">{t('devices.port')}</span>
                <input type="number" value={form.port} onChange={(e) => set('port', Number(e.target.value))}
                  className={`${inputCls} w-full`} />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-gray-400">{t('devices.model')}</span>
                <select value={form.model} onChange={(e) => set('model', e.target.value as AdamDeviceInput['model'])}
                  className={`${inputCls} w-full`}>
                  <option value="6051">ADAM-6051</option>
                  <option value="6050">ADAM-6050</option>
                </select>
              </label>
            </div>
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('devices.signalSource')}</span>
              <select value={form.signal_source}
                onChange={(e) => set('signal_source', e.target.value as AdamDeviceInput['signal_source'])}
                className={`${inputCls} w-full`}>
                <option value="di">{t('devices.sourceDi')}</option>
                <option value="counter">{t('devices.sourceCounter')}</option>
              </select>
              <span className="block text-[11px] text-gray-600">
                {form.signal_source === 'di' ? t('devices.diHint') : t('devices.counterHint')}
              </span>
            </label>
            {form.signal_source === 'di' ? (
              <div className="grid grid-cols-2 gap-4">
                <label className="space-y-1">
                  <span className="text-xs text-gray-400">{t('devices.channel')}</span>
                  <input type="number" value={form.channel} onChange={(e) => set('channel', Number(e.target.value))}
                    className={`${inputCls} w-full`} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-gray-400">{t('devices.activeLevel')}</span>
                  <select value={form.active_level}
                    onChange={(e) => set('active_level', e.target.value as AdamDeviceInput['active_level'])}
                    className={`${inputCls} w-full`}>
                    <option value="low">{t('devices.activeLow')}</option>
                    <option value="high">{t('devices.activeHigh')}</option>
                  </select>
                </label>
              </div>
            ) : (
              <label className="space-y-1">
                <span className="text-xs text-gray-400">{t('devices.counterReg')}</span>
                <input type="number" value={form.counter_reg} onChange={(e) => set('counter_reg', Number(e.target.value))}
                  className={`${inputCls} w-full`} />
              </label>
            )}
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('devices.idleTimeout')}</span>
              <input type="number" value={form.idle_timeout_s} onChange={(e) => set('idle_timeout_s', Number(e.target.value))}
                className={`${inputCls} w-full`} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('devices.pollInterval')}</span>
              <input type="number" value={form.poll_interval_ms} onChange={(e) => set('poll_interval_ms', Number(e.target.value))}
                className={`${inputCls} w-full`} />
            </label>
          </div>

          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)}
              className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-blue-500 cursor-pointer" />
            <span className="text-sm text-gray-200">{t('devices.enabled')}</span>
            <span className="text-xs text-gray-600">{t('devices.enabledHint')}</span>
          </label>

          <div className="flex items-center gap-2 pt-1">
            <button onClick={handleSave} disabled={busy || !form.name.trim() || !form.ip_address.trim()}
              className="btn-primary py-1.5 px-4 text-sm disabled:opacity-40">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {t('common.save')}
            </button>
            <button onClick={closeForm} className="btn-secondary py-1.5 px-4 text-sm">{t('common.cancel')}</button>
          </div>
        </div>
      )}

      {/* Device list */}
      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-5">
        {devices.length === 0 ? (
          <p className="text-gray-600 text-sm">{t('devices.noDevices')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b border-white/[0.06]">
                <th className="py-2 pr-4 font-medium">{t('devices.name')}</th>
                <th className="py-2 pr-4 font-medium">{t('devices.machine')}</th>
                <th className="py-2 pr-4 font-medium">{t('devices.address')}</th>
                <th className="py-2 pr-4 font-medium">{t('devices.status')}</th>
                <th className="py-2 pr-4 font-medium">{t('devices.lastSeen')}</th>
                <th className="py-2 pl-3 text-right font-medium w-24"></th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                  <td className="py-2.5 pr-4">
                    <span className="text-gray-200">{d.name}</span>
                    {!d.enabled && <span className="ml-2 text-[10px] text-gray-600 uppercase">{t('devices.disabled')}</span>}
                    <span className="block text-[11px] text-gray-600 font-mono">
                      ADAM-{d.model} · {d.signal_source === 'di' ? `DI${d.channel}` : `#${d.counter_reg}`}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 text-gray-400">
                    {d.machine_name || <span className="text-gray-600">{t('devices.unlinked')}</span>}
                    {d.machine_id && !d.machine_has_token && (
                      <span className="block text-[11px] text-amber-500/90">{t('devices.noToken')}</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4 text-gray-400 font-mono text-xs">{d.ip_address}:{d.port}</td>
                  <td className="py-2.5 pr-4">
                    <span className={`inline-flex items-center gap-1.5 ${STATUS_STYLE[d.status]}`}>
                      <Circle size={8} fill="currentColor" strokeWidth={0} />
                      {t(`devices.status_${d.status}`)}
                    </span>
                    {d.status === 'error' && d.last_error && (
                      <span className="block text-[11px] text-gray-600 truncate max-w-[220px]" title={d.last_error}>
                        {d.last_error}
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4 text-gray-500 text-xs">{fmtSeen(d.last_seen_at)}</td>
                  <td className="py-2.5 pl-3 text-right whitespace-nowrap">
                    {canEdit && (
                      <>
                        {d.machine_id && !d.machine_has_token && (
                          <button onClick={() => handleProvision(d)}
                            className="text-gray-600 hover:text-amber-400 transition-colors mr-3"
                            title={t('devices.provisionToken')}>
                            <KeyRound size={14} />
                          </button>
                        )}
                        <button onClick={() => openEdit(d)}
                          className="text-gray-600 hover:text-blue-400 transition-colors mr-3" title={t('common.edit')}>
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => handleDelete(d.id)}
                          className="text-gray-600 hover:text-red-400 transition-colors" title={t('common.delete')}>
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-gray-600">{t('devices.networkNote')}</p>
    </div>
  );
}
