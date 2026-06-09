import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, Send } from 'lucide-react';
import { createTicket } from '../../api/maintenance';
import { fetchEquipment } from '../../api/workOrders';
import type { Equipment, AlertPriority, AlertProblemType } from '../../types';
import Spinner from '../../components/ui/Spinner';

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
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    fetchEquipment({ limit: '200' }).then(setMachines).catch(() => {});
  }, []);

  const submit = async () => {
    if (!form.machine_id) { setErr('Select a machine'); return; }
    setSaving(true); setErr('');
    try {
      const ticket = await createTicket({
        machine_id: form.machine_id,
        priority: form.priority,
        problem_type: form.problem_type || undefined,
        description: form.description || undefined,
        estimated_downtime_minutes: parseInt(form.estimated_downtime_minutes) || undefined,
      });
      navigate(`/tickets/${ticket.id}`);
    } catch (e: unknown) {
      setErr((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Error creating ticket');
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
          <select
            value={form.machine_id}
            onChange={(e) => setForm((f) => ({ ...f, machine_id: e.target.value }))}
            className="input-field w-full"
          >
            <option value="">Select machine…</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>{m.name}{m.location ? ` (${m.location})` : ''}</option>
            ))}
          </select>
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
          onClick={submit}
          disabled={saving || !form.machine_id}
          className="btn-primary w-full py-3.5 text-base font-semibold flex items-center justify-center gap-2"
        >
          {saving ? <Spinner size="sm" /> : <Send size={16} />}
          {saving ? 'Submitting…' : 'Submit Maintenance Request'}
        </button>
      </div>
    </div>
  );
}
