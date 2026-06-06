import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, X, Play, ChevronLeft, User } from 'lucide-react';
import {
  fetchMachinePage, fetchTodayStops, fetchMESData, fetchMachineOperators,
  updateMachineStatus, updateMachineJob, updateMachineOperator,
  createMachineStop, closeMachineStop, fetchMachineStopCategories,
  fetchMachineRejectCategories, logReject,
} from '../../api/machines';
import { openTicketField, closeTicket } from '../../api/maintenance';
import type {
  MachinePageData, MachineStatus, MachineStopOut, StopCategoryOut,
  StopSubcategoryOut, MachineOperatorOut, MESDataExtended,
  RejectCategoryOut, RejectSubcategoryOut,
} from '../../types';
import { IconRenderer } from '../../components/ui/IconLibrary';

// ── Local i18n (machine page has its own language setting) ────────────────────

const I18N = {
  en: {
    running: 'RUNNING', stopped: 'STOPPED', maintenance: 'MAINTENANCE',
    idle: 'IDLE', planned_stop: 'PLANNED STOP',
    newStop: 'NEW STOP', restart: 'RESTART',
    jobNumber: 'Job Number', noJob: 'No job',
    operator: 'Operator', noOperator: 'No operator',
    selectCategory: 'Select stop reason',
    selectSubcategory: 'Select reason',
    comment: 'Comment (optional)',
    commentPlaceholder: 'Add a comment...',
    confirmStop: 'CONFIRM STOP',
    confirmMaintenance: 'CONFIRM — NOTIFY MAINTENANCE',
    stoppedAt: 'Stop detected at',
    maintenanceWillBeNotified: 'Maintenance team will be notified',
    ticketCreated: 'Ticket created:',
    maintenanceNotified: 'Maintenance Team Notified',
    backToMachines: 'Back',
    todayTimeline: "Today's Timeline",
    availability: 'Availability',
    production: 'Production',
    target: 'Target',
    rejects: 'Rejects',
    oee: 'OEE',
    downtime: 'Downtime',
    mesComingSoon: 'MES Coming Soon',
    startWork: 'START WORK',
    completeWork: 'COMPLETE WORK',
    diagnosis: 'Diagnosis',
    correctiveAction: 'Corrective Action',
    interventionMin: 'Intervention (min)',
    confirmComplete: 'Confirm Completion',
    cancel: 'Cancel',
    submit: 'Submit',
    enterJobNumber: 'Enter job number...',
    activeTickets: 'Active Maintenance',
    min: 'min',
    changeOperator: 'Change operator',
    stopCount: 'stops today',
  },
  fr: {
    running: 'EN MARCHE', stopped: 'ARRÊTÉE', maintenance: 'MAINTENANCE',
    idle: 'INACTIF', planned_stop: 'ARRÊT PLANIFIÉ',
    newStop: 'NOUVEL ARRÊT', restart: 'REDÉMARRER',
    jobNumber: 'N° de job', noJob: 'Aucun job',
    operator: 'Opérateur', noOperator: 'Aucun opérateur',
    selectCategory: 'Sélectionner la raison',
    selectSubcategory: 'Sélectionner la raison',
    comment: 'Commentaire (optionnel)',
    commentPlaceholder: 'Ajouter un commentaire...',
    confirmStop: 'CONFIRMER L\'ARRÊT',
    confirmMaintenance: 'CONFIRMER — NOTIFIER MAINTENANCE',
    stoppedAt: 'Arrêt détecté à',
    maintenanceWillBeNotified: 'L\'équipe de maintenance sera notifiée',
    ticketCreated: 'Ticket créé :',
    maintenanceNotified: 'Équipe Maintenance Notifiée',
    backToMachines: 'Retour',
    todayTimeline: "Chronologie d'aujourd'hui",
    availability: 'Disponibilité',
    production: 'Production',
    target: 'Objectif',
    rejects: 'Rejets',
    oee: 'TRS',
    downtime: 'Arrêt',
    mesComingSoon: 'MES à venir',
    startWork: 'DÉMARRER',
    completeWork: 'TERMINER',
    diagnosis: 'Diagnostic',
    correctiveAction: 'Action corrective',
    interventionMin: 'Intervention (min)',
    confirmComplete: 'Confirmer la clôture',
    cancel: 'Annuler',
    submit: 'Valider',
    enterJobNumber: 'Saisir n° de job...',
    activeTickets: 'Maintenance active',
    min: 'min',
    changeOperator: 'Changer d\'opérateur',
    stopCount: 'arrêts aujourd\'hui',
  },
  es: {
    running: 'EN MARCHA', stopped: 'DETENIDA', maintenance: 'MANTENIMIENTO',
    idle: 'INACTIVO', planned_stop: 'PARADA PLANIFICADA',
    newStop: 'NUEVA PARADA', restart: 'REINICIAR',
    jobNumber: 'N° de trabajo', noJob: 'Sin trabajo',
    operator: 'Operador', noOperator: 'Sin operador',
    selectCategory: 'Seleccionar razón',
    selectSubcategory: 'Seleccionar razón',
    comment: 'Comentario (opcional)',
    commentPlaceholder: 'Agregar un comentario...',
    confirmStop: 'CONFIRMAR PARADA',
    confirmMaintenance: 'CONFIRMAR — NOTIFICAR MANTENIMIENTO',
    stoppedAt: 'Parada detectada a las',
    maintenanceWillBeNotified: 'Se notificará al equipo de mantenimiento',
    ticketCreated: 'Ticket creado:',
    maintenanceNotified: 'Equipo de Mantenimiento Notificado',
    backToMachines: 'Volver',
    todayTimeline: 'Cronología de hoy',
    availability: 'Disponibilidad',
    production: 'Producción',
    target: 'Objetivo',
    rejects: 'Rechazos',
    oee: 'OEE',
    downtime: 'Parada',
    mesComingSoon: 'MES próximamente',
    startWork: 'INICIAR',
    completeWork: 'COMPLETAR',
    diagnosis: 'Diagnóstico',
    correctiveAction: 'Acción correctiva',
    interventionMin: 'Intervención (min)',
    confirmComplete: 'Confirmar cierre',
    cancel: 'Cancelar',
    submit: 'Confirmar',
    enterJobNumber: 'Ingresar n° de trabajo...',
    activeTickets: 'Mantenimiento activo',
    min: 'min',
    changeOperator: 'Cambiar operador',
    stopCount: 'paradas hoy',
  },
} as const;
type Lang = keyof typeof I18N;

