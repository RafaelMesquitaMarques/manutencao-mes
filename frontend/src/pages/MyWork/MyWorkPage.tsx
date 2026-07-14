import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  Briefcase, Play, CheckCircle2, Clock, AlertTriangle,
  ChevronRight, RefreshCw, PauseCircle, Hand, Inbox, Coffee,
} from 'lucide-react';
import { fetchMyWorkOrders, startWorkOrder, holdWorkOrder, resumeWorkOrder, completeWorkOrderFull } from '../../api/workOrders';
import { fetchAvailableTickets, claimTicket } from '../../api/maintenance';
import { fetchEscalationSettings } from '../../api/escalation';
import { fetchMyActiveBreak, startMyBreak, endMyBreak } from '../../api/technicians';
import type { WorkOrder, Priority, WorkOrderStatus, MaintenanceTicket, TechnicianBreak } from '../../types';
import Spinner from '../../components/ui/Spinner';
import InterventionCheckin from '../../components/InterventionCheckin';
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
  const { t } = useTranslation();
  const [wos, setWOs]           = useState<WorkOrder[]>([]);
  const [available, setAvailable] = useState<MaintenanceTicket[]>([]);
  const [selfAssignOn, setSelfAssignOn] = useState(true);
  const [loading, setLoading]   = useState(true);
  const [actionId, setActionId]     = useState<string | null>(null);
  const [completeId, setCompleteId] = useState<string | null>(null);
  const [claimErr, setClaimErr] = useState('');
  const [actionErr, setActionErr] = useState('');
  const [form, setForm]         = useState<CompleteForm>(EMPTY_FORM);
  const [formErr, setFormErr]   = useState('');
  const [tick, setTick]         = useState(0);
  // Announced (live) break presence. `canBreak` is only known once /me/break
  // resolves — non-technician accounts 404 and the control stays hidden.
  const [activeBreak, setActiveBreak] = useState<TechnicianBreak | null>(null);
  const [canBreak, setCanBreak]       = useState(false);
  const [breakBusy, setBreakBusy]     = useState(false);
  const [breakErr, setBreakErr]       = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [items, avail, cfg, brk] = await Promise.allSettled([
        fetchMyWorkOrders(),
        fetchAvailableTickets(),
        fetchEscalationSettings(),
        fetchMyActiveBreak(),
      ]);
      if (items.status === 'fulfilled') {
        setWOs(items.value.filter((w) => w.status !== 'completed' && w.status !== 'cancelled'));
      } else if (!silent) {
        setWOs([]);
      }
      // Preventive maintenance is always assigned — never claimable here.
      if (avail.status === 'fulfilled') setAvailable(avail.value.filter((t) => t.problem_type !== 'preventive_request'));
      if (cfg.status === 'fulfilled') setSelfAssignOn(cfg.value.settings.technician_self_assign);
      // Only technicians can take a break; a rejected call (404) hides the control.
      if (brk.status === 'fulfilled') { setCanBreak(true); setActiveBreak(brk.value); }
      else setCanBreak(false);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const handleGoOnBreak = async () => {
    setBreakBusy(true);
    setBreakErr('');
    try {
      setActiveBreak(await startMyBreak());
    } catch {
      setBreakErr(t('myWork.breakFailed'));
    } finally {
      setBreakBusy(false);
    }
  };

  const handleReturnFromBreak = async () => {
    setBreakBusy(true);
    setBreakErr('');
    try {
      await endMyBreak();
      setActiveBreak(null);
    } catch {
      setBreakErr(t('myWork.breakFailed'));
    } finally {
      setBreakBusy(false);
    }
  };

  const handleClaim = async (ticketId: string) => {
    setActionId(ticketId);
    setClaimErr('');
    try {
      await claimTicket(ticketId);
      await load(true);
    } catch (err: unknown) {
      const resp = (err as { response?: { status?: number; data?: { detail?: string } } })?.response;
      if (resp?.status === 409) {
        setClaimErr(t('myWork.claimTakenByOther'));
      } else if (resp?.data?.detail === 'Your account has no technician profile') {
        setClaimErr(t('myWork.claimNoTechProfile'));
      } else {
        setClaimErr(resp?.data?.detail ?? t('myWork.claimFailed'));
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

  // Start / hold / resume all share the same shape. On failure we must NOT
  // stay silent: a stale list (WO no longer in the expected state → 400) would
  // otherwise make the button appear to "do nothing". Surface the error and
  // resync so the card reflects reality.
  const runAction = async (id: string, fn: (id: string) => Promise<WorkOrder>) => {
    setActionId(id);
    setActionErr('');
    try {
      const updated = await fn(id);
      setWOs((prev) => prev.map((w) => (w.id === id ? updated : w)));
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      setActionErr(status === 400 ? t('myWork.actionOutOfSync') : t('myWork.actionFailed'));
      await load(true);
    } finally {
      setActionId(null);
    }
  };

  const handleStart  = (id: string) => runAction(id, startWorkOrder);
  const handleHold   = (id: string) => runAction(id, holdWorkOrder);
  const handleResume = (id: string) => runAction(id, resumeWorkOrder);

  const handleComplete = async () => {
    if (!completeId) return;
    if (!form.root_cause.trim() || !form.solution_applied.trim()) {
      setFormErr(t('myWork.diagnosisRequired'));
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
      setFormErr(t('myWork.completeFailed'));
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
          {t('myWork.title')}
        </h1>
        <div className="flex items-center gap-2">
          {hasError && <span className="text-xs text-amber-500">⚠ {t('common.retry')}</span>}
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

      {/* Break presence — technician tells the team they are really on break, so a
          postponed break no longer reads as "on break" on the roster. */}
      {canBreak && (
        <div>
          {activeBreak ? (
            <div className="glass-card border border-amber-500/30 bg-amber-500/5 p-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-full bg-amber-500/15 flex items-center justify-center flex-shrink-0">
                  <Coffee size={20} className="text-amber-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-amber-300 font-semibold text-sm">
                    {t('myWork.onBreakSince', {
                      time: new Date(activeBreak.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    })}
                  </p>
                  <p className="text-xs text-amber-500/70">
                    {elapsedStr(activeBreak.started_at)} · {t('myWork.onBreakHint')}
                  </p>
                </div>
              </div>
              <button
                onClick={handleReturnFromBreak}
                disabled={breakBusy}
                className="btn-primary py-2.5 px-4 text-sm font-semibold flex-shrink-0 flex items-center gap-2"
              >
                <Play size={16} />
                {breakBusy ? t('myWork.breakUpdating') : t('myWork.returnToWork')}
              </button>
            </div>
          ) : (
            <div className="flex justify-end">
              <button
                onClick={handleGoOnBreak}
                disabled={breakBusy}
                className="btn-secondary py-2 px-4 text-sm flex items-center gap-2"
              >
                <Coffee size={16} />
                {breakBusy ? t('myWork.breakUpdating') : t('myWork.goOnBreak')}
              </button>
            </div>
          )}
          {breakErr && <p className="text-xs text-amber-400 mt-1.5 text-right">{breakErr}</p>}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-40"><Spinner size="lg" /></div>
      ) : (
        <>
          {actionErr && (
            <p className="text-sm text-amber-400 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2">
              {actionErr}
            </p>
          )}
          {/* Unassigned tickets — claimable (shifts without a supervisor).
              Hidden when the supervisor turned self-assignment off. */}
          {selfAssignOn && available.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-amber-500 px-1 flex items-center gap-1.5">
                <Inbox size={13} />
                {t('myWork.availableTickets')}
              </h2>
              {claimErr && <p className="text-xs text-amber-400 px-1">{claimErr}</p>}
              {available.map((ticket) => (
                <div key={ticket.id} className="glass-card p-4 space-y-3 border-l-2 border-l-amber-500/60">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-mono text-purple-400">{ticket.ticket_number}</span>
                        {ticket.opened_at && (
                          <span className="text-[10px] text-gray-500 flex items-center gap-1">
                            <Clock size={10} />
                            {elapsedStr(ticket.opened_at)}
                          </span>
                        )}
                      </div>
                      <p className="text-white font-medium mt-1 text-sm leading-snug">
                        {ticket.machine_name ?? t('myWork.machineFallback')}
                      </p>
                      {ticket.description && (
                        <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{ticket.description}</p>
                      )}
                    </div>
                    <span className={`text-xs font-mono border px-1.5 py-0.5 rounded flex-shrink-0 ${PRIORITY_BADGE[ticket.priority as Priority] ?? PRIORITY_BADGE.medium}`}>
                      {t(`priority.${ticket.priority}`, ticket.priority)}
                    </span>
                  </div>
                  <button
                    onClick={() => handleClaim(ticket.id)}
                    disabled={actionId === ticket.id}
                    className="btn-primary w-full py-3 text-sm font-semibold flex items-center justify-center gap-2"
                  >
                    <Hand size={16} />
                    {actionId === ticket.id ? t('myWork.claiming') : t('myWork.claimTicket')}
                  </button>
                </div>
              ))}
            </section>
          )}

          {wos.length === 0 ? (
            <div className="glass-card flex flex-col items-center justify-center h-48 gap-3">
              <CheckCircle2 size={36} className="text-green-700" />
              <p className="text-gray-400 font-medium">{t('myWork.allCaughtUp')}</p>
              <p className="text-gray-600 text-sm">{t('myWork.noActiveWork')}</p>
            </div>
          ) : (
            <>
          <WOGroup
            title={t('status.in_progress')}
            wos={inProgress}
            onStart={handleStart}
            onHold={handleHold}
            onResume={handleResume}
            onComplete={(id) => { setCompleteId(id); setForm(EMPTY_FORM); setFormErr(''); }}
            actionId={actionId}
            tick={tick}
          />
          <WOGroup
            title={t('myWork.openReady')}
            wos={openWOs}
            onStart={handleStart}
            onHold={handleHold}
            onResume={handleResume}
            onComplete={(id) => { setCompleteId(id); setForm(EMPTY_FORM); setFormErr(''); }}
            actionId={actionId}
            tick={tick}
          />
          <WOGroup
            title={t('status.on_hold')}
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
            <h2 className="text-white font-bold text-lg">{t('myWork.completeWorkOrder')}</h2>
            <div className="space-y-4">
              <div>
                <label className="label">{t('myWork.diagnosisLabel')} *</label>
                <textarea
                  className="input-field w-full h-24 resize-none"
                  placeholder={t('myWork.diagnosisPlaceholder')}
                  value={form.root_cause}
                  onChange={(e) => setForm((f) => ({ ...f, root_cause: e.target.value }))}
                />
              </div>
              <div>
                <label className="label">{t('myWork.correctiveActionLabel')} *</label>
                <textarea
                  className="input-field w-full h-24 resize-none"
                  placeholder={t('myWork.correctiveActionPlaceholder')}
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
                {t('common.cancel')}
              </button>
              <button
                onClick={handleComplete}
                disabled={actionId === completeId}
                className="btn-success flex-1 py-3 text-base font-semibold"
              >
                {actionId === completeId ? t('common.saving') : t('myWork.markComplete')}
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
  const { t } = useTranslation();
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
            {t(`priority.${wo.priority}`, wo.priority)}
          </span>
          <span className={`text-xs font-mono border px-1.5 py-0.5 rounded ${STATUS_BADGE[wo.status as WorkOrderStatus]}`}>
            {t(`status.${wo.status}`, wo.status.replace('_', ' '))}
          </span>
        </div>
      </div>

      {wo.due_date && (
        <div className="text-xs text-amber-600 flex items-center gap-1">
          <AlertTriangle size={10} />
          {t('myWork.due', { date: wo.due_date })}
        </div>
      )}

      <InterventionCheckin workOrderId={wo.id} />

      <div className="flex gap-2 pt-1">
        {wo.status === 'open' && (
          <button
            onClick={() => onStart(wo.id)}
            disabled={busy}
            className="btn-success flex-1 py-3 text-sm font-semibold flex items-center justify-center gap-2"
          >
            <Play size={16} />
            {busy ? t('myWork.starting') : t('myWork.startWork')}
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
              {t('workOrders.holdWO')}
            </button>
            <button
              onClick={() => onComplete(wo.id)}
              disabled={busy}
              className="btn-primary flex-1 py-3 text-sm font-semibold flex items-center justify-center gap-2"
            >
              <CheckCircle2 size={16} />
              {t('workOrders.completeWO')}
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
            {busy ? t('myWork.resuming') : t('workOrders.resumeWO')}
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
