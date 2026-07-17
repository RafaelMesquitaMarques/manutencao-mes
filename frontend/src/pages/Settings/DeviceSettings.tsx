import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Cpu, Plus, Loader2, Trash2, X, Check, Pencil, KeyRound, Circle, ScanLine, Thermometer, BatteryMedium } from 'lucide-react';
import {
  fetchAdamDevices, createAdamDevice, updateAdamDevice, deleteAdamDevice,
  provisionMachineToken,
  type AdamDevice, type AdamDeviceInput, type AdamDeviceStatus,
} from '../../api/adamDevices';
import {
  fetchCortexStations, createCortexStation, updateCortexStation, deleteCortexStation,
  type CortexStation, type CortexStationInput,
} from '../../api/cortexStations';
import {
  fetchTemperatureSensors, createTemperatureSensor, updateTemperatureSensor, deleteTemperatureSensor,
  type TemperatureSensor, type TemperatureSensorInput,
} from '../../api/temperatureSensors';
import {
  fetchSushiDevices, createSushiDevice, updateSushiDevice, deleteSushiDevice,
  type SushiDevice, type SushiDeviceInput, type SushiHealth,
} from '../../api/sushi';
import { fetchMachinesAll } from '../../api/machines';
import { fetchDepartments, type Department } from '../../api/departments';
import { fetchEquipment } from '../../api/workOrders';
import type { Equipment, Machine } from '../../types';
import { usePermission } from '../../hooks/usePermission';
import SushiIcon from '../../components/ui/SushiIcon';
import { useAuthStore } from '../../store/authStore';
import { formatTemp } from '../../utils/temperature';
import Spinner from '../../components/ui/Spinner';

const BLANK: AdamDeviceInput = {
  name: '', model: '6051', ip_address: '', port: 502, machine_id: null,
  enabled: true, signal_source: 'di', channel: 0, active_level: 'low',
  counter_reg: 0, idle_timeout_s: 15, poll_interval_ms: 100,
};

const BLANK_STATION: CortexStationInput = {
  name: '', station_key: '', machine_id: null, enabled: true, poll_interval_s: 5,
};

const BLANK_SENSOR: TemperatureSensorInput = {
  name: '', department: null, enabled: true, source: 'simulated', sim_baseline_c: 21, sim_amplitude_c: 2,
};

const BLANK_SUSHI: SushiDeviceInput = {
  name: '', dev_eui: '', model: 'xs770a', equipment_id: null, enabled: true,
  update_period_min: 60, vel_warn_mms: 4.5, vel_crit_mms: 7.1,
  acc_warn_ms2: null, acc_crit_ms2: null, temp_warn_c: null, temp_crit_c: null,
  press_min_mpa: null, press_max_mpa: null,
};

const STATUS_STYLE: Record<AdamDeviceStatus, string> = {
  online: 'text-green-400', offline: 'text-red-400',
  error: 'text-amber-400', unknown: 'text-gray-500',
};

const SUSHI_HEALTH_STYLE: Record<SushiHealth, string> = {
  online: 'text-green-400', stale: 'text-amber-400',
  offline: 'text-red-400', unknown: 'text-gray-500',
};

const inputCls =
  'bg-[#0b1120] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500';

