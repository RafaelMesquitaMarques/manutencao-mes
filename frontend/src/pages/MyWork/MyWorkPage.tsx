import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Briefcase, Play, CheckCircle2, Clock, AlertTriangle,
  ChevronRight, RefreshCw, WifiOff,
} from 'lucide-react';
import { fetchWorkOrders, startWorkOrder, updateWorkOrder, fetchMyTechnicianProfile } from '../../api/workOrders';
import type { WorkOrder, Priority, WorkOrderStatus, TechnicianFull } from '../../types';
import Spinner from '../../components/ui/Spinner';

const PRIORITY_BADGE: Record<Priority, string> = {
  critical: 'bg-red-500/15 text-red-400 border-red-500/30',
  high:     'bg-orange-500/15 text-orange-400 border-orange-500/30',
  medium:   'bg-sky-500/15 text-sky-400 border-sky-500/30',
  low:      'bg-gray-500/15 text-gray-400 border-gray-500/30',
};

const STATUS_BADGE: Record<WorkOrderStatus, string> = {
  open:        'bg-blue-500/15 text-blue-400 border-blue-500/25',
  in_progress: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
  on_hold:     'bg-purple-500/15 text-purple-400 border-purple-500/25',
  completed:   'bg-green-500/15 text-green-400 border-green-500/25',
  cancelled:   'bg-gray-500/15 text-gray-400 border-gray-500/25',
};

const STATUS_LABEL: Record<WorkOrderStatus, string> = {
  open: 'Open', in_progress: 'In Progress', on_hold: 'On Hold',
  completed: 'Completed', cancelled: 'Cancelled',
};

interface CompleteForm {
  root_cause: string;
  solution_applied: string;
  repair_hours: string;
}