const STATUS_COLOR: Record<string, string> = {
  running:      'text-blue-400 bg-blue-500/15 border-blue-500/40',
  stopped:      'text-pink-400 bg-pink-500/15 border-pink-500/40',
  maintenance:  'text-amber-400 bg-amber-500/15 border-amber-500/40',
  idle:         'text-gray-400 bg-gray-500/15 border-gray-500/30',
  planned_stop: 'text-slate-400 bg-slate-500/15 border-slate-500/30',
};
const STATUS_DOT: Record<string, string> = {
  running: 'bg-blue-400', stopped: 'bg-pink-400', maintenance: 'bg-amber-400',
  idle: 'bg-gray-500', planned_stop: 'bg-slate-400',
};
const STATUS_BG: Record<string, string> = {
  running: '#3b82f6', stopped: '#ec4899', maintenance: '#f59e0b',
  idle: '#6b7280', planned_stop: '#94a3b8',
};

function useTimer(sinceIso?: string | null): string {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!sinceIso) { setElapsed(0); return; }
    const base = new Date(sinceIso).getTime();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - base) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [sinceIso]);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function AvailabilityGauge({ pct, target, color }: { pct: number; target: number; color: string }) {
  const r = 56, cx = 70, cy = 75;
  const circumference = Math.PI * r;
  const dashOffset = circumference * (1 - Math.min(1, pct / 100));
  const targetAngle = (1 - Math.min(1, target / 100)) * Math.PI;
  const tx = cx + r * Math.cos(Math.PI + targetAngle);
  const ty = cy + r * Math.sin(Math.PI + targetAngle);
  return (
    <svg viewBox="0 0 140 90" className="w-full">
      <path d={`M ${cx - r},${cy} A ${r},${r} 0 0,1 ${cx + r},${cy}`}
        fill="none" stroke="#1e293b" strokeWidth="14" strokeLinecap="round" />
      <path d={`M ${cx - r},${cy} A ${r},${r} 0 0,1 ${cx + r},${cy}`}
        fill="none" stroke={color} strokeWidth="14" strokeLinecap="round"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset}
        style={{ transition: 'stroke-dashoffset 1s ease' }} />
      <line x1={tx} y1={ty} x2={cx + (r + 10) * Math.cos(Math.PI + targetAngle)}
        y2={cy + (r + 10) * Math.sin(Math.PI + targetAngle)}
        stroke="#94a3b8" strokeWidth="2" strokeDasharray="3,2" />
      <text x={cx} y={cy - 8} textAnchor="middle" fill="white" fontSize="18" fontWeight="bold">
        {Math.round(pct)}%
      </text>
      <text x={cx} y={cy + 8} textAnchor="middle" fill="#64748b" fontSize="9">
        target {target}%
      </text>
    </svg>
  );
}

function StopTimeline({ stops, accentColor }: { stops: MachineStopOut[]; accentColor: string }) {
  const now = Date.now();
  const midnightMs = new Date().setHours(0, 0, 0, 0);
  const dayMs = 24 * 3600 * 1000;
  const elapsedMs = now - midnightMs;

  return (
    <div className="relative h-8 rounded-lg overflow-hidden bg-[#1e293b]">
      {/* Running (blue) background up to now */}
      <div
        className="absolute left-0 top-0 h-full rounded-lg"
        style={{ width: `${(elapsedMs / dayMs) * 100}%`, backgroundColor: STATUS_BG.running + '40' }}
      />
      {stops.map((stop) => {
        const s = new Date(stop.started_at).getTime() - midnightMs;
        const e = stop.ended_at ? new Date(stop.ended_at).getTime() - midnightMs : elapsedMs;
        const left = Math.max(0, s / dayMs * 100);
        const width = Math.max(0.3, (e - s) / dayMs * 100);
        const color = stop.category?.color ?? '#ec4899';
        return (
          <div
            key={stop.id}
            className="absolute top-0 h-full"
            style={{ left: `${left}%`, width: `${width}%`, backgroundColor: color }}
            title={`${stop.category?.name ?? 'Stop'}: ${stop.started_at.slice(11, 16)} – ${stop.ended_at ? stop.ended_at.slice(11, 16) : 'ongoing'}`}
          />
        );
      })}
      {/* Time labels */}
      {[0, 6, 12, 18, 24].map((h) => (
        <span
          key={h}
          className="absolute top-1 text-[8px] text-gray-700 font-mono select-none"
          style={{ left: `${(h / 24) * 100}%`, transform: 'translateX(-50%)' }}
        >
          {String(h).padStart(2, '0')}:00
        </span>
      ))}
    </div>
  );
}

