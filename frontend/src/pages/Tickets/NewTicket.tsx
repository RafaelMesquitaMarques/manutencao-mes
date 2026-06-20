import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, Send, Power, CalendarClock } from 'lucide-react';
import { createTicket } from '../../api/maintenance';
import { fetchEquipment } from '../../api/workOrders';
import type { Equipment, AlertPriority, AlertProblemType } from '../../types';
import Spinner from '../../components/ui/Spinner';
import SearchableSelect from '../../components/ui/SearchableSelect';

const PROBLEM_TYPES: { value: AlertProblemType; label: string }[] = [
  { value: 'mechanical',         label: 'Mechanical' },
  { value: 'electrical',         label: 'Electrical' },
  { value: 'pneumatic',          label: 'Pneumatic' },
  { value: 'sensor',             label: 'Sensor / Instrumentation' },
  { value: 'safety_risk',        label: 'Safety Risk' },
  { value: 'quality_impact',     label: 'Quality Impact' },
  { value: 'machine_stop',       label: 'Machine Stop' },
  { value: 'preventive_request', label: 'Preventive Request' },
  { value: 'other',              label: 'Other' },
];

const PRIORITIES: { value: AlertPriority; label: string; cls: string }[] = [
  { value: 'critical', label: 'Critical',    cls: 'border-red-500/50 text-red-400' },
  { value: 'high',     label: 'High',        cls: 'border-orange-500/50 text-orange-400' },
  { value: 'medium',   label: 'Medium',      cls: 'border-amber-500/50 text-amber-400' },
  { value: 'low',      label: 'Low',         cls: 'border-green-500/50 text-green-400' },
];

interface DuplicateInfo {
  ticket_id: string;
  ticket_number: string;
  minutes_ago: number | null;
}