const EMPTY_FORM: CompleteForm = { root_cause: '', solution_applied: '', repair_hours: '' };

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export default function MyWorkPage() {
  const [tech, setTech]         = useState<TechnicianFull | null>(null);
  const [techErr, setTechErr]   = useState(false);
  const [wos, setWOs]           = useState<WorkOrder[]>([]);
  const [loading, setLoading]   = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [completeId, setCompleteId] = useState<string | null>(null);
  const [form, setForm]         = useState<CompleteForm>(EMPTY_FORM);
  const [formErr, setFormErr]   = useState('');

  const load = async (techProfile?: TechnicianFull | null) => {
    const profile = techProfile ?? tech;
    if (!profile) return;
    setLoading(true);
    try {
      const items = await fetchWorkOrders({ executor_id: profile.id, status_not: 'completed,cancelled' });
      setWOs(items);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMyTechnicianProfile()
      .then((profile) => {
        setTech(profile);
        load(profile);
      })
      .catch(() => {
        setTechErr(true);
        setLoading(false);
      });
  }, []);

  const handleStart = async (id: string) => {
    setActionId(id);
    try {
      const updated = await startWorkOrder(id);
      setWOs((prev) => prev.map((w) => (w.id === id ? updated : w)));
    } finally {
      setActionId(null);
    }
  };

  const handleOpenComplete = (id: string) => {
    setCompleteId(id);
    setForm(EMPTY_FORM);
    setFormErr('');
  };

  const handleComplete = async () => {
    if (!completeId) return;
    if (!form.root_cause.trim() || !form.solution_applied.trim()) {
      setFormErr('Diagnosis and corrective action are required.');
      return;
    }
    setActionId(completeId);
    try {
      const hours = parseFloat(form.repair_hours) || undefined;
      const updated = await updateWorkOrder(completeId, {
        status: 'completed',
        root_cause: form.root_cause,
        solution_applied: form.solution_applied,
        repair_hours: hours,
      } as any);
      setWOs((prev) => prev.filter((w) => w.id !== completeId));
      setCompleteId(null);
    } finally {
      setActionId(null);
    }
  };

  const today = todayStr();
  const todayWOs    = wos.filter((w) => w.scheduled_date === today || (!w.scheduled_date && w.status === 'in_progress'));
  const upcomingWOs = wos.filter((w) => w.scheduled_date && w.scheduled_date > today);
  const unscheduled = wos.filter((w) => !w.scheduled_date && w.status !== 'in_progress');

  if (loading && !tech) {
    return (
      <div className="flex items-center justify-center h-full min-h-[60vh]">
        <Spinner size="lg" />
      </div>
    );
  }

  if (techErr) {
    return (
      <div className="p-6 flex flex-col items-center justify-center gap-4 min-h-[60vh]">
        <WifiOff size={40} className="text-gray-700" />
        <p className="text-gray-400 text-center">Your account is not linked to a technician profile.<br />Ask an admin to create your technician record.</p>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Briefcase size={22} className="text-blue-400" />
            My Work
          </h1>
          {tech && (
            <p className="text-gray-500 text-sm mt-0.5">
              {tech.full_name}
              {tech.specialty && <span className="text-gray-700"> · {tech.specialty}</span>}
            </p>
          )}
        </div>
        <button onClick={() => load()} className="btn-secondary py-1.5 px-3 mt-1">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40"><Spinner size="lg" /></div>
      ) : wos.length === 0 ? (
        <div className="glass-card flex flex-col items-center justify-center h-48 gap-3">
          <CheckCircle2 size={36} className="text-green-700" />
          <p className="text-gray-400 font-medium">All caught up!</p>
          <p className="text-gray-600 text-sm">No work orders assigned to you</p>
        </div>
      ) : (
        <>
          <WOGroup title="Today / In Progress" wos={todayWOs} onStart={handleStart} onComplete={handleOpenComplete} actionId={actionId} />
          <WOGroup title="Upcoming" wos={upcomingWOs} onStart={handleStart} onComplete={handleOpenComplete} actionId={actionId} />
          <WOGroup title="Unscheduled" wos={unscheduled} onStart={handleStart} onComplete={handleOpenComplete} actionId={actionId} />
        </>
      )}

      {/* Complete modal */}
      {completeId && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-4">
          <div className="bg-[#0d1421] border border-white/10 rounded-2xl p-6 w-full max-w-lg space-y-5 shadow-2xl">
            <h2 className="text-white font-bold text-lg">Complete Work Order</h2>

            <div className="space-y-4">
              <div>
                <label className="label">Diagnosis / Root Cause *</label>
                <textarea
                  className="input-field w-full h-24 resize-none"
                  placeholder="What was found? Describe the root cause..."
                  value={form.root_cause}
                  onChange={(e) => setForm((f) => ({ ...f, root_cause: e.target.value }))}
                />
              </div>
              <div>
                <label className="label">Corrective Action *</label>
                <textarea
                  className="input-field w-full h-24 resize-none"
                  placeholder="What was done to fix it?"
                  value={form.solution_applied}
                  onChange={(e) => setForm((f) => ({ ...f, solution_applied: e.target.value }))}
                />
              </div>
              <div>
                <label className="label">Repair Hours</label>
                <input
                  type="number"
                  min="0"
                  step="0.25"
                  className="input-field w-full"
                  placeholder="e.g. 2.5"
                  value={form.repair_hours}
                  onChange={(e) => setForm((f) => ({ ...f, repair_hours: e.target.value }))}
                />
              </div>
            </div>

            {formErr && <p className="text-red-400 text-sm">{formErr}</p>}

            <div className="flex gap-3 pt-1">
              <button
                onClick={() => setCompleteId(null)}
                className="btn-secondary flex-1 py-3 text-base"
                disabled={actionId === completeId}
              >
                Cancel
              </button>
              <button
                onClick={handleComplete}
                disabled={actionId === completeId}
                className="btn-success flex-1 py-3 text-base font-semibold"
              >
                {actionId === completeId ? 'Saving...' : 'Complete WO'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface WOGroupProps {
  title: string;
  wos: WorkOrder[];
  onStart: (id: string) => void;
  onComplete: (id: string) => void;
  actionId: string | null;
}

function WOGroup({ title, wos, onStart, onComplete, actionId }: WOGroupProps) {
  if (wos.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-600 px-1">{title}</h2>
      {wos.map((wo) => (
        <WOCard key={wo.id} wo={wo} onStart={onStart} onComplete={onComplete} actionId={actionId} />
      ))}
    </section>
  );
}

interface WOCardProps {
  wo: WorkOrder;
  onStart: (id: string) => void;
  onComplete: (id: string) => void;
  actionId: string | null;
}

function WOCard({ wo, onStart, onComplete, actionId }: WOCardProps) {
  const busy = actionId === wo.id;
  const canStart    = wo.status === 'open';
  const canComplete = wo.status === 'in_progress';

  return (
    <div className="glass-card p-4 space-y-3">
      {/* Top row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-blue-400">{wo.wo_number}</span>
            {wo.ticket_number && (
              <span className="text-xs font-mono bg-purple-500/10 text-purple-400 border border-purple-500/20 px-1.5 py-0.5 rounded">
                TKT-{wo.ticket_number}
              </span>
            )}
          </div>
          <p className="text-white font-medium mt-1 text-sm leading-snug">{wo.title}</p>
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <span className={`text-xs font-mono border px-1.5 py-0.5 rounded ${PRIORITY_BADGE[wo.priority]}`}>
            {wo.priority}
          </span>
          <span className={`text-xs font-mono border px-1.5 py-0.5 rounded ${STATUS_BADGE[wo.status as WorkOrderStatus]}`}>
            {STATUS_LABEL[wo.status as WorkOrderStatus] ?? wo.status}
          </span>
        </div>
      </div>

      {/* Details row */}
      <div className="text-xs text-gray-500 flex flex-wrap gap-x-4 gap-y-1">
        {wo.equipment_name && <span>{wo.equipment_name}</span>}
        {wo.equipment_location && <span>{wo.equipment_location}</span>}
        {wo.scheduled_date && (
          <span className="flex items-center gap-1">
            <Clock size={10} />
            {wo.scheduled_date}
            {wo.scheduled_start_time && ` · ${wo.scheduled_start_time.slice(0, 5)}`}
          </span>
        )}
        {wo.due_date && !wo.scheduled_date && (
          <span className="flex items-center gap-1 text-amber-600">
            <AlertTriangle size={10} />
            Due {wo.due_date}
          </span>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 pt-1">
        {canStart && (
          <button
            onClick={() => onStart(wo.id)}
            disabled={busy}
            className="btn-success flex-1 py-3 text-sm font-semibold flex items-center justify-center gap-2"
          >
            <Play size={16} />
            {busy ? 'Starting...' : 'Start Work'}
          </button>
        )}
        {canComplete && (
          <button
            onClick={() => onComplete(wo.id)}
            disabled={busy}
            className="btn-primary flex-1 py-3 text-sm font-semibold flex items-center justify-center gap-2"
          >
            <CheckCircle2 size={16} />
            Complete
          </button>
        )}
        <Link
          to={`/work-orders/${wo.id}`}
          className="btn-secondary py-3 px-3 flex items-center justify-center"
          title="View WO detail"
        >
          <ChevronRight size={16} />
        </Link>
      </div>
    </div>
  );
}
