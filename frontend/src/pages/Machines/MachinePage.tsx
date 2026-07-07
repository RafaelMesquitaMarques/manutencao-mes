import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, X, Play, ChevronLeft, ChevronRight, User, Clock, Cog, Maximize2, Minimize2, MessageSquare } from 'lucide-react';
import {
  fetchMachinePage, fetchTodayStops, fetchMESData, fetchMachineOperators,
  updateMachineStatus, updateMachineJob, updateMachineOperator,
  createMachineStop, closeMachineStop, fetchMachineStopCategories,
  fetchMachineRejectCategories, logReject, addRejects, reclassifyStop,
  fetchProductionHourly, fetchTodayRejects, type HourlyPoint, type RejectLogItem,
} from '../../api/machines';
import EventsModal from './EventsModal';
import { openTicketField, closeTicket } from '../../api/maintenance';
import { callMaintenance } from '../../api/machineOperator';
import { MaintenancePanel } from '../MachineView/MachineOperatorPage';
import type {
  MachinePageData, MachineStatus, MachineStopOut, StopCategoryOut,
  StopSubcategoryOut, MachineOperatorOut, MESDataExtended,
  RejectCategoryOut, RejectSubcategoryOut,
} from '../../types';
import { IconRenderer } from '../../components/ui/IconLibrary';
import GridLayout, { WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { useRole } from '../../hooks/usePermission';
import api from '../../api/axios';
import { STATUS_HEX, statusColor } from '../../utils/statusColors';
import { useMachineLive } from '../../hooks/useLiveEvents';

const RGL = WidthProvider(GridLayout);
// Default arrangement of the kiosk panels (12-col grid). Saved per machine in kiosk_layout.
const DEFAULT_KIOSK_LAYOUT: Layout[] = [
  { i: 'status', x: 0, y: 0, w: 4, h: 6 },
  { i: 'job', x: 4, y: 0, w: 4, h: 6 },
  { i: 'stop', x: 8, y: 0, w: 4, h: 6 },
  { i: 'timeline', x: 0, y: 6, w: 12, h: 6 },
  { i: 'passages', x: 0, y: 12, w: 12, h: 8 },
  { i: 'production', x: 0, y: 9, w: 7, h: 6 },
  { i: 'gauge', x: 7, y: 9, w: 5, h: 10 },
  { i: 'rejects', x: 0, y: 15, w: 7, h: 5 },
  { i: 'maintenance', x: 7, y: 19, w: 5, h: 10 },
];

// ── Local i18n (machine page has its own language setting) ────────────────────

const I18N = {
  en: {
    running: 'RUNNING', stopped: 'STOPPED', maintenance: 'MAINTENANCE',
    idle: 'IDLE', planned_stop: 'PLANNED STOP', unjustified: 'NOT JUSTIFIED', intervention: 'INTERVENTION',
    newStop: 'NEW STOP', restart: 'RESTART',
    awaitingSignal: 'Awaiting production signal', autoRestart: 'Restarts automatically',
    stopDetected: 'Stop detected — select a reason',
    jobNumber: 'Job Number', noJob: 'No job',
    operator: 'Operator', noOperator: 'No operator',
    selectCategory: 'Select stop reason',
    selectSubcategory: 'Select reason',
    changeCause: 'Change stop cause',
    noSubcategory: 'No sub-reason',
    comment: 'Comment (optional)',
    commentPlaceholder: 'Add a comment...',
    confirmStop: 'CONFIRM STOP',
    confirmReject: 'CONFIRM REJECT',
    removeOne: 'Remove one (correction)',
    quantity: 'Quantity',
    editLayoutBtn: 'Edit layout',
    saveLayoutBtn: 'Save layout',
    resetLayoutBtn: 'Reset',
    enterFullscreen: 'Fullscreen',
    exitFullscreen: 'Exit fullscreen',
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
    piecesProduced: 'Pieces produced',
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
    waitTime: 'Wait',
    viewEvents: 'Events', eventsTitle: 'Events',
    tabStatus: 'Machine status', tabPerformance: 'Performance',
    colStart: 'Start', colDuration: 'Duration', colOperator: 'Operator', colJob: 'Job',
    colCause: 'Stop cause', colComment: 'Comment',
    onlyWithComment: 'Only events with a comment',
    noEvents: 'No events', comingSoon: 'Coming soon',
    editComment: 'Edit comment', ongoingStop: 'Ongoing', save: 'Save',
    changeCauseSelected: 'Change cause ({n})',
  },
  fr: {
    running: 'EN MARCHE', stopped: 'ARRÊTÉE', maintenance: 'MAINTENANCE',
    idle: 'INACTIF', planned_stop: 'ARRÊT PLANIFIÉ', unjustified: 'NON JUSTIFIÉ', intervention: 'EN INTERVENTION',
    newStop: 'NOUVEL ARRÊT', restart: 'REDÉMARRER',
    awaitingSignal: 'En attente du signal de production', autoRestart: 'Redémarrage automatique',
    stopDetected: 'Arrêt détecté — sélectionnez la raison',
    jobNumber: 'N° de job', noJob: 'Aucun job',
    operator: 'Opérateur', noOperator: 'Aucun opérateur',
    selectCategory: 'Sélectionner la raison',
    selectSubcategory: 'Sélectionner la raison',
    changeCause: 'Changer la cause de l\'arrêt',
    noSubcategory: 'Sans sous-raison',
    comment: 'Commentaire (optionnel)',
    commentPlaceholder: 'Ajouter un commentaire...',
    confirmStop: 'CONFIRMER L\'ARRÊT',
    confirmReject: 'CONFIRMER LE REJET',
    removeOne: 'Retirer un (correction)',
    quantity: 'Quantité',
    editLayoutBtn: 'Éditer la disposition',
    saveLayoutBtn: 'Enregistrer',
    resetLayoutBtn: 'Réinitialiser',
    enterFullscreen: 'Plein écran',
    exitFullscreen: 'Quitter le plein écran',
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
    piecesProduced: 'Nombre de passages produits',
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
    waitTime: 'Attente',
    viewEvents: 'Évènements', eventsTitle: 'Évènements',
    tabStatus: 'Statut de la machine', tabPerformance: 'Performance',
    colStart: 'Début', colDuration: 'Durée', colOperator: 'Opérateur', colJob: 'Job',
    colCause: 'Cause d\'arrêt', colComment: 'Commentaire',
    onlyWithComment: 'Seulement les évènements avec commentaire',
    noEvents: 'Aucun évènement', comingSoon: 'Bientôt disponible',
    editComment: 'Modifier le commentaire', ongoingStop: 'En cours', save: 'Enregistrer',
    changeCauseSelected: 'Changer la cause ({n})',
  },
  es: {
    running: 'EN MARCHA', stopped: 'DETENIDA', maintenance: 'MANTENIMIENTO',
    idle: 'INACTIVO', planned_stop: 'PARADA PLANIFICADA', unjustified: 'SIN JUSTIFICAR', intervention: 'EN INTERVENCIÓN',
    newStop: 'NUEVA PARADA', restart: 'REINICIAR',
    awaitingSignal: 'Esperando señal de producción', autoRestart: 'Reinicio automático',
    stopDetected: 'Parada detectada — seleccione una razón',
    jobNumber: 'N° de trabajo', noJob: 'Sin trabajo',
    operator: 'Operador', noOperator: 'Sin operador',
    selectCategory: 'Seleccionar razón',
    selectSubcategory: 'Seleccionar razón',
    changeCause: 'Cambiar causa de la parada',
    noSubcategory: 'Sin sub-razón',
    comment: 'Comentario (opcional)',
    commentPlaceholder: 'Agregar un comentario...',
    confirmStop: 'CONFIRMAR PARADA',
    confirmReject: 'CONFIRMAR RECHAZO',
    removeOne: 'Quitar uno (corrección)',
    quantity: 'Cantidad',
    editLayoutBtn: 'Editar disposición',
    saveLayoutBtn: 'Guardar',
    resetLayoutBtn: 'Restablecer',
    enterFullscreen: 'Pantalla completa',
    exitFullscreen: 'Salir de pantalla completa',
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
    piecesProduced: 'Piezas producidas',
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
    waitTime: 'Espera',
    viewEvents: 'Eventos', eventsTitle: 'Eventos',
    tabStatus: 'Estado de la máquina', tabPerformance: 'Rendimiento',
    colStart: 'Inicio', colDuration: 'Duración', colOperator: 'Operador', colJob: 'Trabajo',
    colCause: 'Causa de parada', colComment: 'Comentario',
    onlyWithComment: 'Solo eventos con comentario',
    noEvents: 'Sin eventos', comingSoon: 'Próximamente',
    editComment: 'Editar comentario', ongoingStop: 'En curso', save: 'Guardar',
    changeCauseSelected: 'Cambiar causa ({n})',
  },
} as const;
export type Lang = keyof typeof I18N;

// Status pill / dot classes — must mirror the canonical palette in utils/statusColors.
const STATUS_COLOR: Record<string, string> = {
  running:      'text-green-400 bg-green-500/15 border-green-500/40',
  planned_stop: 'text-blue-400 bg-blue-500/15 border-blue-500/40',
  stopped:      'text-red-400 bg-red-500/15 border-red-500/40',
  maintenance:  'text-yellow-400 bg-yellow-500/15 border-yellow-500/40',
  intervention: 'text-purple-400 bg-purple-500/15 border-purple-500/40',
  unjustified:  'text-pink-400 bg-pink-500/15 border-pink-500/40',
  idle:         'text-gray-400 bg-gray-500/15 border-gray-500/30',
};
const STATUS_DOT: Record<string, string> = {
  running: 'bg-green-400', planned_stop: 'bg-blue-400', stopped: 'bg-red-400',
  maintenance: 'bg-yellow-400', intervention: 'bg-purple-400', unjustified: 'bg-pink-400', idle: 'bg-gray-500',
};
const STATUS_BG = STATUS_HEX;

// ── Timeline palette (by stop type) ──────────────────────────────────────────
// running = green, planned = blue, unplanned = red, maintenance = yellow,
// MES-detected stop not yet justified (no category) = pink.
const RUNNING_COLOR = '#22c55e';
const UNJUSTIFIED_COLOR = '#ec4899';
const INTERVENTION_COLOR = '#a855f7'; // technician working (purple); maintenance wait stays yellow
const STOP_TYPE_COLORS: Record<string, string> = {
  planned: '#3b82f6', unplanned: '#ef4444', maintenance: '#eab308',
};
export function stopColor(stop: MachineStopOut): string {
  if (!stop.category) return UNJUSTIFIED_COLOR;
  return STOP_TYPE_COLORS[stop.category.type] || stop.category.color || '#6b7280';
}

export const SHIFT_LABELS: Record<string, { en: string; fr: string; es: string }> = {
  morning:   { en: 'Day shift',       fr: 'Quart de jour',  es: 'Turno de día' },
  afternoon: { en: 'Afternoon shift', fr: 'Quart de soir',  es: 'Turno de tarde' },
  night:     { en: 'Night shift',     fr: 'Quart de nuit',  es: 'Turno de nuit' },
  day:       { en: 'Day',             fr: 'Journée',        es: 'Día' },
};

export type ShiftWindow = { key: string; start: Date; end: Date };

// Build the ordered list of concrete shift windows around `ref` (yesterday→tomorrow),
// from the machine's shifts_config ({key:{start:"HH:MM",end:"HH:MM"}}). Overnight shifts
// (end ≤ start) roll past midnight. Falls back to full-day windows when none configured.
export function buildShiftWindows(
  shiftsConfig: Record<string, { start: string; end: string }> | null | undefined,
  ref: Date,
): ShiftWindow[] {
  const defs = Object.entries(shiftsConfig || {})
    .map(([key, c]) => {
      const [sh, sm] = String(c?.start ?? '').split(':').map(Number);
      const [eh, em] = String(c?.end ?? '').split(':').map(Number);
      if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return null;
      return { key, sh, sm, eh, em };
    })
    .filter(Boolean) as { key: string; sh: number; sm: number; eh: number; em: number }[];
  const out: ShiftWindow[] = [];
  for (let d = -1; d <= 1; d++) {
    const base = new Date(ref); base.setHours(0, 0, 0, 0); base.setDate(base.getDate() + d);
    if (!defs.length) {
      const end = new Date(base); end.setDate(end.getDate() + 1);
      out.push({ key: 'day', start: base, end });
      continue;
    }
    for (const def of defs) {
      const start = new Date(base); start.setHours(def.sh, def.sm, 0, 0);
      const end = new Date(base); end.setHours(def.eh, def.em, 0, 0);
      if (end.getTime() <= start.getTime()) end.setDate(end.getDate() + 1);
      out.push({ key: def.key, start, end });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

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
    <svg viewBox="0 0 140 90" className="w-full max-w-[360px] mx-auto block">
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

// Shift-aware machine-stops timeline. The axis is ONE shift window (start→end, from
// the machine's shifts_config); it follows the clock and auto-switches shift. Running
// time is green; stops are colored by type (planned=blue, unplanned=red, maintenance=
// yellow, unjustified MES stop=pink). Supervisor+ can step to past shifts with ◀ ▶.
export function StopTimeline({
  win, stops, nowMs, lang, canNavigate, atCurrent, canGoBack, onPrev, onNext, onSegmentClick, hint,
}: {
  win: ShiftWindow | null;
  stops: MachineStopOut[];
  nowMs: number;
  lang: Lang;
  canNavigate: boolean;
  atCurrent: boolean;
  canGoBack: boolean;
  onPrev: () => void;
  onNext: () => void;
  onSegmentClick?: (stop: MachineStopOut) => void;
  hint?: string;
}) {
  const [tip, setTip] = useState<{ stop: MachineStopOut; x: number; y: number } | null>(null);
  if (!win) return null;
  const startMs = win.start.getTime();
  const endMs = win.end.getTime();
  const span = Math.max(1, endMs - startMs);
  const locale = lang === 'fr' ? 'fr-CA' : lang === 'es' ? 'es-ES' : 'en-CA';
  const pct = (ms: number) => Math.min(100, Math.max(0, ((ms - startMs) / span) * 100));

  const elapsedEnd = atCurrent ? Math.min(endMs, nowMs) : endMs;
  const runningPct = pct(elapsedEnd);
  const nowInWindow = atCurrent && nowMs >= startMs && nowMs <= endMs;

  const spanH = span / 3_600_000;
  const stepH = spanH > 12 ? 3 : 1;
  const ticks: { ms: number; label: string }[] = [];
  const firstTick = new Date(win.start); firstTick.setMinutes(0, 0, 0);
  if (firstTick.getTime() < startMs) firstTick.setHours(firstTick.getHours() + 1);
  for (let tMs = firstTick.getTime(); tMs <= endMs; tMs += stepH * 3_600_000) {
    ticks.push({ ms: tMs, label: new Date(tMs).toTimeString().slice(0, 5) });
  }

  const hm = (d: Date) => d.toTimeString().slice(0, 5);
  const shiftName = (SHIFT_LABELS[win.key] || SHIFT_LABELS.day)[lang] ?? win.key;
  const dateLabel = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(win.start);
  const endHM = hm(win.end);
  const rangeLabel = `${hm(win.start)} – ${endHM === '00:00' ? '24:00' : endHM}`;
  const arrowBtn = 'w-7 h-7 flex items-center justify-center rounded-lg border border-white/10 text-gray-300 hover:bg-white/[0.06] disabled:opacity-30 disabled:cursor-not-allowed';
  const hms = (d: Date) => d.toTimeString().slice(0, 8);
  const tt = I18N[lang];
  // "39min 6sec" / "1h 5min" — drops zero leading parts, mirrors the old vendor's format.
  const fmtDur = (ms: number) => {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    const parts: string[] = [];
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}min`);
    if (s || !parts.length) parts.push(`${s}sec`);
    return parts.join(' ');
  };
  const stopReason = (stop: MachineStopOut) =>
    stop.category
      ? (stop.subcategory ? `${stop.category.name} -> ${stop.subcategory.name}` : stop.category.name)
      : tt.unjustified;

  return (
    <div className="space-y-2 h-full flex flex-col">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold text-white truncate">{shiftName}</p>
          <p className="text-[11px] text-gray-500 truncate">{dateLabel} · {rangeLabel}</p>
        </div>
        {canNavigate && (
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={onPrev} disabled={!canGoBack} className={arrowBtn}><ChevronLeft size={16} /></button>
            <button onClick={onNext} disabled={atCurrent} className={arrowBtn}><ChevronRight size={16} /></button>
          </div>
        )}
      </div>

      <div className="relative flex-1 min-h-[56px] rounded-lg overflow-hidden bg-[#1e293b]">
        <div className="absolute left-0 top-0 h-full" style={{ width: `${runningPct}%`, backgroundColor: RUNNING_COLOR }} />
        {stops.flatMap((stop) => {
          const s = new Date(stop.started_at).getTime();
          const e = stop.ended_at ? new Date(stop.ended_at).getTime() : elapsedEnd;
          const clickable = !!onSegmentClick;
          // A maintenance stop splits into the yellow "wait" (call→technician start)
          // and the purple "intervention" (start→end). Everything else is one segment.
          const ivStart = stop.intervention_started_at ? new Date(stop.intervention_started_at).getTime() : null;
          const isMaint = stop.category?.type === 'maintenance';
          const segs: { a: number; b: number; color: string }[] = [];
          if (isMaint && ivStart && ivStart > s) {
            segs.push({ a: s, b: Math.min(ivStart, e), color: stopColor(stop) });
            if (ivStart < e) segs.push({ a: ivStart, b: e, color: INTERVENTION_COLOR });
          } else if (isMaint && ivStart) {
            segs.push({ a: s, b: e, color: INTERVENTION_COLOR });
          } else {
            segs.push({ a: s, b: e, color: stopColor(stop) });
          }
          return segs.map((sg, idx) => {
            const left = pct(sg.a);
            const width = Math.max(0.6, pct(sg.b) - left);
            return (
              <div
                key={`${stop.id}-${idx}`}
                onClick={clickable ? () => onSegmentClick!(stop) : undefined}
                onMouseEnter={(ev) => setTip({ stop, x: ev.clientX, y: ev.clientY })}
                onMouseMove={(ev) => setTip({ stop, x: ev.clientX, y: ev.clientY })}
                onMouseLeave={() => setTip(null)}
                className={`absolute top-0 h-full transition-[filter] ${clickable ? 'cursor-pointer hover:brightness-125 hover:ring-2 hover:ring-white hover:z-10' : ''}`}
                style={{ left: `${left}%`, width: `${width}%`, backgroundColor: sg.color }}
              />
            );
          });
        })}
        {nowInWindow && (
          <div className="absolute top-0 h-full w-0.5 bg-white/80" style={{ left: `${pct(nowMs)}%` }} />
        )}
      </div>

      <div className="relative h-3">
        {ticks.map((tk, i) => (
          <span key={i} className="absolute top-0 text-[9px] text-gray-500 font-mono select-none" style={{ left: `${pct(tk.ms)}%`, transform: 'translateX(-50%)' }}>
            {tk.label}
          </span>
        ))}
      </div>

      {tip && (() => {
        const s = new Date(tip.stop.started_at);
        const e = tip.stop.ended_at ? new Date(tip.stop.ended_at) : new Date(Math.min(endMs, nowMs));
        const W = 240;
        const left = tip.x + 16 + W > window.innerWidth ? tip.x - 16 - W : tip.x + 16;
        const top = Math.min(tip.y + 16, window.innerHeight - 160);
        // Rendered via a portal to <body> so the fixed tooltip escapes the
        // react-grid-layout panel's CSS transform (a transformed ancestor becomes
        // the containing block for `fixed`, which pushed the card down & behind).
        return createPortal(
          <div
            className="fixed z-[9999] pointer-events-none rounded-lg border border-white/10 bg-[#2b2f36]/95 px-3 py-2 text-xs text-gray-200 shadow-xl backdrop-blur-sm"
            style={{ left, top, minWidth: W, maxWidth: W }}
          >
            <div className="text-[11px] text-gray-400">{hms(s)} - {tip.stop.ended_at ? hms(e) : '…'}</div>
            <div className="mb-1.5 font-bold text-white">{stopReason(tip.stop)}</div>
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <Clock size={13} className="shrink-0 text-gray-400" />
                <span>{fmtDur(e.getTime() - s.getTime())}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <User size={13} className="shrink-0 text-gray-400" />
                <span className="truncate">{tip.stop.operator_name || tt.noOperator}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Cog size={13} className="shrink-0 text-gray-400" />
                <span className="truncate">{tip.stop.job_number || tt.noJob}</span>
              </div>
              {tip.stop.wait_minutes != null && (
                <div className="flex items-center gap-1.5 text-yellow-400">
                  <AlertTriangle size={13} className="shrink-0" />
                  <span>{tt.waitTime}: {Math.round(tip.stop.wait_minutes)} {tt.min}</span>
                </div>
              )}
            </div>
            {onSegmentClick && hint && (
              <div className="mt-1.5 border-t border-white/10 pt-1.5 text-[10px] text-gray-400">{hint}</div>
            )}
          </div>,
          document.body,
        );
      })()}
    </div>
  );
}

// Pieces-produced-per-hour bar chart for ONE shift window — mirrors the old vendor's
// "Nombre de passages produits" view. Shares the shift window + ◀ ▶ nav with the timeline.
export function ProductionChart({
  win, hours, nowMs, lang, title, canNavigate, atCurrent, canGoBack, onPrev, onNext,
}: {
  win: ShiftWindow | null;
  hours: HourlyPoint[];
  nowMs: number;
  lang: Lang;
  title: string;
  canNavigate: boolean;
  atCurrent: boolean;
  canGoBack: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (!win) return null;
  const locale = lang === 'fr' ? 'fr-CA' : lang === 'es' ? 'es-ES' : 'en-CA';
  const hm = (d: Date) => d.toTimeString().slice(0, 5);
  const shiftName = (SHIFT_LABELS[win.key] || SHIFT_LABELS.day)[lang] ?? win.key;
  const dateLabel = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(win.start);
  const endHM = hm(win.end);
  const rangeLabel = `${hm(win.start)} – ${endHM === '00:00' ? '24:00' : endHM}`;
  const arrowBtn = 'w-7 h-7 flex items-center justify-center rounded-lg border border-white/10 text-gray-300 hover:bg-white/[0.06] disabled:opacity-30 disabled:cursor-not-allowed';
  const max = Math.max(1, ...hours.map((h) => h.pieces));
  const isCurrentHour = (iso: string) => {
    if (!atCurrent) return false;
    const s = new Date(iso).getTime();
    return nowMs >= s && nowMs < s + 3_600_000;
  };
  return (
    <div className="space-y-2 h-full flex flex-col">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold text-white truncate">{title}</p>
          <p className="text-[11px] text-gray-500 truncate">{shiftName} · {dateLabel} · {rangeLabel}</p>
        </div>
        {canNavigate && (
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={onPrev} disabled={!canGoBack} className={arrowBtn}><ChevronLeft size={16} /></button>
            <button onClick={onNext} disabled={atCurrent} className={arrowBtn}><ChevronRight size={16} /></button>
          </div>
        )}
      </div>
      <div className="flex-1 min-h-[110px] flex items-end gap-1">
        {hours.map((h) => {
          const cur = isCurrentHour(h.hour);
          return (
            <div key={h.hour} className="flex-1 flex flex-col items-center justify-end h-full gap-1">
              <span className={`text-[10px] font-bold ${cur ? 'text-blue-300' : 'text-gray-400'}`}>{h.pieces || ''}</span>
              <div className="w-full rounded-t transition-all"
                style={{ height: `${Math.max(2, (h.pieces / max) * 100)}%`, background: cur ? '#3b82f6' : '#64748b' }} />
              <span className="text-[9px] text-gray-500 font-mono">{hm(new Date(h.hour))}</span>
            </div>
          );
        })}
        {hours.length === 0 && <p className="text-xs text-gray-600 m-auto">—</p>}
      </div>
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
  const [timelineStops, setTimelineStops] = useState<MachineStopOut[]>([]);
  const [hourly, setHourly] = useState<HourlyPoint[]>([]);
  const [shiftOffset, setShiftOffset] = useState(0); // 0 = current shift; negative = past (supervisor nav)
  const [operators, setOps]   = useState<MachineOperatorOut[]>([]);
  const [categories, setCats] = useState<StopCategoryOut[]>([]);
  const [rejectCats, setRejectCats] = useState<RejectCategoryOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  // Live updates: the /api/live WS signals when this machine changes and the
  // fetch effects below re-run instantly; their intervals are a slow fallback.
  const [liveTick, setLiveTick] = useState(0);
  useMachineLive([slug, machine?.id, machine?.code, machine?.page_slug],
    () => setLiveTick((n) => n + 1));

  // Reject modal
  const [showRejectModal, setShowRejectModal]     = useState(false);
  const [rejectStep, setRejectStep]               = useState<RejectStep>('categories');
  const [selectedRejectCat, setSelectedRejectCat] = useState<RejectCategoryOut | null>(null);
  const [selectedRejectSub, setSelectedRejectSub] = useState<RejectSubcategoryOut | null>(null);
  const [rejectQty, setRejectQty]                 = useState(1);
  const [rejectComment, setRejectComment]         = useState('');
  const [rejectBusy, setRejectBusy]               = useState(false);
  const [rejectAdjustBusy, setRejectAdjustBusy]   = useState(false);

  const [jobInput, setJobInput]       = useState('');
  const [showOpList, setShowOpList]   = useState(false);
  const [confirmedTicket, setConfirmedTicket] = useState<string | null>(null);

  // Kiosk layout editor (supervisor+): drag/resize panels, saved per machine
  const canEditLayout = useRole('supervisor', 'plant_manager', 'director', 'admin');
  const [editLayout, setEditLayout] = useState(false);
  const [layout, setLayout] = useState<Layout[]>(DEFAULT_KIOSK_LAYOUT);

  // Fullscreen (kiosk on a tablet — maximize the operator's usable space by hiding
  // the browser chrome). Uses the Fullscreen API with a webkit fallback for iPad Safari.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const doc = document as Document & { webkitFullscreenElement?: Element };
    const onChange = () => setIsFullscreen(!!(document.fullscreenElement || doc.webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);
  const toggleFullscreen = useCallback(() => {
    const doc = document as Document & {
      webkitFullscreenElement?: Element;
      webkitExitFullscreen?: () => Promise<void>;
    };
    const el = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void>;
    };
    const active = !!(document.fullscreenElement || doc.webkitFullscreenElement);
    if (active) {
      (document.exitFullscreen?.bind(document) || doc.webkitExitFullscreen?.bind(doc))?.();
    } else {
      (el.requestFullscreen?.bind(el) || el.webkitRequestFullscreen?.bind(el))?.();
    }
  }, []);

  // Stop modal state
  const [showModal, setShowModal]           = useState(false);
  const [modalStep, setModalStep]           = useState<ModalStep>('categories');
  const [selectedCat, setSelectedCat]       = useState<StopCategoryOut | null>(null);
  const [selectedSub, setSelectedSub]       = useState<StopSubcategoryOut | null>(null);
  const [stopComment, setStopComment]       = useState('');
  const [currentStopId, setCurrentStopId]   = useState<string | null>(null);
  const [modalBusy, setModalBusy]           = useState(false);
  const [stopTime, setStopTime]             = useState<string>('');

  // Reclassify-stop modal — click a stop on the timeline to change its cause.
  // A stop never becomes "running" here (anti-cheat); maintenance only relabels (no ticket).
  const [reclassTarget, setReclassTarget] = useState<MachineStopOut | null>(null);
  const [reclassCat, setReclassCat]       = useState<StopCategoryOut | null>(null);
  const [reclassBusy, setReclassBusy]     = useState(false);
  const [showEvents, setShowEvents]       = useState(false);
  const [rejectLogs, setRejectLogs]       = useState<RejectLogItem[]>([]);
  const [bulkStops, setBulkStops]         = useState<MachineStopOut[] | null>(null);
  const [selResetKey, setSelResetKey]     = useState(0);

  // Ticket close state
  const [closingTicketId, setClosingTicketId] = useState<string | null>(null);
  const [diagnosis, setDiagnosis]             = useState('');
  const [corrective, setCorrective]           = useState('');
  const [intMins, setIntMins]                 = useState('');
  const [techBusy, setTechBusy]               = useState(false);

  // Follow the user's selected UI language (header switcher / i18next), falling
  // back to the machine's own page_language, then French.
  const { i18n } = useTranslation();
  const uiLang = (i18n.language || '').slice(0, 2);
  const lang: Lang = ((['en', 'fr', 'es'].includes(uiLang) ? uiLang : (machine?.page_language as Lang)) || 'fr') as Lang;
  const t = I18N[lang] || I18N.fr;
  const accentColor = machine?.custom_color || STATUS_BG[machine?.current_status || 'running'] || '#3b82f6';

  const isRunning = machine?.current_status === 'running';
  const statusSince = isRunning ? machine?.last_start_at : machine?.last_stop_at;
  const timerStr = useTimer(statusSince);

  // ── Shift-aware timeline window ────────────────────────────────────────────
  // Re-derived each render (useTimer re-renders every 1s → the "now" marker moves
  // and the window auto-advances when a shift boundary is crossed).
  const nowMs = Date.now();
  const shiftWins = buildShiftWindows(machine?.shifts_config, new Date(nowMs));
  let curIdx = shiftWins.findIndex((w) => nowMs >= w.start.getTime() && nowMs < w.end.getTime());
  if (curIdx < 0) {
    for (let i = shiftWins.length - 1; i >= 0; i--) {
      if (shiftWins[i].start.getTime() <= nowMs) { curIdx = i; break; }
    }
    if (curIdx < 0) curIdx = 0;
  }
  // Operators can't navigate; supervisors step backward only (no future shifts).
  const offset = canEditLayout ? Math.min(0, Math.max(shiftOffset, -curIdx)) : 0;
  const displayIdx = curIdx + offset;
  const displayWin = shiftWins[displayIdx] ?? null;
  const winStartISO = displayWin?.start.toISOString();
  const winEndISO = displayWin?.end.toISOString();

  // Fetch the displayed window's stops (live WS push; slow fallback interval).
  useEffect(() => {
    if (!slug || !winStartISO || !winEndISO) return;
    let active = true;
    const loadWin = () =>
      fetchTodayStops(slug, { start: winStartISO, end: winEndISO })
        .then((s) => { if (active) setTimelineStops(s); })
        .catch(() => {});
    loadWin();
    const id = setInterval(loadWin, 60_000);
    return () => { active = false; clearInterval(id); };
  }, [slug, winStartISO, winEndISO, liveTick]);

  // Pieces-per-hour for the displayed shift window (live WS push; slow fallback).
  useEffect(() => {
    if (!slug || !winStartISO || !winEndISO) return;
    let active = true;
    const load = () =>
      fetchProductionHourly(slug, { start: winStartISO, end: winEndISO })
        .then((r) => { if (active) setHourly(r.hours); })
        .catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => { active = false; clearInterval(id); };
  }, [slug, winStartISO, winEndISO, liveTick]);

  const doReclassify = async (catId: string | null, subId?: string | null) => {
    // Single stop (timeline / cause cell) or a bulk selection from the events table.
    const targets = reclassTarget ? [reclassTarget] : (bulkStops || []);
    if (!slug || targets.length === 0) return;
    setReclassBusy(true);
    try {
      for (const st of targets) {
        await reclassifyStop(slug, st.id, { stop_category_id: catId, stop_subcategory_id: subId ?? null });
      }
      setReclassTarget(null);
      setReclassCat(null);
      if (bulkStops) { setBulkStops(null); setSelResetKey((k) => k + 1); }
      if (winStartISO && winEndISO) {
        fetchTodayStops(slug, { start: winStartISO, end: winEndISO }).then(setTimelineStops).catch(() => {});
      }
      fetchMachinePage(slug).then(setMachine).catch(() => {});
    } finally {
      setReclassBusy(false);
    }
  };

  // Save/edit a stop's comment from the events table. Pass the current cause so
  // the reclassify endpoint (which overwrites category) doesn't clear it.
  const saveStopComment = async (stop: MachineStopOut, comment: string) => {
    if (!slug) return;
    await reclassifyStop(slug, stop.id, {
      stop_category_id: stop.category?.id ?? null,
      stop_subcategory_id: stop.subcategory?.id ?? null,
      comments: comment,
    });
    if (winStartISO && winEndISO) {
      fetchTodayStops(slug, { start: winStartISO, end: winEndISO }).then(setTimelineStops).catch(() => {});
    }
  };

  // Load reject events when the events modal opens (read-only tab).
  useEffect(() => {
    if (!showEvents || !slug) return;
    fetchTodayRejects(slug).then((r) => setRejectLogs(r.logs || [])).catch(() => {});
  }, [showEvents, slug, liveTick]);

  // Apply the machine's saved panel layout once it loads
  useEffect(() => {
    const saved = machine?.kiosk_layout;
    if (Array.isArray(saved) && saved.length) setLayout(saved as Layout[]);
  }, [machine?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveLayout = useCallback(async (next: Layout[]) => {
    if (!machine) return;
    const clean = next.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
    try { await api.patch(`/api/machines/${machine.id}`, { kiosk_layout: clean }); } catch { /* ignore */ }
  }, [machine]);

  const load = useCallback((silent = false) => {
    if (!slug) return;
    if (!silent) setLoading(true);   // background refreshes stay silent — no full-page loader flash
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

  useEffect(() => { load(); }, [load]);

  // Silent refresh (no loader flash): instantly on a live WS event for this
  // machine, plus a slow fallback interval in case the socket drops.
  useEffect(() => {
    if (liveTick) load(true);
  }, [liveTick, load]);
  useEffect(() => {
    const id = setInterval(() => load(true), 60_000);
    return () => clearInterval(id);
  }, [load]);

  // Auto-open the "stop detected" prompt when the machine turns pink (unjustified)
  // from the production signal — the operator justifies the detected open stop.
  // Fires once per detected stop; resets when the machine is running again.
  const autoPromptedStopId = useRef<string | null>(null);
  useEffect(() => {
    if (machine?.current_status === 'running') { autoPromptedStopId.current = null; return; }
    if (machine?.current_status !== 'unjustified') return;
    if (reclassTarget || bulkStops || showModal) return;
    const detected = [...timelineStops, ...stops].find((s) => !s.ended_at && !s.category);
    if (detected && autoPromptedStopId.current !== detected.id) {
      autoPromptedStopId.current = detected.id;
      setReclassCat(null);
      setReclassTarget(detected);
    }
  }, [machine?.current_status, timelineStops, stops, reclassTarget, bulkStops, showModal]);

  const openStopModal = () => {
    setStopTime(new Date().toTimeString().slice(0, 8));
    setSelectedCat(null); setSelectedSub(null); setStopComment('');
    setModalStep('categories');
    setShowModal(true);
  };

  const handleCategorySelect = async (cat: StopCategoryOut) => {
    setSelectedCat(cat);
    setSelectedSub(null);
    // Any category with subcategories shows the sub-reason step first (planned included),
    // so the chosen sub-reason is recorded. Only categories with NO subcategories skip
    // straight to the confirm step.
    if (cat.subcategories && cat.subcategories.length > 0) {
      setModalStep('subcategories');
    } else if (cat.type === 'maintenance') {
      setModalStep('confirm-maintenance');
    } else {
      setModalStep('confirm-unplanned');
    }
  };

  const handleSubcategorySelect = (sub: StopSubcategoryOut) => {
    setSelectedSub(sub);
    if (selectedCat?.type === 'maintenance' || sub.triggers_maintenance) {
      setModalStep('confirm-maintenance');
    } else {
      setModalStep('confirm-unplanned');
    }
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
        // "Chamar manutenção" is a stop reason: the stop already opened a ticket; now
        // create the "waiting for mechanic" intervention (adopts that ticket) so the
        // embedded MaintenancePanel drives the mechanic flow on this same kiosk.
        try { await callMaintenance(machine.id, stopComment || undefined); } catch { /* non-blocking */ }
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
    if (!slug || rejectQty < 1) return;
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

  // Correction: undo an accidental reject (backend clamps at 0).
  const removeOneReject = async () => {
    if (!slug || rejectAdjustBusy || (mes?.reject_count ?? 0) <= 0) return;
    setRejectAdjustBusy(true);
    try {
      const res = await addRejects(slug, -1);
      setMes((prev) => prev ? { ...prev, reject_count: res.reject_count } : prev);
    } finally {
      setRejectAdjustBusy(false);
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
  const frameColor = statusColor(status); // kiosk frame follows machine status
  const openTickets = machine.open_tickets ?? [];
  const todayStopCount = stops.length;

  // Production KPI colors — green output, blue target, OEE by band, amber downtime.
  const oeePct = mes?.oee_pct ?? 0;
  const oeeColor = oeePct >= 85 ? 'text-emerald-400' : oeePct >= 50 ? 'text-amber-400' : 'text-rose-400';

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white flex flex-col" style={machine.custom_color ? { '--accent': machine.custom_color } as any : {}}>

      {/* Status frame around the whole kiosk — color follows machine status
          (green=running, blue=planned, red=unplanned, yellow=maintenance, pink=unjustified). */}
      <div
        className="pointer-events-none fixed inset-0 z-[55] transition-colors duration-500"
        style={{ boxShadow: `inset 0 0 0 7px ${frameColor}` }}
      />

      {/* Edit-mode affordances for the draggable/resizable kiosk grid */}
      <style>{`
        .kiosk-grid.editing .react-grid-item { outline: 2px dashed rgba(96,165,250,0.6); outline-offset: -2px; border-radius: 1rem; }
        .kiosk-grid.editing .react-grid-item > div:last-child { padding-top: 2.25rem; }
        .kiosk-grid .react-resizable-handle { z-index: 50; touch-action: none; }
        .kiosk-grid.editing .react-resizable-handle-se { width: 26px; height: 26px; background-image: none; border-right: 4px solid rgba(96,165,250,0.95); border-bottom: 4px solid rgba(96,165,250,0.95); border-bottom-right-radius: 6px; }
        .kiosk-grid.editing .react-resizable-handle-e { width: 12px; background-image: none; border-right: 4px solid rgba(96,165,250,0.7); }
        .kiosk-grid.editing .react-resizable-handle-s { height: 12px; background-image: none; border-bottom: 4px solid rgba(96,165,250,0.7); }
        .kiosk-grid .react-grid-placeholder { background: rgba(59,130,246,0.35); border-radius: 1rem; }
      `}</style>

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

      {/* ── Top toolbar: fullscreen (everyone) + layout editor (supervisor+) ── */}
      <div className="flex items-center justify-end gap-2 px-4 pt-3">
        <button
          onClick={toggleFullscreen}
          title={isFullscreen ? t.exitFullscreen : t.enterFullscreen}
          aria-label={isFullscreen ? t.exitFullscreen : t.enterFullscreen}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-semibold text-gray-300 border border-white/10 hover:bg-white/[0.05]"
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          <span className="hidden sm:inline">{isFullscreen ? t.exitFullscreen : t.enterFullscreen}</span>
        </button>
        {canEditLayout && (editLayout ? (
          <>
            <button
              onClick={() => setLayout(DEFAULT_KIOSK_LAYOUT)}
              className="px-3 py-1.5 rounded-lg text-sm font-semibold text-gray-300 border border-white/10 hover:bg-white/[0.05]"
            >{t.resetLayoutBtn}</button>
            <button
              onClick={() => { saveLayout(layout); setEditLayout(false); }}
              className="px-4 py-1.5 rounded-lg text-sm font-bold text-white bg-blue-600 hover:bg-blue-500"
            >{t.saveLayoutBtn}</button>
          </>
        ) : (
          <button
            onClick={() => setEditLayout(true)}
            className="px-3 py-1.5 rounded-lg text-sm font-semibold text-blue-300 border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20"
          >{t.editLayoutBtn}</button>
        ))}
      </div>

      {/* ── Editable kiosk panels (drag/resize when editing) ── */}
      <RGL
        className={`kiosk-grid${editLayout ? ' editing' : ''}`}
        layout={layout}
        cols={12}
        rowHeight={28}
        margin={[16, 16]}
        containerPadding={[16, 16]}
        isDraggable={editLayout}
        isResizable={editLayout}
        isBounded
        draggableHandle=".kiosk-drag"
        compactType="vertical"
        resizeHandles={['se', 'e', 's']}
        onLayoutChange={(l) => { if (editLayout) setLayout(l); }}
      >

        {/* Panel — Status + Timer + Operator */}
        <div key="status" className="h-full relative">
          {editLayout && <div className="kiosk-drag absolute top-0 left-0 right-0 h-8 z-40 cursor-move select-none touch-none flex items-center justify-center gap-2 rounded-t-2xl text-xs font-bold uppercase tracking-wider text-white bg-blue-500/80 hover:bg-blue-500">⠿ {statusLabel}</div>}
          <div className="h-full overflow-auto bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5 flex flex-col gap-3">
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
              <p className="text-sm font-mono text-gray-400">{machine.code}</p>
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

            <p className="text-sm text-gray-400">
              {todayStopCount} {t.stopCount}
            </p>
          </div>
          </div>
        </div>

        {/* Panel — Job number (if enabled) */}
        {machine.show_job_number && (
          <div key="job" className="h-full relative">
            {editLayout && <div className="kiosk-drag absolute top-0 left-0 right-0 h-8 z-40 cursor-move select-none touch-none flex items-center justify-center gap-2 rounded-t-2xl text-xs font-bold uppercase tracking-wider text-white bg-blue-500/80 hover:bg-blue-500">⠿ {t.jobNumber}</div>}
            <div className="h-full overflow-auto bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5 flex flex-col justify-between">
            <p className="text-sm font-semibold text-gray-400 uppercase tracking-widest">{t.jobNumber}</p>
            <div>
              <p className="text-3xl font-bold text-white mb-4">
                {machine.current_job_number || <span className="text-gray-500">{t.noJob}</span>}
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
        </div>
        )}

        {/* Panel — STOP / RESTART */}
        <div key="stop" className="h-full relative">
          {editLayout && <div className="kiosk-drag absolute top-0 left-0 right-0 h-8 z-40 cursor-move select-none touch-none flex items-center justify-center gap-2 rounded-t-2xl text-xs font-bold uppercase tracking-wider text-white bg-blue-500/80 hover:bg-blue-500">⠿ {t.newStop}</div>}
          <div className="h-full overflow-auto bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5 flex flex-col items-center justify-center gap-4">
          {machine?.signal_driven ? (
            isRunning ? (
              // Signal-driven & producing: stops are auto-detected — no manual stop
              // button. Passive "in production" indicator only.
              <div className="w-36 h-36 rounded-full border-4 border-green-500/40 bg-green-500/10 text-green-400 flex flex-col items-center justify-center gap-1 text-center px-3 cursor-default">
                <span className="text-4xl">✓</span>
                <span className="text-sm font-black tracking-wider">{t.running}</span>
                <span className="text-[10px] text-green-500/70 leading-tight">{t.autoRestart}</span>
              </div>
            ) : (
              // Signal-driven & stopped: add a NEW stop with its own reason (does
              // not reclassify the current one). create_stop closes the open stop.
              <button
                onClick={openStopModal}
                className="w-36 h-36 rounded-full border-4 border-red-500/60 bg-red-500/15 hover:bg-red-500/25 text-red-400 flex flex-col items-center justify-center gap-1 transition-all active:scale-95 shadow-2xl shadow-red-500/10"
              >
                <span className="text-4xl">⏹</span>
                <span className="text-sm font-black tracking-wider">{t.newStop}</span>
              </button>
            )
          ) : isRunning ? (
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

        {/* Panel — Timeline */}
        <div key="timeline" className="h-full relative">
          {editLayout && <div className="kiosk-drag absolute top-0 left-0 right-0 h-8 z-40 cursor-move select-none touch-none flex items-center justify-center gap-2 rounded-t-2xl text-xs font-bold uppercase tracking-wider text-white bg-blue-500/80 hover:bg-blue-500">⠿ {t.todayTimeline}</div>}
          <div className="h-full flex flex-col overflow-hidden bg-[#0d1421] rounded-2xl border border-white/[0.06] p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-gray-400 uppercase tracking-widest font-semibold">{t.todayTimeline}</p>
              {!editLayout && (
                <button
                  onClick={() => setShowEvents(true)}
                  title={t.viewEvents}
                  className="relative flex items-center justify-center w-8 h-8 rounded-lg text-gray-400 hover:text-white hover:bg-white/[0.06] transition-colors"
                >
                  <MessageSquare size={16} />
                  {timelineStops.length > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-blue-500 text-white text-[10px] font-bold flex items-center justify-center">
                      {timelineStops.length}
                    </span>
                  )}
                </button>
              )}
            </div>
            <div className="flex-1 min-h-0">
            <StopTimeline
              win={displayWin}
              stops={timelineStops}
              nowMs={nowMs}
              lang={lang}
              canNavigate={canEditLayout}
              atCurrent={offset === 0}
              canGoBack={displayIdx > 0}
              onPrev={() => setShiftOffset((o) => o - 1)}
              onNext={() => setShiftOffset((o) => Math.min(0, o + 1))}
              onSegmentClick={editLayout ? undefined : (stop) => { setReclassTarget(stop); setReclassCat(null); }}
              hint={t.changeCause}
            />
            </div>
          </div>
        </div>

        {/* Panel — Pieces produced per hour */}
        <div key="passages" className="h-full relative">
          {editLayout && <div className="kiosk-drag absolute top-0 left-0 right-0 h-8 z-40 cursor-move select-none touch-none flex items-center justify-center gap-2 rounded-t-2xl text-xs font-bold uppercase tracking-wider text-white bg-blue-500/80 hover:bg-blue-500">⠿ {t.piecesProduced}</div>}
          <div className="h-full overflow-auto bg-[#0d1421] rounded-2xl border border-white/[0.06] p-4">
            <ProductionChart
              win={displayWin}
              hours={hourly}
              nowMs={nowMs}
              lang={lang}
              title={t.piecesProduced}
              canNavigate={canEditLayout}
              atCurrent={offset === 0}
              canGoBack={displayIdx > 0}
              onPrev={() => setShiftOffset((o) => o - 1)}
              onNext={() => setShiftOffset((o) => Math.min(0, o + 1))}
            />
          </div>
        </div>

        {/* Panel — Production (mock) */}
        {machine.show_production_panel && (
          <div key="production" className="h-full relative">
            {editLayout && <div className="kiosk-drag absolute top-0 left-0 right-0 h-8 z-40 cursor-move select-none touch-none flex items-center justify-center gap-2 rounded-t-2xl text-xs font-bold uppercase tracking-wider text-white bg-blue-500/80 hover:bg-blue-500">⠿ {t.production}</div>}
            <div className="h-full overflow-auto bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5 relative overflow-hidden">
            <p className="text-xs text-gray-400 uppercase tracking-widest mb-2 font-semibold">{t.production}</p>
            <div className="flex gap-8">
              <div>
                <p className={`text-4xl font-black ${mes?.is_placeholder ? 'text-gray-600' : 'text-emerald-400'}`}>{mes?.is_placeholder ? '—' : mes?.production_count ?? 0}</p>
                <p className="text-xs text-gray-500 mt-1">{t.production}</p>
              </div>
              <div>
                <p className={`text-4xl font-black ${mes?.is_placeholder ? 'text-gray-600' : 'text-sky-400'}`}>{mes?.is_placeholder ? '—' : (machine.target_count ?? mes?.target ?? 0)}</p>
                <p className="text-xs text-gray-500 mt-1">{t.target}</p>
              </div>
              <div>
                <p className={`text-4xl font-black ${mes?.is_placeholder ? 'text-gray-600' : oeeColor}`}>{mes?.is_placeholder ? '—' : `${mes?.oee_pct ?? 0}%`}</p>
                <p className="text-xs text-gray-500 mt-1">{t.oee}</p>
              </div>
              <div>
                <p className={`text-4xl font-black ${mes?.is_placeholder ? 'text-gray-600' : (mes?.downtime_today_minutes ?? 0) > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>{mes?.downtime_today_minutes ?? 0}</p>
                <p className="text-xs text-gray-500 mt-1">{t.downtime} ({t.min})</p>
              </div>
            </div>
            {mes?.is_placeholder && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#0d1421]/60 backdrop-blur-sm rounded-2xl">
                <span className="text-xs text-gray-700 font-mono border border-gray-800 px-3 py-1.5 rounded-full">{t.mesComingSoon}</span>
              </div>
            )}
            </div>
          </div>
        )}

        {/* Panel — Availability gauge */}
        {machine.show_availability_gauge && (
          <div key="gauge" className="h-full relative">
            {editLayout && <div className="kiosk-drag absolute top-0 left-0 right-0 h-8 z-40 cursor-move select-none touch-none flex items-center justify-center gap-2 rounded-t-2xl text-xs font-bold uppercase tracking-wider text-white bg-blue-500/80 hover:bg-blue-500">⠿ {t.availability}</div>}
            <div className="h-full overflow-auto bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5">
            <p className="text-xs text-gray-400 uppercase tracking-widest mb-1 font-semibold">{t.availability}</p>
            <AvailabilityGauge
              pct={mes?.availability_pct ?? 0}
              target={machine.target_availability_pct ?? 70}
              color={accentColor}
            />
            </div>
          </div>
        )}

        {/* Panel — Reject count */}
        {machine.show_reject_panel && (
          <div key="rejects" className="h-full relative">
            {editLayout && <div className="kiosk-drag absolute top-0 left-0 right-0 h-8 z-40 cursor-move select-none touch-none flex items-center justify-center gap-2 rounded-t-2xl text-xs font-bold uppercase tracking-wider text-white bg-blue-500/80 hover:bg-blue-500">⠿ {t.rejects}</div>}
            <div className="h-full overflow-auto bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-widest mb-1 font-semibold">{t.rejects}</p>
              <p className="text-6xl font-black text-red-400">{mes?.reject_count ?? 0}</p>
            </div>
            <div className="flex flex-col gap-3">
              <button
                onClick={openRejectModal}
                className="w-16 h-16 rounded-full bg-red-600/20 hover:bg-red-600/30 border-2 border-red-500/40 text-red-400 text-3xl font-black transition-all active:scale-90"
              >+1</button>
              <button
                onClick={removeOneReject}
                disabled={rejectAdjustBusy || (mes?.reject_count ?? 0) <= 0}
                title={t.removeOne} aria-label={t.removeOne}
                className="w-16 h-11 rounded-full bg-white/[0.04] hover:bg-white/[0.08] border-2 border-white/15 text-gray-300 text-2xl font-black transition-all active:scale-90 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center"
              >−1</button>
            </div>
            </div>
          </div>
        )}

        {/* Panel — Active maintenance (full mechanic intervention flow) */}
        <div key="maintenance" className="h-full relative">
          {editLayout && <div className="kiosk-drag absolute top-0 left-0 right-0 h-8 z-40 cursor-move select-none touch-none flex items-center justify-center gap-2 rounded-t-2xl text-xs font-bold uppercase tracking-wider text-white bg-blue-500/80 hover:bg-blue-500">⠿ Maintenance</div>}
          <div className="h-full overflow-auto bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5">
            <MaintenancePanel machineId={machine.id} embedded />
            {false && (
              <div className="space-y-2">
                <p className="text-xs text-gray-400 uppercase tracking-widest font-semibold mb-2">{t.activeTickets}</p>
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
      </RGL>

      {/* ── Reject Category Modal ── */}
      {showRejectModal && (
        <div className="fixed inset-0 z-50 bg-black/90 flex flex-col">
          <div className="flex items-center justify-between px-8 py-6 border-b border-white/[0.06]">
            <div>
              <h2 className="text-2xl font-black text-white">{t.rejects}</h2>
              <p className="text-gray-400 text-base mt-1">{machine?.display_name || machine?.name}</p>
            </div>
            {rejectStep !== 'categories' && rejectCats.length > 0 && (
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
                  <label className="block text-sm text-gray-500 uppercase tracking-wide mb-2">{t.quantity}</label>
                  <div className="flex items-center gap-4 justify-center">
                    <button onClick={() => setRejectQty((q) => Math.max(1, q - 1))}
                      className="w-14 h-14 rounded-full bg-gray-700 hover:bg-gray-600 text-white text-2xl font-black transition-all active:scale-90">−</button>
                    <input
                      type="number" min={1} inputMode="numeric" value={rejectQty}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        setRejectQty(Number.isNaN(v) ? 1 : Math.max(1, v));
                      }}
                      className="text-6xl font-black text-white w-40 text-center bg-transparent border-b-2 border-white/15 focus:border-red-500 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
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
                  {rejectBusy ? '...' : `${t.confirmReject} — ${rejectQty}`}
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

      {/* ── Reclassify-stop modal — click a timeline segment to change its cause.
          Only the cause changes; a stop is never turned back into running time. ── */}
      {showEvents && (
        <EventsModal
          t={t}
          stops={timelineStops}
          rejects={rejectLogs}
          resetKey={selResetKey}
          onClose={() => setShowEvents(false)}
          onEditCause={(stop) => { setReclassTarget(stop); setBulkStops(null); setReclassCat(null); }}
          onBulkEditCause={(stopsSel) => { setBulkStops(stopsSel); setReclassTarget(null); setReclassCat(null); }}
          onSaveComment={saveStopComment}
        />
      )}

      {(reclassTarget || bulkStops) && (
        <div className="fixed inset-0 z-50 bg-black/90 flex flex-col">
          <div className="flex items-center justify-between px-8 py-6 border-b border-white/[0.06]">
            <div>
              <h2 className="text-2xl font-black text-white">
                {reclassTarget && !reclassTarget.ended_at && !reclassTarget.category ? t.stopDetected : t.changeCause}
              </h2>
              <p className="text-gray-400 text-base mt-1">
                {reclassTarget ? (
                  `${new Date(reclassTarget.started_at).toTimeString().slice(0, 5)}–${reclassTarget.ended_at ? new Date(reclassTarget.ended_at).toTimeString().slice(0, 5) : '…'}${reclassTarget.category?.name ? ` · ${reclassTarget.category.name}` : ''}`
                ) : (
                  t.changeCauseSelected.replace('{n}', String(bulkStops?.length ?? 0))
                )}
              </p>
            </div>
            {reclassCat && (
              <button onClick={() => setReclassCat(null)} className="flex items-center gap-2 text-gray-400 hover:text-white text-base font-medium">
                <ChevronLeft size={20} /> {t.backToMachines}
              </button>
            )}
            <button onClick={() => { setReclassTarget(null); setBulkStops(null); setReclassCat(null); }}>
              <X size={28} className="text-gray-600 hover:text-gray-300" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-8 py-8">
            {!reclassCat && (
              <div className="space-y-6">
                <p className="text-xl text-gray-400 font-semibold">{t.selectCategory}</p>
                <div className="flex flex-wrap gap-6 justify-center">
                  {categories.map((cat) => (
                    <button
                      key={cat.id}
                      disabled={reclassBusy}
                      onClick={() => { if (cat.subcategories && cat.subcategories.length) setReclassCat(cat); else doReclassify(cat.id); }}
                      className="flex flex-col items-center gap-3 p-6 rounded-3xl border-2 transition-all active:scale-95 hover:scale-105 disabled:opacity-50"
                      style={{ borderColor: cat.color + '80', backgroundColor: cat.color + '15', minWidth: '140px', minHeight: '140px' }}
                    >
                      <IconRenderer icon={cat.icon} color={cat.color} size={36} />
                      <span className="text-base font-bold text-white text-center leading-snug">{cat.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {reclassCat && (
              <div className="space-y-6">
                <p className="text-xl text-gray-400 font-semibold">{reclassCat.name} — {t.selectSubcategory}</p>
                <div className="flex flex-wrap gap-6 justify-center">
                  {reclassCat.subcategories.map((sub: StopSubcategoryOut) => (
                    <button
                      key={sub.id}
                      disabled={reclassBusy}
                      onClick={() => doReclassify(reclassCat.id, sub.id)}
                      className="flex flex-col items-center gap-3 p-6 rounded-3xl border-2 border-white/10 bg-white/[0.04] hover:bg-white/[0.08] transition-all active:scale-95 hover:scale-105 disabled:opacity-50"
                      style={{ minWidth: '140px', minHeight: '140px' }}
                    >
                      <IconRenderer icon={sub.icon || 'wrench'} color={sub.color || '#6b7280'} size={36} />
                      <span className="text-base font-bold text-white text-center">{sub.name}</span>
                    </button>
                  ))}
                  <button
                    disabled={reclassBusy}
                    onClick={() => doReclassify(reclassCat.id, null)}
                    className="flex flex-col items-center justify-center gap-3 p-6 rounded-3xl border-2 border-white/10 bg-white/[0.02] hover:bg-white/[0.06] transition-all active:scale-95 disabled:opacity-50"
                    style={{ minWidth: '140px', minHeight: '140px' }}
                  >
                    <span className="text-base font-bold text-gray-300 text-center">{t.noSubcategory}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