export default function NewTicket() {
  const navigate = useNavigate();
  const [machines, setMachines] = useState<Equipment[]>([]);
  const [form, setForm] = useState({
    machine_id: '',
    priority: 'high' as AlertPriority,
    problem_type: '' as AlertProblemType | '',
    description: '',
    estimated_downtime_minutes: '',
  });
  // True  → machine is down: machine page switches to "Waiting for mechanic".
  // False → planned maintenance: machine keeps running.
  const [machineStopped, setMachineStopped] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [dup, setDup] = useState<DuplicateInfo | null>(null);

  useEffect(() => {
    // Page through the 200-row cap so every machine is searchable, not just the first page.
    (async () => {
      try {
        const PAGE = 200;
        const all: Equipment[] = [];
        for (let skip = 0; ; skip += PAGE) {
          const batch = await fetchEquipment({ limit: String(PAGE), skip: String(skip) });
          all.push(...batch);
          if (batch.length < PAGE) break;
        }
        setMachines(all);
      } catch { /* ignore */ }
    })();
  }, []);

  const machineOptions = useMemo(
    () => machines.map((m) => ({
      value: m.id,
      label: m.name,
      hint: [m.code, m.location, m.department].filter(Boolean).join(' · '),
      search: [m.name, m.code, m.location, m.department, m.family, m.subtype].filter(Boolean).join(' '),
    })),
    [machines],
  );

  const submit = async (force = false) => {
    if (!form.machine_id) { setErr('Select a machine'); return; }
    setSaving(true); setErr('');
    try {
      const ticket = await createTicket({
        machine_id: form.machine_id,
        priority: form.priority,
        problem_type: form.problem_type || undefined,
        description: form.description || undefined,
        estimated_downtime_minutes: parseInt(form.estimated_downtime_minutes) || undefined,
        machine_stopped: machineStopped,
        force,
      });
      navigate(`/tickets/${ticket.id}`);
    } catch (e: unknown) {
      const resp = (e as { response?: { status?: number; data?: { detail?: unknown } } })?.response;
      const detail = resp?.data?.detail;
      if (
        resp?.status === 409 &&
        detail && typeof detail === 'object' &&
        (detail as { code?: string }).code === 'duplicate_open_ticket'
      ) {
        const d = detail as DuplicateInfo;
        setDup({ ticket_id: d.ticket_id, ticket_number: d.ticket_number, minutes_ago: d.minutes_ago });
        return;
      }
      setErr(typeof detail === 'string' ? detail : 'Error creating ticket');
    } finally { setSaving(false); }
  };

  return (
    <div className="p-4 sm:p-6 max-w-lg mx-auto space-y-5 animate-fade-in">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="text-gray-500 hover:text-gray-200 transition-colors">
          <ArrowLeft size={20} />
        </button>
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <AlertTriangle size={18} className="text-amber-400" />
            New Maintenance Request
          </h1>
          <p className="text-gray-600 text-xs mt-0.5">Report a machine issue to the maintenance team</p>
        </div>
      </div>

      <div className="glass-card p-5 space-y-4">
        {/* Machine */}
        <div>
          <label className="label">Machine *</label>
          <SearchableSelect
            value={form.machine_id}
            onChange={(v) => setForm((f) => ({ ...f, machine_id: v }))}
            options={machineOptions}
            placeholder="Select machine…"
          />
        </div>

        {/* Machine state — drives whether the machine page shows "Waiting for mechanic" */}
        <div>
          <label className="label">Machine state *</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setMachineStopped(true)}
              className={`p-3 rounded border text-left transition-colors ${
                machineStopped ? 'border-amber-500/60 bg-amber-500/10' : 'border-white/10 hover:border-white/20'
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-medium text-white">
                <Power size={15} className="text-amber-400" /> Machine stopped
              </div>
              <p className="text-gray-500 text-xs mt-1 leading-snug">
                Needs a mechanic now — the machine page shows “Waiting for mechanic”.
              </p>
            </button>
            <button
              type="button"
              onClick={() => setMachineStopped(false)}
              className={`p-3 rounded border text-left transition-colors ${
                !machineStopped ? 'border-blue-500/60 bg-blue-500/10' : 'border-white/10 hover:border-white/20'
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-medium text-white">
                <CalendarClock size={15} className="text-blue-400" /> Planned maintenance
              </div>
              <p className="text-gray-500 text-xs mt-1 leading-snug">
                Machine keeps running — no change to the machine page.
              </p>
            </button>
          </div>
        </div>

        {/* Problem type */}
        <div>
          <label className="label">Problem Type</label>
          <select
            value={form.problem_type}
            onChange={(e) => setForm((f) => ({ ...f, problem_type: e.target.value as AlertProblemType }))}
            className="input-field w-full"
          >
            <option value="">Select problem type…</option>
            {PROBLEM_TYPES.map((pt) => (
              <option key={pt.value} value={pt.value}>{pt.label}</option>
            ))}
          </select>
        </div>

        {/* Priority */}
        <div>
          <label className="label">Priority</label>
          <div className="grid grid-cols-4 gap-2">
            {PRIORITIES.map((p) => (
              <button
                key={p.value}
                onClick={() => setForm((f) => ({ ...f, priority: p.value }))}
                className={`py-2.5 rounded border text-sm font-medium transition-colors ${
                  form.priority === p.value
                    ? `${p.cls} bg-white/5`
                    : 'border-white/10 text-gray-500 hover:border-white/20'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Description */}
        <div>
          <label className="label">Description</label>
          <textarea
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="Describe the issue in detail…"
            className="input-field w-full h-28 resize-none"
          />
        </div>

        {/* Estimated downtime */}
        <div>
          <label className="label">Estimated Downtime (minutes)</label>
          <input
            type="number"
            min="0"
            value={form.estimated_downtime_minutes}
            onChange={(e) => setForm((f) => ({ ...f, estimated_downtime_minutes: e.target.value }))}
            placeholder="e.g. 30"
            className="input-field w-full"
          />
        </div>

        {err && <p className="text-red-400 text-sm">{err}</p>}

        <button
          onClick={() => submit()}
          disabled={saving || !form.machine_id}
          className="btn-primary w-full py-3.5 text-base font-semibold flex items-center justify-center gap-2"
        >
          {saving ? <Spinner size="sm" /> : <Send size={16} />}
          {saving ? 'Submitting…' : 'Submit Maintenance Request'}
        </button>
      </div>

      {/* Duplicate confirmation */}
      {dup && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setDup(null)}
        >
          <div className="glass-card max-w-sm w-full p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 text-amber-400">
              <AlertTriangle size={18} />
              <h3 className="font-semibold text-white">A ticket is already open</h3>
            </div>
            <p className="text-sm text-gray-300 leading-relaxed">
              Ticket <span className="font-mono text-white">{dup.ticket_number}</span> is already open for this machine
              {typeof dup.minutes_ago === 'number' ? ` (created ${dup.minutes_ago} min ago)` : ''}.
              {' '}Do you really want to create another one?
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setDup(null)}
                className="flex-1 py-2.5 rounded border border-white/15 text-gray-300 hover:bg-white/5 text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { setDup(null); submit(true); }}
                disabled={saving}
                className="btn-primary flex-1 py-2.5 text-sm font-medium"
              >
                Create anyway
              </button>
            </div>
            <button
              onClick={() => { const id = dup.ticket_id; setDup(null); navigate(`/tickets/${id}`); }}
              className="text-xs text-gray-500 hover:text-gray-300 w-full text-center transition-colors"
            >
              View existing ticket
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