type ModalStep = 'categories' | 'subcategories' | 'confirm-maintenance' | 'confirm-unplanned';
type RejectStep = 'categories' | 'subcategories' | 'quantity';

export default function MachinePage() {
  const { slug } = useParams<{ slug: string }>();
  const [machine, setMachine] = useState<MachinePageData | null>(null);
  const [mes, setMes]         = useState<MESDataExtended | null>(null);
  const [stops, setStops]     = useState<MachineStopOut[]>([]);
  const [operators, setOps]   = useState<MachineOperatorOut[]>([]);
  const [categories, setCats] = useState<StopCategoryOut[]>([]);
  const [rejectCats, setRejectCats] = useState<RejectCategoryOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  // Reject modal
  const [showRejectModal, setShowRejectModal]     = useState(false);
  const [rejectStep, setRejectStep]               = useState<RejectStep>('categories');
  const [selectedRejectCat, setSelectedRejectCat] = useState<RejectCategoryOut | null>(null);
  const [selectedRejectSub, setSelectedRejectSub] = useState<RejectSubcategoryOut | null>(null);
  const [rejectQty, setRejectQty]                 = useState(1);
  const [rejectComment, setRejectComment]         = useState('');
  const [rejectBusy, setRejectBusy]               = useState(false);

  const [jobInput, setJobInput]       = useState('');
  const [showOpList, setShowOpList]   = useState(false);
  const [confirmedTicket, setConfirmedTicket] = useState<string | null>(null);

  // Stop modal state
  const [showModal, setShowModal]           = useState(false);
  const [modalStep, setModalStep]           = useState<ModalStep>('categories');
  const [selectedCat, setSelectedCat]       = useState<StopCategoryOut | null>(null);
  const [selectedSub, setSelectedSub]       = useState<StopSubcategoryOut | null>(null);
  const [stopComment, setStopComment]       = useState('');
  const [currentStopId, setCurrentStopId]   = useState<string | null>(null);
  const [modalBusy, setModalBusy]           = useState(false);
  const [stopTime, setStopTime]             = useState<string>('');

  // Ticket close state
  const [closingTicketId, setClosingTicketId] = useState<string | null>(null);
  const [diagnosis, setDiagnosis]             = useState('');
  const [corrective, setCorrective]           = useState('');
  const [intMins, setIntMins]                 = useState('');
  const [techBusy, setTechBusy]               = useState(false);

  const lang: Lang = (machine?.page_language as Lang) || 'fr';
  const t = I18N[lang] || I18N.fr;
  const accentColor = machine?.custom_color || STATUS_BG[machine?.current_status || 'running'] || '#3b82f6';

  const isRunning = machine?.current_status === 'running';
  const statusSince = isRunning ? machine?.last_start_at : machine?.last_stop_at;
  const timerStr = useTimer(statusSince);

  const load = useCallback(() => {
    if (!slug) return;
    setLoading(true);
    Promise.allSettled([
      fetchMachinePage(slug),
      fetchTodayStops(slug),
      fetchMESData(slug),
      fetchMachineStopCategories(slug),
      fetchMachineRejectCategories(slug),
    ]).then(([mp, ms, md, cats, rcats]) => {
      if (mp.status === 'fulfilled') {
        setMachine(mp.value);
        setJobInput(mp.value.current_job_number ?? '');
      } else {
        setError('Machine not found');
      }
      if (ms.status === 'fulfilled') setStops(ms.value);
      if (md.status === 'fulfilled') setMes(md.value);
      if (cats.status === 'fulfilled') setCats(cats.value);
      if (rcats.status === 'fulfilled') setRejectCats(rcats.value);
      setLoading(false);
    });
    if (slug) {
      fetchMachineOperators(slug).then(setOps).catch(() => {});
    }
  }, [slug]);

  useEffect(load, [load]);

  // Auto-refresh every 30s
  useEffect(() => {
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const openStopModal = () => {
    setStopTime(new Date().toTimeString().slice(0, 8));
    setSelectedCat(null); setSelectedSub(null); setStopComment('');
    setModalStep('categories');
    setShowModal(true);
  };

  const handleCategorySelect = async (cat: StopCategoryOut) => {
    setSelectedCat(cat);
    if (cat.type === 'unplanned' && cat.subcategories.length > 0) {
      setModalStep('subcategories');
    } else if (cat.type === 'maintenance') {
      setModalStep('confirm-maintenance');
    } else {
      setModalStep('confirm-unplanned');
    }
  };

  const handleSubcategorySelect = (sub: StopSubcategoryOut) => {
    setSelectedSub(sub);
    setModalStep('confirm-unplanned');
  };

  const submitStop = async (triggersMaintenance = false) => {
    if (!slug || !machine) return;
    setModalBusy(true);
    try {
      const payload: any = {
        stop_category_id:    selectedCat?.id,
        stop_subcategory_id: selectedSub?.id,
        comments:            stopComment || undefined,
      };
      const res = await createMachineStop(slug, payload);
      setCurrentStopId(res.id);
      if (res.ticket_number) {
        setConfirmedTicket(res.ticket_number);
      }
      setShowModal(false);
      load();
    } finally {
      setModalBusy(false);
    }
  };

  const handleRestart = async () => {
    if (!slug || !machine) return;
    if (currentStopId) {
      await closeMachineStop(slug, currentStopId);
      setCurrentStopId(null);
    } else {
      // Find open stop
      const openStop = stops.find((s) => !s.ended_at);
      if (openStop) {
        await closeMachineStop(slug, openStop.id);
      } else {
        await updateMachineStatus(slug, { status: 'running' as MachineStatus });
      }
    }
    load();
  };

  const handleJobSubmit = async () => {
    if (!slug) return;
    await updateMachineJob(slug, jobInput || null);
    load();
  };

  const handleOpSelect = async (op: MachineOperatorOut) => {
    if (!slug) return;
    await updateMachineOperator(slug, { operator_name: op.name, operator_id: op.id });
    setShowOpList(false);
    load();
  };

  const openRejectModal = () => {
    setRejectStep(rejectCats.length > 0 ? 'categories' : 'quantity');
    setSelectedRejectCat(null); setSelectedRejectSub(null);
    setRejectQty(1); setRejectComment('');
    setShowRejectModal(true);
  };

  const handleRejectCatSelect = (cat: RejectCategoryOut) => {
    setSelectedRejectCat(cat);
    if (cat.subcategories.length > 0) {
      setRejectStep('subcategories');
    } else {
      setRejectStep('quantity');
    }
  };

  const handleRejectSubSelect = (sub: RejectSubcategoryOut) => {
    setSelectedRejectSub(sub);
    setRejectStep('quantity');
  };

  const submitReject = async () => {
    if (!slug) return;
    setRejectBusy(true);
    try {
      const payload = {
        category_id:    selectedRejectCat?.id,
        subcategory_id: selectedRejectSub?.id,
        quantity:       rejectQty,
        comment:        rejectComment || undefined,
      };
      const res = await logReject(slug, payload);
      setMes((prev) => prev ? { ...prev, reject_count: res.reject_count } : prev);
      setShowRejectModal(false);
    } finally {
      setRejectBusy(false);
    }
  };

  const doOpenField = async (ticketId: string) => {
    setTechBusy(true);
    try { await openTicketField(ticketId); load(); }
    finally { setTechBusy(false); }
  };

  const doCloseField = async (ticketId: string) => {
    if (!diagnosis || !corrective || !intMins) return;
    setTechBusy(true);
    try {
      await closeTicket(ticketId, {
        diagnosis, corrective_action: corrective,
        total_intervention_minutes: parseInt(intMins),
      });
      setClosingTicketId(null); setDiagnosis(''); setCorrective(''); setIntMins('');
      load();
    } finally { setTechBusy(false); }
  };

  if (loading) return (
    <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center">
      <div className="text-center space-y-4">
        <div className="w-16 h-16 border-4 border-blue-500/30 border-t-blue-500 rounded-full animate-spin mx-auto" />
        <p className="text-gray-400 text-xl">Loading...</p>
      </div>
    </div>
  );

  if (error || !machine) return (
    <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center">
      <div className="text-center space-y-4">
        <AlertTriangle size={56} className="text-red-400 mx-auto" />
        <p className="text-white text-3xl font-black">Machine Not Found</p>
        <p className="text-gray-500">{slug}</p>
      </div>
    </div>
  );

  const status = (machine.current_status || 'running') as string;
  const statusCls = STATUS_COLOR[status] || STATUS_COLOR.running;
  const statusDot = STATUS_DOT[status] || STATUS_DOT.running;
  const statusLabel = t[status as keyof typeof t] as string || status.toUpperCase();
  const openTickets = machine.open_tickets ?? [];
  const todayStopCount = stops.length;

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white flex flex-col" style={machine.custom_color ? { '--accent': machine.custom_color } as any : {}}>

      {/* ── Confirmed ticket banner ── */}
      {confirmedTicket && (
        <div className="bg-green-500/10 border-b border-green-500/30 px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CheckCircle2 size={22} className="text-green-400" />
            <p className="text-green-300 font-bold">{t.maintenanceNotified} — <span className="font-mono">{confirmedTicket}</span></p>
          </div>
          <button onClick={() => setConfirmedTicket(null)}><X size={18} className="text-green-600 hover:text-green-300" /></button>
        </div>
      )}

      {/* ── Top row: Status + Job + Stop/Restart ── */}
      <div className="grid grid-cols-3 gap-4 p-4 pb-2">

        {/* Panel 1 — Status + Timer + Operator */}
        <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5 flex flex-col gap-3">
          <div className={`flex items-center gap-3 px-4 py-2.5 rounded-xl border w-fit text-xl font-black ${statusCls}`}>
            <span className={`w-3 h-3 rounded-full animate-pulse ${statusDot}`} />
            {statusLabel}
          </div>

          <div className="font-mono text-5xl font-black text-white tracking-wider leading-none">
            {timerStr}
          </div>

          <div className="mt-auto space-y-2">
            <p className="text-3xl font-bold text-white truncate">
              {machine.display_name || machine.name}
            </p>
            {machine.code && (
              <p className="text-sm font-mono text-gray-600">{machine.code}</p>
            )}

            {/* Operator selector */}
            <div className="relative">
              <button
                onClick={() => setShowOpList((v) => !v)}
                className="flex items-center gap-2 text-base text-gray-300 hover:text-white transition-colors"
              >
                <User size={16} className="text-gray-500" />
                {machine.current_operator || t.noOperator}
              </button>
              {showOpList && operators.length > 0 && (
                <div className="absolute z-20 mt-1 bg-[#0d1421] border border-white/10 rounded-xl shadow-2xl min-w-[200px]">
                  {operators.map((op) => (
                    <button
                      key={op.id}
                      onClick={() => handleOpSelect(op)}
                      className="w-full text-left px-4 py-3 text-base text-gray-200 hover:bg-white/[0.05] first:rounded-t-xl last:rounded-b-xl transition-colors"
                    >
                      {op.name}
                      {op.shift !== 'all' && <span className="text-xs text-gray-600 ml-2">({op.shift})</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <p className="text-sm text-gray-600">
              {todayStopCount} {t.stopCount}
            </p>
          </div>
        </div>

        {/* Panel 2 — Job number (if enabled) */}
        {machine.show_job_number && (
          <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5 flex flex-col justify-between">
            <p className="text-sm font-semibold text-gray-500 uppercase tracking-widest">{t.jobNumber}</p>
            <div>
              <p className="text-3xl font-bold text-white mb-4">
                {machine.current_job_number || <span className="text-gray-600">{t.noJob}</span>}
              </p>
              <div className="flex gap-2">
                <input
                  value={jobInput}
                  onChange={(e) => setJobInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleJobSubmit()}
                  placeholder={t.enterJobNumber}
                  className="flex-1 bg-[#0b1120] border border-white/10 rounded-xl px-4 py-3 text-white text-base placeholder-gray-600 focus:outline-none focus:border-blue-500 min-w-0"
                />
                <button
                  onClick={handleJobSubmit}
                  className="px-5 py-3 rounded-xl text-base font-bold text-white"
                  style={{ backgroundColor: accentColor + 'cc' }}
                >
                  {t.submit}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Panel 3 — STOP / RESTART */}
        <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5 flex flex-col items-center justify-center gap-4">
          {isRunning ? (
            <button
              onClick={openStopModal}
              className="w-36 h-36 rounded-full border-4 border-red-500/60 bg-red-500/15 hover:bg-red-500/25 text-red-400 flex flex-col items-center justify-center gap-1 transition-all active:scale-95 shadow-2xl shadow-red-500/10"
            >
              <span className="text-4xl">⏹</span>
              <span className="text-sm font-black tracking-wider">{t.newStop}</span>
            </button>
          ) : (
            <button
              onClick={handleRestart}
              className="w-36 h-36 rounded-full border-4 border-green-500/60 bg-green-500/15 hover:bg-green-500/25 text-green-400 flex flex-col items-center justify-center gap-1 transition-all active:scale-95 shadow-2xl shadow-green-500/10"
            >
              <span className="text-4xl">▶</span>
              <span className="text-sm font-black tracking-wider">{t.restart}</span>
            </button>
          )}
        </div>
      </div>

      {/* ── Panel 4: Timeline ── */}
      <div className="mx-4 bg-[#0d1421] rounded-2xl border border-white/[0.06] p-4">
        <p className="text-xs text-gray-600 uppercase tracking-widest mb-3 font-semibold">{t.todayTimeline}</p>
        <StopTimeline stops={stops} accentColor={accentColor} />
      </div>

      {/* ── Middle row: Production chart + Availability ── */}
      <div className={`grid gap-4 p-4 pb-2 ${machine.show_availability_gauge ? 'grid-cols-2' : 'grid-cols-1'}`}>

        {/* Panel 5 — Production (mock) */}
        {machine.show_production_panel && (
          <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5 relative overflow-hidden">
            <p className="text-xs text-gray-600 uppercase tracking-widest mb-2 font-semibold">{t.production}</p>
            <div className="flex gap-8">
              <div>
                <p className="text-4xl font-black text-gray-600">{mes?.is_placeholder ? '—' : mes?.production_count ?? 0}</p>
                <p className="text-xs text-gray-700 mt-1">{t.production}</p>
              </div>
              <div>
                <p className="text-4xl font-black text-gray-600">{mes?.is_placeholder ? '—' : (machine.target_count ?? mes?.target ?? 0)}</p>
                <p className="text-xs text-gray-700 mt-1">{t.target}</p>
              </div>
              <div>
                <p className="text-4xl font-black text-gray-600">{mes?.is_placeholder ? '—' : `${mes?.oee_pct ?? 0}%`}</p>
                <p className="text-xs text-gray-700 mt-1">{t.oee}</p>
              </div>
              <div>
                <p className="text-4xl font-black text-gray-400">{mes?.downtime_today_minutes ?? 0}</p>
                <p className="text-xs text-gray-600 mt-1">{t.downtime} ({t.min})</p>
              </div>
            </div>
            {mes?.is_placeholder && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#0d1421]/60 backdrop-blur-sm rounded-2xl">
                <span className="text-xs text-gray-700 font-mono border border-gray-800 px-3 py-1.5 rounded-full">{t.mesComingSoon}</span>
              </div>
            )}
          </div>
        )}

        {/* Panel 6 — Availability gauge */}
        {machine.show_availability_gauge && (
          <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5">
            <p className="text-xs text-gray-600 uppercase tracking-widest mb-1 font-semibold">{t.availability}</p>
            <AvailabilityGauge
              pct={mes?.availability_pct ?? 0}
              target={machine.target_availability_pct ?? 70}
              color={accentColor}
            />
          </div>
        )}
      </div>

      {/* ── Bottom row: Rejects ── */}
      {machine.show_reject_panel && (
        <div className="grid grid-cols-2 gap-4 px-4 pb-4">
          {/* Panel 7 — Reject count */}
          <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-600 uppercase tracking-widest mb-1 font-semibold">{t.rejects}</p>
              <p className="text-6xl font-black text-red-400">{mes?.reject_count ?? 0}</p>
            </div>
            <div className="flex flex-col gap-3">
              <button
                onClick={openRejectModal}
                className="w-16 h-16 rounded-full bg-red-600/20 hover:bg-red-600/30 border-2 border-red-500/40 text-red-400 text-3xl font-black transition-all active:scale-90"
              >+1</button>
            </div>
          </div>

          {/* Active tickets (if any) */}
          <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5 overflow-y-auto max-h-48">
            {openTickets.length === 0 ? (
              <div className="h-full flex items-center justify-center">
                <p className="text-gray-700 text-sm">No active maintenance</p>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-gray-600 uppercase tracking-widest font-semibold mb-2">{t.activeTickets}</p>
                {openTickets.map((ticket) => (
                  <div key={ticket.id} className="border border-amber-500/20 rounded-xl p-3 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-amber-400 font-mono font-bold text-sm">{ticket.ticket_number}</span>
                      <span className="text-xs text-gray-500">{ticket.status.replace(/_/g, ' ')}</span>
                    </div>
                    {ticket.problem_type && <p className="text-gray-300 text-xs">{ticket.problem_type}</p>}
                    <div className="flex gap-2">
                      {!ticket.opened_by_technician_at && (
                        <button
                          onClick={() => doOpenField(ticket.id)}
                          disabled={techBusy}
                          className="flex items-center gap-1.5 bg-green-600/20 text-green-400 border border-green-500/30 rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-50"
                        >
                          <Play size={12} /> {t.startWork}
                        </button>
                      )}
                      {ticket.status === 'in_progress' && (
                        <button
                          onClick={() => setClosingTicketId(ticket.id)}
                          className="flex items-center gap-1.5 bg-blue-600/20 text-blue-400 border border-blue-500/30 rounded-lg px-3 py-1.5 text-xs font-bold"
                        >
                          <CheckCircle2 size={12} /> {t.completeWork}
                        </button>
                      )}
                    </div>
                    {closingTicketId === ticket.id && (
                      <div className="border-t border-white/[0.06] pt-3 space-y-2">
                        <textarea
                          value={diagnosis}
                          onChange={(e) => setDiagnosis(e.target.value)}
                          rows={2} placeholder={t.diagnosis}
                          className="w-full bg-[#0b1120] border border-white/10 rounded-lg px-3 py-2 text-white text-xs placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-none"
                        />
                        <textarea
                          value={corrective}
                          onChange={(e) => setCorrective(e.target.value)}
                          rows={2} placeholder={t.correctiveAction}
                          className="w-full bg-[#0b1120] border border-white/10 rounded-lg px-3 py-2 text-white text-xs placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-none"
                        />
                        <input
                          type="number" value={intMins} onChange={(e) => setIntMins(e.target.value)}
                          placeholder={t.interventionMin}
                          className="w-full bg-[#0b1120] border border-white/10 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-blue-500"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => doCloseField(ticket.id)}
                            disabled={techBusy || !diagnosis || !corrective || !intMins}
                            className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold px-3 py-2 rounded-lg disabled:opacity-50"
                          >{t.confirmComplete}</button>
                          <button onClick={() => setClosingTicketId(null)} className="text-gray-400 text-xs px-3 py-2 border border-white/10 rounded-lg">{t.cancel}</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Reject Category Modal ── */}
      {showRejectModal && (
        <div className="fixed inset-0 z-50 bg-black/90 flex flex-col">
          <div className="flex items-center justify-between px-8 py-6 border-b border-white/[0.06]">
            <div>
              <h2 className="text-2xl font-black text-white">{t.rejects}</h2>
              <p className="text-gray-400 text-base mt-1">{machine?.display_name || machine?.name}</p>
            </div>
            {rejectStep !== 'categories' && (
              <button onClick={() => setRejectStep(rejectStep === 'quantity' && selectedRejectSub ? 'subcategories' : 'categories')}
                className="flex items-center gap-2 text-gray-400 hover:text-white text-base font-medium">
                <ChevronLeft size={20} /> {t.backToMachines}
              </button>
            )}
            <button onClick={() => setShowRejectModal(false)}><X size={28} className="text-gray-600 hover:text-gray-300" /></button>
          </div>

          <div className="flex-1 overflow-y-auto px-8 py-8">
            {rejectStep === 'categories' && (
              <div className="space-y-6">
                <div className="flex flex-wrap gap-6 justify-center">
                  {rejectCats.map((cat) => (
                    <button key={cat.id} onClick={() => handleRejectCatSelect(cat)}
                      className="flex flex-col items-center gap-3 p-6 rounded-3xl border-2 transition-all active:scale-95 hover:scale-105"
                      style={{ borderColor: (cat.color || '#6b7280') + '80', backgroundColor: (cat.color || '#6b7280') + '15', minWidth: '140px', minHeight: '140px' }}>
                      <IconRenderer icon={cat.icon || 'quality'} color={cat.color || '#6b7280'} size={40} />
                      <span className="text-base font-bold text-white text-center leading-snug">{cat.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {rejectStep === 'subcategories' && selectedRejectCat && (
              <div className="space-y-6">
                <p className="text-xl text-gray-400 font-semibold">{selectedRejectCat.name}</p>
                <div className="flex flex-wrap gap-6 justify-center">
                  {selectedRejectCat.subcategories.map((sub: RejectSubcategoryOut) => (
                    <button key={sub.id} onClick={() => handleRejectSubSelect(sub)}
                      className="flex flex-col items-center gap-3 p-6 rounded-3xl border-2 border-white/10 bg-white/[0.04] hover:bg-white/[0.08] transition-all active:scale-95 hover:scale-105"
                      style={{ minWidth: '140px', minHeight: '140px' }}>
                      <IconRenderer icon={sub.icon || 'quality'} color={sub.color || '#6b7280'} size={40} />
                      <span className="text-base font-bold text-white text-center">{sub.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {rejectStep === 'quantity' && (
              <div className="max-w-md mx-auto space-y-6">
                {selectedRejectCat && (
                  <div className="text-center space-y-2">
                    <IconRenderer icon={selectedRejectCat.icon || 'quality'} color={selectedRejectCat.color || '#6b7280'} size={40} className="mx-auto" />
                    <h3 className="text-xl font-black text-white">
                      {selectedRejectSub?.name ?? selectedRejectCat.name}
                    </h3>
                  </div>
                )}
                <div>
                  <label className="block text-sm text-gray-500 uppercase tracking-wide mb-2">Quantity</label>
                  <div className="flex items-center gap-4 justify-center">
                    <button onClick={() => setRejectQty((q) => Math.max(1, q - 1))}
                      className="w-14 h-14 rounded-full bg-gray-700 hover:bg-gray-600 text-white text-2xl font-black transition-all active:scale-90">−</button>
                    <span className="text-6xl font-black text-white w-20 text-center">{rejectQty}</span>
                    <button onClick={() => setRejectQty((q) => q + 1)}
                      className="w-14 h-14 rounded-full bg-gray-700 hover:bg-gray-600 text-white text-2xl font-black transition-all active:scale-90">+</button>
                  </div>
                </div>
                {(selectedRejectCat?.comment_required || selectedRejectSub?.comment_required) && (
                  <div>
                    <label className="block text-sm text-gray-500 uppercase tracking-wide mb-2">{t.comment}</label>
                    <textarea value={rejectComment} onChange={(e) => setRejectComment(e.target.value)}
                      rows={3} placeholder={t.commentPlaceholder}
                      className="w-full bg-[#0d1421] border border-white/10 rounded-xl px-5 py-4 text-white text-base placeholder-gray-600 focus:outline-none focus:border-red-500 resize-none" />
                  </div>
                )}
                <button onClick={submitReject} disabled={rejectBusy}
                  className="w-full py-5 rounded-2xl font-black text-xl text-white bg-red-600 hover:bg-red-500 transition-all active:scale-95 disabled:opacity-50">
                  {rejectBusy ? '...' : `${t.confirmStop} — ${rejectQty}`}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Stop Justification Modal ── */}
      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/90 flex flex-col">
          <div className="flex items-center justify-between px-8 py-6 border-b border-white/[0.06]">
            <div>
              <h2 className="text-2xl font-black text-white">
                {machine.display_name || machine.name}
              </h2>
              <p className="text-gray-400 text-base mt-1">
                {t.stoppedAt} {stopTime}
              </p>
            </div>
            {modalStep !== 'categories' && (
              <button
                onClick={() => setModalStep('categories')}
                className="flex items-center gap-2 text-gray-400 hover:text-white text-base font-medium"
              >
                <ChevronLeft size={20} /> {t.backToMachines}
              </button>
            )}
            <button onClick={() => setShowModal(false)}>
              <X size={28} className="text-gray-600 hover:text-gray-300" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-8 py-8">
            {/* Step 1: Categories */}
            {modalStep === 'categories' && (
              <div className="space-y-6">
                <p className="text-xl text-gray-400 font-semibold">{t.selectCategory}</p>
                <div className="flex flex-wrap gap-6 justify-center">
                  {categories.map((cat) => {
                    const todayCount = stops.filter((s) => s.category?.id === cat.id).length;
                    return (
                      <button
                        key={cat.id}
                        onClick={() => handleCategorySelect(cat)}
                        className="flex flex-col items-center gap-3 p-6 rounded-3xl border-2 transition-all active:scale-95 hover:scale-105"
                        style={{
                          borderColor: cat.color + '80',
                          backgroundColor: cat.color + '15',
                          minWidth: '140px', minHeight: '140px',
                        }}
                      >
                        <IconRenderer icon={cat.icon} color={cat.color} size={36} />
                        <span className="text-base font-bold text-white text-center leading-snug">{cat.name}</span>
                        {todayCount > 0 && (
                          <span
                            className="text-xs font-bold px-2 py-0.5 rounded-full"
                            style={{ backgroundColor: cat.color + '30', color: cat.color }}
                          >{todayCount}×</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Step 2: Subcategories (unplanned) */}
            {modalStep === 'subcategories' && selectedCat && (
              <div className="space-y-6">
                <p className="text-xl text-gray-400 font-semibold">
                  {selectedCat.icon} {selectedCat.name} — {t.selectSubcategory}
                </p>
                <div className="flex flex-wrap gap-6 justify-center">
                  {selectedCat.subcategories.map((sub) => (
                    <button
                      key={sub.id}
                      onClick={() => handleSubcategorySelect(sub)}
                      className="flex flex-col items-center gap-3 p-6 rounded-3xl border-2 border-white/10 bg-white/[0.04] hover:bg-white/[0.08] transition-all active:scale-95 hover:scale-105"
                      style={{ minWidth: '140px', minHeight: '140px' }}
                    >
                      <IconRenderer icon={sub.icon} color={sub.color || '#6b7280'} size={36} />
                      <span className="text-base font-bold text-white text-center leading-snug">{sub.name}</span>
                      {sub.triggers_maintenance && (
                        <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full">
                          Maintenance
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Step 3a: Confirm maintenance */}
            {modalStep === 'confirm-maintenance' && selectedCat && (
              <div className="max-w-lg mx-auto space-y-6">
                <div className="text-center space-y-3">
                  <div className="flex justify-center"><IconRenderer icon={selectedCat.icon} color={selectedCat.color} size={48} /></div>
                  <h3 className="text-2xl font-black text-white">{selectedCat.name}</h3>
                  <p className="text-gray-400 text-base">{t.maintenanceWillBeNotified}</p>
                </div>
                <div>
                  <label className="block text-sm text-gray-500 uppercase tracking-wide mb-2">{t.comment}</label>
                  <textarea
                    value={stopComment}
                    onChange={(e) => setStopComment(e.target.value)}
                    rows={3}
                    placeholder={t.commentPlaceholder}
                    className="w-full bg-[#0d1421] border border-white/10 rounded-xl px-5 py-4 text-white text-base placeholder-gray-600 focus:outline-none focus:border-amber-500 resize-none text-lg"
                  />
                </div>
                <button
                  onClick={() => submitStop(true)}
                  disabled={modalBusy}
                  className="w-full py-5 rounded-2xl font-black text-xl text-white transition-all active:scale-95 disabled:opacity-50"
                  style={{ backgroundColor: selectedCat.color }}
                >
                  {modalBusy ? '...' : t.confirmMaintenance}
                </button>
              </div>
            )}

            {/* Step 3b: Confirm unplanned stop */}
            {modalStep === 'confirm-unplanned' && (selectedCat || selectedSub) && (
              <div className="max-w-lg mx-auto space-y-6">
                <div className="text-center space-y-3">
                  <div className="flex justify-center"><IconRenderer icon={(selectedSub?.icon ?? selectedCat?.icon) || 'wrench'} color={selectedSub?.color ?? selectedCat?.color ?? '#6b7280'} size={48} /></div>
                  <h3 className="text-2xl font-black text-white">{selectedSub?.name ?? selectedCat?.name}</h3>
                  {selectedSub?.triggers_maintenance && (
                    <p className="text-amber-400 text-base font-semibold">{t.maintenanceWillBeNotified}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm text-gray-500 uppercase tracking-wide mb-2">{t.comment}</label>
                  <textarea
                    value={stopComment}
                    onChange={(e) => setStopComment(e.target.value)}
                    rows={3}
                    placeholder={t.commentPlaceholder}
                    className="w-full bg-[#0d1421] border border-white/10 rounded-xl px-5 py-4 text-white text-base placeholder-gray-600 focus:outline-none focus:border-red-500 resize-none text-lg"
                  />
                </div>
                <button
                  onClick={() => submitStop(selectedSub?.triggers_maintenance ?? false)}
                  disabled={modalBusy}
                  className="w-full py-5 rounded-2xl font-black text-xl text-white bg-pink-600 hover:bg-pink-500 transition-all active:scale-95 disabled:opacity-50"
                >
                  {modalBusy ? '...' : t.confirmStop}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