export default function DeviceSettings() {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || 'en').slice(0, 2);
  const canEdit = usePermission('settings_devices', 'update');
  const tempUnit = useAuthStore((s) => s.user?.temp_unit ?? 'C');

  const [devices, setDevices] = useState<AdamDevice[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<AdamDeviceInput>(BLANK);

  // Cortex end-of-line stations (pulled by the cortex_poller worker)
  const [stations, setStations] = useState<CortexStation[]>([]);
  const [showStForm, setShowStForm] = useState(false);
  const [stEditId, setStEditId] = useState<string | null>(null);
  const [stForm, setStForm] = useState<CortexStationInput>(BLANK_STATION);

  // Temperature sensors (placed on the factory map; readings by the temperature loop)
  const [sensors, setSensors] = useState<TemperatureSensor[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [showSensorForm, setShowSensorForm] = useState(false);
  const [sensorEditId, setSensorEditId] = useState<string | null>(null);
  const [sensorForm, setSensorForm] = useState<TemperatureSensorInput>(BLANK_SENSOR);

  // Yokogawa Sushi sensors (LoRaWAN → network server → /api/sushi/uplink)
  const [sushiDevices, setSushiDevices] = useState<SushiDevice[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [showSushiForm, setShowSushiForm] = useState(false);
  const [sushiEditId, setSushiEditId] = useState<string | null>(null);
  const [sushiForm, setSushiForm] = useState<SushiDeviceInput>(BLANK_SUSHI);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, m, st, se, dep, su, eq] = await Promise.all([
        fetchAdamDevices(), fetchMachinesAll(), fetchCortexStations(), fetchTemperatureSensors(),
        fetchDepartments(), fetchSushiDevices(), fetchEquipment({ limit: '500' }),
      ]);
      setDevices(d);
      setMachines(m);
      setStations(st);
      setSensors(se);
      setDepartments(dep);
      setSushiDevices(su);
      setEquipment(eq);
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

  const handleProvision = async (machineId: string | null) => {
    if (!machineId) return;
    const machine = machines.find((m) => m.id === machineId);
    const ref = machine?.page_slug || machineId;
    setErr('');
    try { await provisionMachineToken(ref); await load(); flashSaved(); }
    catch { setErr(t('common.error')); }
  };

  // ── Cortex stations ──
  const openStAdd = () => { setStEditId(null); setStForm(BLANK_STATION); setShowStForm(true); setErr(''); };
  const openStEdit = (s: CortexStation) => {
    setStEditId(s.id);
    setStForm({
      name: s.name, station_key: s.station_key, machine_id: s.machine_id,
      enabled: s.enabled, poll_interval_s: s.poll_interval_s,
    });
    setShowStForm(true); setErr('');
  };
  const closeStForm = () => { setShowStForm(false); setStEditId(null); };
  const setSt = <K extends keyof CortexStationInput>(k: K, v: CortexStationInput[K]) =>
    setStForm((f) => ({ ...f, [k]: v }));

  const handleStSave = async () => {
    if (!stForm.name.trim() || !stForm.station_key.trim()) return;
    setBusy(true); setErr('');
    try {
      if (stEditId) await updateCortexStation(stEditId, stForm);
      else await createCortexStation(stForm);
      closeStForm();
      await load();
      flashSaved();
    } catch (e: unknown) {
      const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setErr(d === 'machine_not_found' ? t('devices.machineNotFound') : t('common.error'));
    } finally { setBusy(false); }
  };

  const handleStDelete = async (id: string) => {
    if (!window.confirm(t('devices.deleteStationConfirm'))) return;
    setErr('');
    try { await deleteCortexStation(id); await load(); }
    catch { setErr(t('common.error')); }
  };

  // ── Temperature sensors ──
  const openSensorAdd = () => { setSensorEditId(null); setSensorForm(BLANK_SENSOR); setShowSensorForm(true); setErr(''); };
  const openSensorEdit = (s: TemperatureSensor) => {
    setSensorEditId(s.id);
    setSensorForm({
      name: s.name, department: s.department, enabled: s.enabled, source: s.source,
      sim_baseline_c: s.sim_baseline_c, sim_amplitude_c: s.sim_amplitude_c,
    });
    setShowSensorForm(true); setErr('');
  };
  const closeSensorForm = () => { setShowSensorForm(false); setSensorEditId(null); };
  const setSensor = <K extends keyof TemperatureSensorInput>(k: K, v: TemperatureSensorInput[K]) =>
    setSensorForm((f) => ({ ...f, [k]: v }));

  const handleSensorSave = async () => {
    if (!sensorForm.name.trim()) return;
    setBusy(true); setErr('');
    try {
      if (sensorEditId) await updateTemperatureSensor(sensorEditId, sensorForm);
      else await createTemperatureSensor(sensorForm);
      closeSensorForm();
      await load();
      flashSaved();
    } catch { setErr(t('common.error')); }
    finally { setBusy(false); }
  };

  const handleSensorDelete = async (id: string) => {
    if (!window.confirm(t('devices.deleteSensorConfirm'))) return;
    setErr('');
    try { await deleteTemperatureSensor(id); await load(); }
    catch { setErr(t('common.error')); }
  };

  // ── Sushi sensors ──
  const openSushiAdd = () => { setSushiEditId(null); setSushiForm(BLANK_SUSHI); setShowSushiForm(true); setErr(''); };
  const openSushiEdit = (d: SushiDevice) => {
    setSushiEditId(d.id);
    setSushiForm({
      name: d.name, dev_eui: d.dev_eui, model: d.model, equipment_id: d.equipment_id,
      enabled: d.enabled, update_period_min: d.update_period_min,
      vel_warn_mms: d.vel_warn_mms, vel_crit_mms: d.vel_crit_mms,
      acc_warn_ms2: d.acc_warn_ms2, acc_crit_ms2: d.acc_crit_ms2,
      temp_warn_c: d.temp_warn_c, temp_crit_c: d.temp_crit_c,
      press_min_mpa: d.press_min_mpa, press_max_mpa: d.press_max_mpa,
    });
    setShowSushiForm(true); setErr('');
  };
  const closeSushiForm = () => { setShowSushiForm(false); setSushiEditId(null); };
  const setSushi = <K extends keyof SushiDeviceInput>(k: K, v: SushiDeviceInput[K]) =>
    setSushiForm((f) => ({ ...f, [k]: v }));
  const sushiNum = (v: string): number | null => (v === '' ? null : Number(v));

  const handleSushiSave = async () => {
    if (!sushiForm.name.trim() || !sushiForm.dev_eui.trim()) return;
    setBusy(true); setErr('');
    try {
      if (sushiEditId) await updateSushiDevice(sushiEditId, sushiForm);
      else await createSushiDevice(sushiForm);
      closeSushiForm();
      await load();
      flashSaved();
    } catch (e) {
      const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setErr(d === 'dev_eui_already_registered' ? t('devices.sushiDupEui')
        : d === 'invalid_dev_eui' || (Array.isArray(d) && String(d).includes('invalid_dev_eui')) ? t('devices.sushiBadEui')
        : t('common.error'));
    } finally { setBusy(false); }
  };

  const handleSushiDelete = async (id: string) => {
    if (!window.confirm(t('devices.deleteSushiConfirm'))) return;
    setErr('');
    try { await deleteSushiDevice(id); await load(); }
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
                <option value="state">{t('devices.sourceState')}</option>
              </select>
              <span className="block text-[11px] text-gray-600">
                {form.signal_source === 'di' ? t('devices.diHint')
                  : form.signal_source === 'state' ? t('devices.stateHint')
                  : t('devices.counterHint')}
              </span>
            </label>
            {form.signal_source !== 'counter' ? (
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
                      ADAM-{d.model} · {d.signal_source === 'counter' ? `#${d.counter_reg}` : `DI${d.channel}`}
                      {d.signal_source === 'state' && <> · {t('devices.sourceStateShort')}</>}
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
                          <button onClick={() => handleProvision(d.machine_id)}
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

      {/* ── Cortex end-of-line stations (pulled by the cortex_poller worker) ── */}
      <div className="flex items-start justify-between gap-4 pt-4">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <ScanLine size={18} className="text-purple-400" /> {t('devices.cortexTitle')}
          </h2>
          <p className="text-gray-500 text-sm mt-0.5">{t('devices.cortexSubtitle')}</p>
        </div>
        {canEdit && !showStForm && (
          <button onClick={openStAdd} className="btn-secondary py-1.5 px-3 text-sm whitespace-nowrap">
            <Plus size={14} /> {t('devices.addStation')}
          </button>
        )}
      </div>

      {showStForm && (
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <ScanLine size={16} className="text-purple-400" />
            <h3 className="text-sm font-semibold text-gray-200">
              {stEditId ? t('devices.editStation') : t('devices.addStation')}
            </h3>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('devices.name')}</span>
              <input value={stForm.name} onChange={(e) => setSt('name', e.target.value)}
                placeholder="Cortex Ligne 1" className={`${inputCls} w-full`} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('devices.machine')}</span>
              <select value={stForm.machine_id ?? ''} onChange={(e) => setSt('machine_id', e.target.value || null)}
                className={`${inputCls} w-full`}>
                <option value="">{t('devices.unlinked')}</option>
                {machines.map((m) => <option key={m.id} value={m.id}>{machineLabel(m)}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('devices.stationKey')}</span>
              <input value={stForm.station_key} onChange={(e) => setSt('station_key', e.target.value)}
                placeholder="ligne-1" className={`${inputCls} w-full`} />
              <span className="block text-[11px] text-gray-600">{t('devices.stationKeyHint')}</span>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('devices.pollIntervalS')}</span>
              <input type="number" value={stForm.poll_interval_s}
                onChange={(e) => setSt('poll_interval_s', Number(e.target.value))}
                className={`${inputCls} w-full`} />
            </label>
          </div>

          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input type="checkbox" checked={stForm.enabled} onChange={(e) => setSt('enabled', e.target.checked)}
              className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-blue-500 cursor-pointer" />
            <span className="text-sm text-gray-200">{t('devices.enabled')}</span>
            <span className="text-xs text-gray-600">{t('devices.stationEnabledHint')}</span>
          </label>

          <div className="flex items-center gap-2 pt-1">
            <button onClick={handleStSave} disabled={busy || !stForm.name.trim() || !stForm.station_key.trim()}
              className="btn-primary py-1.5 px-4 text-sm disabled:opacity-40">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {t('common.save')}
            </button>
            <button onClick={closeStForm} className="btn-secondary py-1.5 px-4 text-sm">{t('common.cancel')}</button>
          </div>
        </div>
      )}

      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-5">
        {stations.length === 0 ? (
          <p className="text-gray-600 text-sm">{t('devices.noStations')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b border-white/[0.06]">
                <th className="py-2 pr-4 font-medium">{t('devices.name')}</th>
                <th className="py-2 pr-4 font-medium">{t('devices.machine')}</th>
                <th className="py-2 pr-4 font-medium">{t('devices.stationKey')}</th>
                <th className="py-2 pr-4 font-medium">{t('devices.status')}</th>
                <th className="py-2 pr-4 font-medium">{t('devices.lastSeen')}</th>
                <th className="py-2 pl-3 text-right font-medium w-24"></th>
              </tr>
            </thead>
            <tbody>
              {stations.map((s) => (
                <tr key={s.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                  <td className="py-2.5 pr-4">
                    <span className="text-gray-200">{s.name}</span>
                    {!s.enabled && <span className="ml-2 text-[10px] text-gray-600 uppercase">{t('devices.disabled')}</span>}
                  </td>
                  <td className="py-2.5 pr-4 text-gray-400">
                    {s.machine_name || <span className="text-gray-600">{t('devices.unlinked')}</span>}
                    {s.machine_id && !s.machine_has_token && (
                      <span className="block text-[11px] text-amber-500/90">{t('devices.noToken')}</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4 text-gray-400 font-mono text-xs">{s.station_key}</td>
                  <td className="py-2.5 pr-4">
                    <span className={`inline-flex items-center gap-1.5 ${STATUS_STYLE[s.status]}`}>
                      <Circle size={8} fill="currentColor" strokeWidth={0} />
                      {t(`devices.status_${s.status}`)}
                    </span>
                    {s.status === 'error' && s.last_error && (
                      <span className="block text-[11px] text-gray-600 truncate max-w-[220px]" title={s.last_error}>
                        {s.last_error}
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4 text-gray-500 text-xs">{fmtSeen(s.last_seen_at)}</td>
                  <td className="py-2.5 pl-3 text-right whitespace-nowrap">
                    {canEdit && (
                      <>
                        {s.machine_id && !s.machine_has_token && (
                          <button onClick={() => handleProvision(s.machine_id)}
                            className="text-gray-600 hover:text-amber-400 transition-colors mr-3"
                            title={t('devices.provisionToken')}>
                            <KeyRound size={14} />
                          </button>
                        )}
                        <button onClick={() => openStEdit(s)}
                          className="text-gray-600 hover:text-blue-400 transition-colors mr-3" title={t('common.edit')}>
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => handleStDelete(s.id)}
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

      <p className="text-xs text-gray-600">{t('devices.cortexNote')}</p>

      {/* ── Temperature sensors (placed on the factory map; readings by the temperature loop) ── */}
      <div className="flex items-start justify-between gap-4 pt-4">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Thermometer size={18} className="text-red-400" /> {t('devices.tempTitle')}
          </h2>
          <p className="text-gray-500 text-sm mt-0.5">{t('devices.tempSubtitle')}</p>
        </div>
        {canEdit && !showSensorForm && (
          <button onClick={openSensorAdd} className="btn-secondary py-1.5 px-3 text-sm whitespace-nowrap">
            <Plus size={14} /> {t('devices.addSensor')}
          </button>
        )}
      </div>

      {showSensorForm && (
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Thermometer size={16} className="text-red-400" />
            <h3 className="text-sm font-semibold text-gray-200">
              {sensorEditId ? t('devices.editSensor') : t('devices.addSensor')}
            </h3>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('devices.name')}</span>
              <input value={sensorForm.name} onChange={(e) => setSensor('name', e.target.value)}
                placeholder="Zone A" className={`${inputCls} w-full`} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('devices.department')}</span>
              <select value={sensorForm.department ?? ''} onChange={(e) => setSensor('department', e.target.value || null)}
                className={`${inputCls} w-full`}>
                <option value="">{t('devices.noDepartment')}</option>
                {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
                {sensorForm.department && !departments.some((d) => d.name === sensorForm.department) && (
                  <option value={sensorForm.department}>{sensorForm.department}</option>
                )}
              </select>
              <span className="block text-[11px] text-gray-600">{t('devices.sensorDepartmentHint')}</span>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('devices.sensorSource')}</span>
              <select value={sensorForm.source}
                onChange={(e) => setSensor('source', e.target.value as TemperatureSensorInput['source'])}
                className={`${inputCls} w-full`}>
                <option value="simulated">{t('devices.sourceSimulated')}</option>
                <option value="adam_analog" disabled>{t('devices.sourceAdamAnalog')}</option>
                <option value="http" disabled>{t('devices.sourceHttp')}</option>
              </select>
              <span className="block text-[11px] text-gray-600">{t('devices.sensorSourceHint')}</span>
            </label>
            {sensorForm.source === 'simulated' && (
              <div className="grid grid-cols-2 gap-4">
                <label className="space-y-1">
                  <span className="text-xs text-gray-400">{t('devices.simBaseline')}</span>
                  <input type="number" value={sensorForm.sim_baseline_c}
                    onChange={(e) => setSensor('sim_baseline_c', Number(e.target.value))}
                    className={`${inputCls} w-full`} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-gray-400">{t('devices.simAmplitude')}</span>
                  <input type="number" value={sensorForm.sim_amplitude_c}
                    onChange={(e) => setSensor('sim_amplitude_c', Number(e.target.value))}
                    className={`${inputCls} w-full`} />
                </label>
              </div>
            )}
          </div>

          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input type="checkbox" checked={sensorForm.enabled} onChange={(e) => setSensor('enabled', e.target.checked)}
              className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-blue-500 cursor-pointer" />
            <span className="text-sm text-gray-200">{t('devices.enabled')}</span>
            <span className="text-xs text-gray-600">{t('devices.sensorEnabledHint')}</span>
          </label>

          <div className="flex items-center gap-2 pt-1">
            <button onClick={handleSensorSave} disabled={busy || !sensorForm.name.trim()}
              className="btn-primary py-1.5 px-4 text-sm disabled:opacity-40">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {t('common.save')}
            </button>
            <button onClick={closeSensorForm} className="btn-secondary py-1.5 px-4 text-sm">{t('common.cancel')}</button>
          </div>
        </div>
      )}

      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-5">
        {sensors.length === 0 ? (
          <p className="text-gray-600 text-sm">{t('devices.noSensors')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b border-white/[0.06]">
                <th className="py-2 pr-4 font-medium">{t('devices.name')}</th>
                <th className="py-2 pr-4 font-medium">{t('devices.department')}</th>
                <th className="py-2 pr-4 font-medium">{t('devices.reading')}</th>
                <th className="py-2 pr-4 font-medium">{t('devices.status')}</th>
                <th className="py-2 pr-4 font-medium">{t('devices.lastSeen')}</th>
                <th className="py-2 pl-3 text-right font-medium w-24"></th>
              </tr>
            </thead>
            <tbody>
              {sensors.map((s) => (
                <tr key={s.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                  <td className="py-2.5 pr-4">
                    <span className="text-gray-200">{s.name}</span>
                    {!s.enabled && <span className="ml-2 text-[10px] text-gray-600 uppercase">{t('devices.disabled')}</span>}
                    <span className="block text-[11px] text-gray-600 font-mono">
                      {t(`devices.source_${s.source}`)}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 text-gray-400">
                    {s.department || <span className="text-gray-600">{t('devices.noDepartment')}</span>}
                  </td>
                  <td className="py-2.5 pr-4 text-gray-200 font-medium">{formatTemp(s.last_value_c, tempUnit)}</td>
                  <td className="py-2.5 pr-4">
                    <span className={`inline-flex items-center gap-1.5 ${STATUS_STYLE[s.status]}`}>
                      <Circle size={8} fill="currentColor" strokeWidth={0} />
                      {t(`devices.status_${s.status}`)}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 text-gray-500 text-xs">{fmtSeen(s.last_reading_at)}</td>
                  <td className="py-2.5 pl-3 text-right whitespace-nowrap">
                    {canEdit && (
                      <>
                        <button onClick={() => openSensorEdit(s)}
                          className="text-gray-600 hover:text-blue-400 transition-colors mr-3" title={t('common.edit')}>
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => handleSensorDelete(s.id)}
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

      <p className="text-xs text-gray-600">{t('devices.tempNote')}</p>

      {/* ── Yokogawa Sushi sensors (LoRaWAN vibration / pressure / temperature) ── */}
      <div className="flex items-start justify-between gap-4 pt-4">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <SushiIcon size={18} /> {t('devices.sushiTitle')}
          </h2>
          <p className="text-gray-500 text-sm mt-0.5">{t('devices.sushiSubtitle')}</p>
        </div>
        {canEdit && !showSushiForm && (
          <button onClick={openSushiAdd} className="btn-secondary py-1.5 px-3 text-sm whitespace-nowrap">
            <Plus size={14} /> {t('devices.addSushi')}
          </button>
        )}
      </div>

      {showSushiForm && (
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <SushiIcon size={16} />
            <h3 className="text-sm font-semibold text-gray-200">
              {sushiEditId ? t('devices.editSushi') : t('devices.addSushi')}
            </h3>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('devices.name')}</span>
              <input value={sushiForm.name} onChange={(e) => setSushi('name', e.target.value)}
                placeholder="XS770A Presse 9" className={`${inputCls} w-full`} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('devices.sushiDevEui')}</span>
              <input value={sushiForm.dev_eui} onChange={(e) => setSushi('dev_eui', e.target.value)}
                placeholder="0064B7xxxxxxxxxx" className={`${inputCls} w-full font-mono`} />
              <span className="block text-[11px] text-gray-600">{t('devices.sushiDevEuiHint')}</span>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('devices.model')}</span>
              <select value={sushiForm.model}
                onChange={(e) => setSushi('model', e.target.value as SushiDeviceInput['model'])}
                className={`${inputCls} w-full`}>
                <option value="xs770a">{t('devices.sushiModelXs770a')}</option>
                <option value="xs530">{t('devices.sushiModelXs530')}</option>
                <option value="xs550">{t('devices.sushiModelXs550')}</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('devices.sushiEquipment')}</span>
              <select value={sushiForm.equipment_id ?? ''} onChange={(e) => setSushi('equipment_id', e.target.value || null)}
                className={`${inputCls} w-full`}>
                <option value="">{t('devices.unlinked')}</option>
                {equipment.map((eq) => (
                  <option key={eq.id} value={eq.id}>{eq.name}{eq.code ? ` (${eq.code})` : ''}</option>
                ))}
              </select>
              <span className="block text-[11px] text-gray-600">{t('devices.sushiEquipmentHint')}</span>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('devices.sushiUpdatePeriod')}</span>
              <input type="number" min={1} value={sushiForm.update_period_min}
                onChange={(e) => setSushi('update_period_min', Number(e.target.value))}
                className={`${inputCls} w-full`} />
              <span className="block text-[11px] text-gray-600">{t('devices.sushiUpdatePeriodHint')}</span>
            </label>
          </div>

          {/* Alarm thresholds — backend evaluates on threshold crossings */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{t('devices.sushiThresholds')}</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {sushiForm.model === 'xs770a' && (
                <>
                  <label className="space-y-1">
                    <span className="text-xs text-gray-400">{t('devices.sushiVelWarn')}</span>
                    <input type="number" step="0.1" value={sushiForm.vel_warn_mms ?? ''}
                      onChange={(e) => setSushi('vel_warn_mms', sushiNum(e.target.value))}
                      className={`${inputCls} w-full`} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs text-gray-400">{t('devices.sushiVelCrit')}</span>
                    <input type="number" step="0.1" value={sushiForm.vel_crit_mms ?? ''}
                      onChange={(e) => setSushi('vel_crit_mms', sushiNum(e.target.value))}
                      className={`${inputCls} w-full`} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs text-gray-400">{t('devices.sushiAccWarn')}</span>
                    <input type="number" step="0.1" value={sushiForm.acc_warn_ms2 ?? ''}
                      onChange={(e) => setSushi('acc_warn_ms2', sushiNum(e.target.value))}
                      className={`${inputCls} w-full`} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs text-gray-400">{t('devices.sushiAccCrit')}</span>
                    <input type="number" step="0.1" value={sushiForm.acc_crit_ms2 ?? ''}
                      onChange={(e) => setSushi('acc_crit_ms2', sushiNum(e.target.value))}
                      className={`${inputCls} w-full`} />
                  </label>
                </>
              )}
              {sushiForm.model === 'xs530' && (
                <>
                  <label className="space-y-1">
                    <span className="text-xs text-gray-400">{t('devices.sushiPressMin')}</span>
                    <input type="number" step="0.01" value={sushiForm.press_min_mpa ?? ''}
                      onChange={(e) => setSushi('press_min_mpa', sushiNum(e.target.value))}
                      className={`${inputCls} w-full`} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs text-gray-400">{t('devices.sushiPressMax')}</span>
                    <input type="number" step="0.01" value={sushiForm.press_max_mpa ?? ''}
                      onChange={(e) => setSushi('press_max_mpa', sushiNum(e.target.value))}
                      className={`${inputCls} w-full`} />
                  </label>
                </>
              )}
              <label className="space-y-1">
                <span className="text-xs text-gray-400">{t('devices.sushiTempWarn')}</span>
                <input type="number" step="0.5" value={sushiForm.temp_warn_c ?? ''}
                  onChange={(e) => setSushi('temp_warn_c', sushiNum(e.target.value))}
                  className={`${inputCls} w-full`} />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-gray-400">{t('devices.sushiTempCrit')}</span>
                <input type="number" step="0.5" value={sushiForm.temp_crit_c ?? ''}
                  onChange={(e) => setSushi('temp_crit_c', sushiNum(e.target.value))}
                  className={`${inputCls} w-full`} />
              </label>
            </div>
            <p className="text-[11px] text-gray-600">{t('devices.sushiThresholdsHint')}</p>
          </div>

          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input type="checkbox" checked={sushiForm.enabled} onChange={(e) => setSushi('enabled', e.target.checked)}
              className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-blue-500 cursor-pointer" />
            <span className="text-sm text-gray-200">{t('devices.enabled')}</span>
            <span className="text-xs text-gray-600">{t('devices.sushiEnabledHint')}</span>
          </label>

          <div className="flex items-center gap-2 pt-1">
            <button onClick={handleSushiSave} disabled={busy || !sushiForm.name.trim() || !sushiForm.dev_eui.trim()}
              className="btn-primary py-1.5 px-4 text-sm disabled:opacity-40">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {t('common.save')}
            </button>
            <button onClick={closeSushiForm} className="btn-secondary py-1.5 px-4 text-sm">{t('common.cancel')}</button>
          </div>
        </div>
      )}

      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-5">
        {sushiDevices.length === 0 ? (
          <p className="text-gray-600 text-sm">{t('devices.noSushi')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b border-white/[0.06]">
                <th className="py-2 pr-4 font-medium">{t('devices.name')}</th>
                <th className="py-2 pr-4 font-medium">{t('devices.sushiEquipment')}</th>
                <th className="py-2 pr-4 font-medium">{t('devices.status')}</th>
                <th className="py-2 pr-4 font-medium">{t('devices.sushiBattery')}</th>
                <th className="py-2 pr-4 font-medium">{t('devices.sushiRadio')}</th>
                <th className="py-2 pr-4 font-medium">{t('devices.sushiLastUplink')}</th>
                <th className="py-2 pl-3 text-right font-medium w-24"></th>
              </tr>
            </thead>
            <tbody>
              {sushiDevices.map((d) => (
                <tr key={d.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                  <td className="py-2.5 pr-4">
                    <span className="text-gray-200">{d.name}</span>
                    {!d.enabled && <span className="ml-2 text-[10px] text-gray-600 uppercase">{t('devices.disabled')}</span>}
                    <span className="block text-[11px] text-gray-600 font-mono">
                      {d.model.toUpperCase()} · {d.dev_eui}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 text-gray-400">
                    {d.equipment_name || <span className="text-amber-400/80">{t('devices.unlinked')}</span>}
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className={`inline-flex items-center gap-1.5 ${SUSHI_HEALTH_STYLE[d.health]}`}>
                      <Circle size={8} fill="currentColor" strokeWidth={0} />
                      {t(`devices.sushiHealth_${d.health}`)}
                    </span>
                    {d.namur && d.namur !== 'good' && (
                      <span className="block text-[11px] text-amber-400/90">{t(`devices.namur_${d.namur}`)}</span>
                    )}
                    {d.last_error && (
                      <span className="block text-[11px] text-red-400/80">{t(`devices.sushiErr_${d.last_error}`, d.last_error)}</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4">
                    {d.battery_pct != null ? (
                      <span className={`inline-flex items-center gap-1 ${d.battery_pct < 10 ? 'text-red-400' : d.battery_pct < 20 ? 'text-amber-400' : 'text-gray-200'}`}>
                        <BatteryMedium size={13} /> {Math.round(d.battery_pct)}%
                      </span>
                    ) : <span className="text-gray-600">—</span>}
                  </td>
                  <td className="py-2.5 pr-4 text-xs text-gray-400 font-mono">
                    {d.rssi_dbm != null ? `${Math.round(d.rssi_dbm)} dBm` : '—'}
                    {d.snr_db != null ? ` / ${d.snr_db.toFixed(1)} dB` : ''}
                  </td>
                  <td className="py-2.5 pr-4 text-gray-500 text-xs">{fmtSeen(d.last_uplink_at)}</td>
                  <td className="py-2.5 pl-3 text-right whitespace-nowrap">
                    {canEdit && (
                      <>
                        <button onClick={() => openSushiEdit(d)}
                          className="text-gray-600 hover:text-blue-400 transition-colors mr-3" title={t('common.edit')}>
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => handleSushiDelete(d.id)}
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

      {/* Where to point the LoRaWAN network server */}
      <div className="text-xs text-gray-600 space-y-1">
        <p>{t('devices.sushiNote')}</p>
        <p className="font-mono text-gray-500">
          POST {window.location.origin}/api/sushi/uplink · X-Ingest-Token
          {sushiDevices.length > 0 && (
            sushiDevices[0].ingest_configured
              ? <span className="ml-2 text-green-500/80">{t('devices.sushiTokenSet')}</span>
              : <span className="ml-2 text-amber-400/90">{t('devices.sushiTokenMissing')}</span>
          )}
        </p>
      </div>
    </div>
  );
}
