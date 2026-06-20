import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Briefcase, Play, CheckCircle2, Clock, AlertTriangle,
  ChevronRight, RefreshCw, PauseCircle, Hand, Inbox,
} from 'lucide-react';
import { fetchMyWorkOrders, startWorkOrder, holdWorkOrder, resumeWorkOrder, completeWorkOrderFull } from '../../api/workOrders';
import { fetchAvailableTickets, claimTicket } from '../../api/maintenance';
import { fetchEscalationSettings } from '../../api/escalation';
import type { WorkOrder, Priority, WorkOrderStatus, MaintenanceTicket } from '../../types';
import Spinner from '../../components/ui/Spinner';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';

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

function elapsedStr(startedAt?: string): string {
  if (!startedAt) return '';
  const mins = Math.floor((Date.now() - new Date(startedAt).getTime()) / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

interface CompleteForm {
  root_cause: string;
  solution_applied: string;
}

const EMPTY_FORM: CompleteForm = { root_cause: '', solution_applied: '' };

export default function MyWorkPage() {
  const [wos, setWOs]           = useState<WorkOrder[]>([]);
  const [available, setAvailable] = useState<MaintenanceTicket[]>([]);
  const [selfAssignOn, setSelfAssignOn] = useState(true);
  const [loading, setLoading]   = useState(true);
  const [actionId, setActionId]     = useState<string | null>(null);
  const [completeId, setCompleteId] = useState<string | null>(null);
  const [claimErr, setClaimErr] = useState('');
  const [form, setForm]         = useState<CompleteForm>(EMPTY_FORM);
  const [formErr, setFormErr]   = useState('');
  const [tick, setTick]         = useState(0);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [items, avail, cfg] = await Promise.allSettled([
        fetchMyWorkOrders(),
        fetchAvailableTickets(),
        fetchEscalationSettings(),
      ]);
      if (items.status === 'fulfilled') {
        setWOs(items.value.filter((w) => w.status !== 'completed' && w.status !== 'cancelled'));
      } else if (!silent) {
        setWOs([]);
      }
      // Preventive maintenance is always assigned — never claimable here.
      if (avail.status === 'fulfilled') setAvailable(avail.value.filter((t) => t.problem_type !== 'preventive_request'));
      if (cfg.status === 'fulfilled') setSelfAssignOn(cfg.value.settings.technician_self_assign);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const handleClaim = async (ticketId: string) => {
    setActionId(ticketId);
    setClaimErr('');
    try {
      await claimTicket(ticketId);
      await load(true);
    } catch (err: unknown) {
      const resp = (err as { response?: { status?: number; data?: { detail?: string } } })?.response;
      if (resp?.status === 409) {
        setClaimErr('Ce ticket vient d\'être pris par un autre technicien.');
      } else if (resp?.data?.detail === 'Your account has no technician profile') {
        setClaimErr('Votre compte n\'a pas de profil technicien — seuls les techniciens peuvent prendre un ticket.');
      } else {
        setClaimErr(resp?.data?.detail ?? 'Échec — réessayez.');
      }
      await load(true);
    } finally {
      setActionId(null);
    }
  };

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const { lastUpdatedAt, isRefreshing, hasError, manualRefresh } = useAutoRefresh(
    () => load(true),
  );

  const handleStart = async (id: string) => {
    setActionId(id);
    try {
      const updated = await startWorkOrder(id);
      setWOs((prev) => prev.map((w) => (w.id === id ? updated : w)));
    } finally {
      setActionId(null);
    }
  };

  const handleHold = async (id: string) => {
    setActionId(id);
    try {
      const updated = await holdWorkOrder(id);
      setWOs((prev) => prev.map((w) => (w.id === id ? updated : w)));
    } finally {
      setActionId(null);
    }
  };

  const handleResume = async (id: string) => {
    setActionId(id);
    try {
      const updated = await resumeWorkOrder(id);
      setWOs((prev) => prev.map((w) => (w.id === id ? updated : w)));
    } finally {
      setActionId(null);
    }
  };

  const handleComplete = async () => {
    if (!completeId) return;
    if (!form.root_cause.trim() || !form.solution_applied.trim()) {
      setFormErr('Diagnosis and corrective action are required.');
      return;
    }
    setActionId(completeId);
    setFormErr('');
    try {
      await completeWorkOrderFull(completeId, {
        root_cause: form.root_cause,
        solution_applied: form.solution_applied,
      });
      setWOs((prev) => prev.filter((w) => w.id !== completeId));
      setCompleteId(null);
    } catch {
      setFormErr('Failed to complete. Please try again.');
    } finally {
      setActionId(null);
    }
  };

  const inProgress = wos.filter((w) => w.status === 'in_progress');
  const openWOs    = wos.filter((w) => w.status === 'open');
  const onHold     = wos.filter((w) => w.status === 'on_hold');

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-6 animate-fade-in">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Briefcase size={22} className="text-blue-400" />
          My Work
        </h1>
        <div className="flex items-center gap-2">
          {hasError && <span className="text-xs text-amber-500">⚠ Retry</span>}
          {lastUpdatedAt && !hasError && (
            <span className="text-xs text-gray-600 font-mono hidden sm:inline">
              {lastUpdatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          <button onClick={manualRefresh} disabled={loading || isRefreshing} className="btn-secondary py-1.5 px-3">
            <RefreshCw size={14} className={(loading || isRefreshing) ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40"><Spinner size="lg" /></div>
      ) : (
        <>
          {/* Unassigned tickets — claimable (shifts without a supervisor).
              Hidden when the supervisor turned self-assignment off. */}
          {selfAssignOn && available.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-amber-500 px-1 flex items-center gap-1.5">
                <Inbox size={13} />
                Tickets disponibles — premier arrivé, premier servi
              </h2>
              {claimErr && <p className="text-xs text-amber-400 px-1">{claimErr}</p>}
              {available.map((t) => (
                <div key={t.id} className="glass-card p-4 space-y-3 border-l-2 border-l-amber-500/60">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-mono text-purple-400">{t.ticket_number}</span>
                        {t.opened_at && (
                          <span className="text-[10px] text-gray-500 flex items-center gap-1">
                            <Clock size={10} />
                            {elapsedStr(t.opened_at)}
                          </span>
                        )}
                      </div>
                      <p className="text-white font-medium mt-1 text-sm leading-snug">
                        {t.machine_name ?? 'Machine'}
                      </p>
                      {t.description && (
                        <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{t.description}</p>
                      )}
                    </div>
                    <span className={`text-xs font-mono border px-1.5 py-0.5 rounded flex-shrink-0 ${PRIORITY_BADGE[t.priority as Priority] ?? PRIORITY_BADGE.medium}`}>
                      {t.priority}
                    </span>
                  </div>
                  <button
                    onClick={() => handleClaim(t.id)}
                    disabled={actionId === t.id}
                    className="btn-primary w-full py-3 text-sm font-semibold flex items-center justify-center gap-2"
                  >
                    <Hand size={16} />
                    {actionId === t.id ? 'Attribution…' : 'Prendre ce ticket'}
                  </button>
                </div>
              ))}
            </section>
          )}

          {wos.length === 0 ? (
            <div className="glass-card flex flex-col items-center justify-center h-48 gap-3">
              <CheckCircle2 size={36} className="text-green-700" />
              <p className="text-gray-400 font-medium">All caught up!</p>
              <p className="text-gray-600 text-sm">No active work orders assigned to you</p>
            </div>
          ) : (
            <>
          <WOGroup
            title="In Progress"
            wos={inProgress}
            onStart={handleStart}
            onHold={handleHold}
            onResume={handleResume}
            onComplete={(id) => { setCompleteId(id); setForm(EMPTY_FORM); setFormErr(''); }}
            actionId={actionId}
            tick={tick}
          />
          <WOGroup
            title="Open — Ready to Start"
            wos={openWOs}
            onStart={handleStart}
            onHold={handleHold}
            onResume={handleResume}
            onComplete={(id) => { setCompleteId(id); setForm(EMPTY_FORM); setFormErr(''); }}
            actionId={actionId}
            tick={tick}
          />
          <WOGroup
            title="On Hold"
            wos={onHold}
            onStart={handleStart}
            onHold={handleHold}
            onResume={handleResume}
            onComplete={(id) => { setCompleteId(id); setForm(EMPTY_FORM); setFormErr(''); }}
            actionId={actionId}
            tick={tick}
          />
            </>
          )}
        </>
      )}

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
                {actionId === completeId ? 'Saving…' : 'Mark Complete'}
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
  onHold: (id: string) => void;
  onResume: (id: string) => void;
  onComplete: (id: string) => void;
  actionId: string | null;
  tick: number;
}

function WOGroup({ title, wos, onStart, onHold, onResume, onComplete, actionId, tick }: WOGroupProps) {
  if (wos.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-600 px-1">{title}</h2>
      {wos.map((wo) => (
        <WOCard key={wo.id} wo={wo} onStart={onStart} onHold={onHold} onResume={onResume} onComplete={onComplete} actionId={actionId} tick={tick} />
      ))}
    </section>
  );
}

interface WOCardProps {
  wo: WorkOrder;
  onStart: (id: string) => void;
  onHold: (id: string) => void;
  onResume: (id: string) => void;
  onComplete: (id: string) => void;
  actionId: string | null;
  tick: number;
}

function WOCard({ wo, onStart, onHold, onResume, onComplete, actionId, tick: _tick }: WOCardProps) {
  const busy = actionId === wo.id;

  return (
    <div className="glass-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-blue-400">{wo.wo_number}</span>
            {wo.ticket_number && (
              <span className="text-xs font-mono bg-purple-500/10 text-purple-400 border border-purple-500/20 px-1.5 py-0.5 rounded">
                {wo.ticket_number}
              </span>
            )}
            {wo.status === 'in_progress' && wo.started_at && (
              <span className="text-[10px] text-amber-400 flex items-center gap-1">
                <Clock size={10} />
                {elapsedStr(wo.started_at)}
              </span>
            )}
          </div>
          <p className="text-white font-medium mt-1 text-sm leading-snug">{wo.title}</p>
          {(wo.equipment_name || wo.description) && (
            <p className="text-xs text-gray-500 mt-0.5 truncate">
              {wo.equipment_name}
              {wo.description && <span className="text-gray-700"> — {wo.description.slice(0, 60)}</span>}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <span className={`text-xs font-mono border px-1.5 py-0.5 rounded ${PRIORITY_BADGE[wo.priority]}`}>
            {wo.priority}
          </span>
          <span className={`text-xs font-mono border px-1.5 py-0.5 rounded ${STATUS_BADGE[wo.status as WorkOrderStatus]}`}>
            {wo.status.replace('_', ' ')}
          </span>
        </div>
      </div>

      {wo.due_date && (
        <div className="text-xs text-amber-600 flex items-center gap-1">
          <AlertTriangle size={10} />
          Due {wo.due_date}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        {wo.status === 'open' && (
          <button
            onClick={() => onStart(wo.id)}
            disabled={busy}
            className="btn-success flex-1 py-3 text-sm font-semibold flex items-center justify-center gap-2"
          >
            <Play size={16} />
            {busy ? 'Starting…' : 'Start Work'}
          </button>
        )}
        {wo.status === 'in_progress' && (
          <>
            <button
              onClick={() => onHold(wo.id)}
              disabled={busy}
              className="btn-secondary flex-1 py-3 text-sm flex items-center justify-center gap-2"
            >
              <PauseCircle size={16} />
              Hold
            </button>
            <button
              onClick={() => onComplete(wo.id)}
              disabled={busy}
              className="btn-primary flex-1 py-3 text-sm font-semibold flex items-center justify-center gap-2"
            >
              <CheckCircle2 size={16} />
              Complete
            </button>
          </>
        )}
        {wo.status === 'on_hold' && (
          <button
            onClick={() => onResume(wo.id)}
            disabled={busy}
            className="btn-success flex-1 py-3 text-sm font-semibold flex items-center justify-center gap-2"
          >
            <Play size={16} />
            {busy ? 'Resuming…' : 'Resume'}
          </button>
        )}
        <Link
          to={`/work-orders/${wo.id}`}
          className="btn-secondary py-3 px-3 flex items-center justify-center"
        >
          <ChevronRight size={16} />
        </Link>
      </div>
    </div>
  );
}
