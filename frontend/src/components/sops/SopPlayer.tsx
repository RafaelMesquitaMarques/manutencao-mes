import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X, ChevronLeft, ChevronRight, Check, CheckCircle2, AlertTriangle,
  ExternalLink, PlayCircle, Loader2, Clock, ListChecks,
} from 'lucide-react';
import type { Sop, SopExecution, SopStep, SopStepMedia } from '../../api/sops';

/** API adapter so the same player drives authenticated (app) and kiosk executions. */
export interface SopPlayerApi {
  start: () => Promise<SopExecution>;
  setStep: (executionId: string, stepId: string, checked: boolean) => Promise<SopExecution>;
  complete: (executionId: string, notes?: string) => Promise<SopExecution>;
  abandon: (executionId: string) => Promise<SopExecution>;
}

interface Props {
  sop: Sop;
  onClose: () => void;
  /** Absent → read-only browsing (no "follow" mode). */
  execApi?: SopPlayerApi;
  /** Start following immediately on open (kiosk: one tap on a SOP = follow it). */
  autoStart?: boolean;
  /** Language override — the kiosk follows the machine language, not the browser. */
  lng?: string;
  /** Called after an execution completes or is abandoned (refresh history). */
  onExecutionEnd?: () => void;
}

const CATEGORY_STYLE: Record<string, string> = {
  operation:   'text-sky-300 border-sky-500/40 bg-sky-500/10',
  maintenance: 'text-amber-300 border-amber-500/40 bg-amber-500/10',
  safety:      'text-red-300 border-red-500/40 bg-red-500/10',
  quality:     'text-violet-300 border-violet-500/40 bg-violet-500/10',
  setup:       'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
};

export default function SopPlayer({ sop, onClose, execApi, autoStart, lng, onExecutionEnd }: Props) {
  const { t: rawT } = useTranslation();
  // The kiosk passes the machine's language; the app uses the user's language.
  const t = useMemo(() => {
    return (key: string, opts?: Record<string, unknown>) =>
      rawT(key, { ...(opts ?? {}), ...(lng ? { lng } : {}) }) as string;
  }, [rawT, lng]);

  const steps = sop.steps;
  // Réglage/changement procedures read as checklists (cleaning objectives,
  // changeover checks…): every step visible at once, tick as you go.
  const isChecklist = sop.category === 'setup';

  const [idx, setIdx] = useState(0);
  const [execution, setExecution] = useState<SopExecution | null>(null);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState<SopExecution | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const following = execution !== null && finished === null;
  const checkedIds = useMemo(
    () => new Set((execution?.steps ?? []).filter((s) => s.checked).map((s) => s.step_id)),
    [execution],
  );
  const requiredLeft = steps.filter((s) => s.is_required && !checkedIds.has(s.id)).length;
  const step: SopStep | undefined = steps[idx];

  const startFollowing = async () => {
    if (!execApi) return;
    setBusy(true);
    try {
      setExecution(await execApi.start());
      setIdx(0);
    } finally {
      setBusy(false);
    }
  };

  // Kiosk: one tap on a SOP already means "follow it" — start the execution on
  // open. Ref guard: StrictMode double-mount must not create two executions.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoStart && execApi && !autoStartedRef.current) {
      autoStartedRef.current = true;
      startFollowing();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  const toggleStep = async (target: SopStep, opts?: { advance?: boolean }) => {
    if (!execApi || !execution || busy) return;
    const next = !checkedIds.has(target.id);
    setBusy(true);
    try {
      const updated = await execApi.setStep(execution.id, target.id, next);
      setExecution(updated);
      // Advance in the SAME tick as the state update (wizard mode only). A
      // delayed advance left a window where a quick second tap re-toggled the
      // step just checked — the "step stays unchecked" bug.
      if (opts?.advance && next && idx < steps.length - 1 && steps[idx]?.id === target.id) {
        setIdx((i) => Math.min(i + 1, steps.length - 1));
      }
    } finally {
      setBusy(false);
    }
  };

  const completeRun = async () => {
    if (!execApi || !execution) return;
    setBusy(true);
    try {
      const done = await execApi.complete(execution.id);
      setFinished(done);
      onExecutionEnd?.();
    } finally {
      setBusy(false);
    }
  };

  const handleClose = async () => {
    if (following && execution) {
      // Nothing ticked yet (e.g. opened by mistake from the kiosk, where the
      // execution auto-starts): abandon silently, no confirmation friction.
      if (checkedIds.size > 0 && !window.confirm(t('sops.player.abandonConfirm'))) return;
      try { await execApi?.abandon(execution.id); } catch { /* closing anyway */ }
      onExecutionEnd?.();
    }
    onClose();
  };

  const catStyle = CATEGORY_STYLE[sop.category] ?? CATEGORY_STYLE.operation;

  // ── Completed screen ──────────────────────────────────────────────────────────
  if (finished) {
    const mins = Math.max(1, Math.round((finished.duration_seconds ?? 0) / 60));
    return (
      <Shell onClose={onClose}>
        <div className="flex-1 flex flex-col items-center justify-center gap-5 text-center px-6">
          <CheckCircle2 size={88} className="text-emerald-400" />
          <p className="text-3xl font-black text-white">{t('sops.player.completedTitle')}</p>
          <p className="text-gray-400 text-lg">{sop.sop_number} — {sop.title}</p>
          <p className="text-gray-500 flex items-center gap-2 text-lg">
            <Clock size={18} /> {t('sops.player.completedIn', { minutes: mins })}
          </p>
          <button
            onClick={onClose}
            className="mt-4 px-10 py-4 rounded-2xl text-xl font-black text-white bg-emerald-600 hover:bg-emerald-500"
          >
            {t('common.close')}
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell onClose={handleClose}>
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-white/[0.08]">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs text-gray-500">{sop.sop_number}</span>
            <span className={`text-[11px] px-2 py-0.5 rounded-full border font-bold uppercase tracking-wide ${catStyle}`}>
              {t(`sops.categories.${sop.category}`)}
            </span>
            <span className="text-[11px] px-2 py-0.5 rounded-full border border-white/15 text-gray-400 font-mono">
              v{sop.version}
            </span>
          </div>
          <p className="text-white text-xl font-black leading-tight mt-1 truncate">{sop.title}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {following && (
            <span className="text-sm text-gray-400 font-bold whitespace-nowrap">
              {checkedIds.size}/{steps.length}
            </span>
          )}
          <button
            onClick={handleClose}
            aria-label={t('common.close')}
            className="p-2.5 rounded-xl border border-white/10 text-gray-400 hover:text-white hover:bg-white/[0.06]"
          >
            <X size={22} />
          </button>
        </div>
      </div>

      {isChecklist ? (
        /* ── Checklist mode: every step visible, tap a row to tick it ── */
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="max-w-3xl mx-auto space-y-2.5">
            {steps.length === 0 && (
              <p className="text-gray-500 text-center py-10">{t('sops.player.noSteps')}</p>
            )}
            {steps.map((s, i) => {
              const done = checkedIds.has(s.id);
              return (
                <div
                  key={s.id}
                  role={following ? 'button' : undefined}
                  onClick={() => { if (following) toggleStep(s); }}
                  className={`flex items-start gap-4 rounded-2xl border px-4 py-3.5 transition-colors ${
                    done ? 'bg-emerald-500/[0.07] border-emerald-500/40'
                    : 'bg-white/[0.02] border-white/[0.08]'
                  } ${following ? 'cursor-pointer hover:border-emerald-400/50' : ''} ${busy ? 'opacity-70 pointer-events-none' : ''}`}
                >
                  <span
                    className={`w-10 h-10 shrink-0 rounded-full border-2 flex items-center justify-center font-black transition-colors mt-0.5 ${
                      done ? 'bg-emerald-500 border-emerald-400 text-white'
                      : 'border-white/25 text-gray-500'
                    }`}
                  >
                    {done ? <Check size={22} /> : i + 1}
                  </span>
                  <div className="flex-1 min-w-0 space-y-1.5">
                    {s.title && (
                      <p className={`font-black text-lg leading-snug ${done ? 'text-emerald-200' : 'text-white'}`}>
                        {s.title}
                      </p>
                    )}
                    <p className={`whitespace-pre-wrap leading-relaxed ${done ? 'text-gray-500' : 'text-gray-300'}`}>
                      {s.instruction}
                    </p>
                    {s.warning && (
                      <p className="text-amber-300/90 text-sm flex items-start gap-1.5">
                        <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {s.warning}
                      </p>
                    )}
                    {s.expected_result && (
                      <p className="text-emerald-300/90 text-sm flex items-start gap-1.5">
                        <CheckCircle2 size={15} className="mt-0.5 shrink-0" /> {s.expected_result}
                      </p>
                    )}
                    {!s.is_required && (
                      <span className="inline-block text-[10px] px-2 py-0.5 rounded-full border border-white/15 text-gray-500 uppercase font-bold">
                        {t('sops.player.optionalStep')}
                      </span>
                    )}
                    <StepMediaGallery media={s.media} compact onOpenImage={setLightbox} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        /* ── Wizard mode: one step at a time ── */
        <>
          {/* Step rail */}
          <div className="flex items-center gap-1.5 px-5 py-3 overflow-x-auto shrink-0">
            {steps.map((s, i) => {
              const done = checkedIds.has(s.id);
              const active = i === idx;
              return (
                <button
                  key={s.id}
                  onClick={() => setIdx(i)}
                  aria-label={t('sops.player.stepOf', { n: i + 1, total: steps.length })}
                  className={`w-9 h-9 shrink-0 rounded-full border text-sm font-black flex items-center justify-center transition-colors ${
                    done ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300'
                    : active ? 'bg-blue-500/20 border-blue-400 text-blue-200'
                    : 'border-white/15 text-gray-500 hover:border-white/30'
                  }`}
                >
                  {done ? <Check size={16} /> : i + 1}
                </button>
              );
            })}
          </div>

          {/* Current step */}
          <div className="flex-1 overflow-y-auto px-5 pb-4">
            {step ? (
              <div className="max-w-3xl mx-auto space-y-4">
                <div className="flex items-baseline gap-3">
                  <span className="text-blue-300 font-black text-lg whitespace-nowrap">
                    {t('sops.player.stepOf', { n: idx + 1, total: steps.length })}
                  </span>
                  {!step.is_required && (
                    <span className="text-[11px] px-2 py-0.5 rounded-full border border-white/15 text-gray-500 uppercase font-bold">
                      {t('sops.player.optionalStep')}
                    </span>
                  )}
                </div>

                {step.title && <p className="text-white text-2xl font-black leading-snug">{step.title}</p>}

                {step.warning && (
                  <div className="flex gap-3 items-start bg-amber-500/10 border border-amber-500/40 rounded-xl px-4 py-3">
                    <AlertTriangle size={22} className="text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-amber-300 font-bold text-sm uppercase tracking-wide">{t('sops.player.warning')}</p>
                      <p className="text-amber-100/90 whitespace-pre-wrap">{step.warning}</p>
                    </div>
                  </div>
                )}

                <p className="text-gray-200 text-lg leading-relaxed whitespace-pre-wrap">{step.instruction}</p>

                {step.expected_result && (
                  <div className="flex gap-3 items-start bg-emerald-500/[0.07] border border-emerald-500/30 rounded-xl px-4 py-3">
                    <CheckCircle2 size={20} className="text-emerald-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-emerald-300 font-bold text-sm uppercase tracking-wide">{t('sops.player.expected')}</p>
                      <p className="text-emerald-100/90 whitespace-pre-wrap">{step.expected_result}</p>
                    </div>
                  </div>
                )}

                <StepMediaGallery media={step.media} onOpenImage={setLightbox} />
              </div>
            ) : (
              <p className="text-gray-500 text-center py-10">{t('sops.player.noSteps')}</p>
            )}
          </div>
        </>
      )}

      {/* ── Footer controls ── */}
      <div className="border-t border-white/[0.08] px-5 py-4 space-y-3">
        {following && (
          <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${steps.length ? (checkedIds.size / steps.length) * 100 : 0}%` }}
            />
          </div>
        )}
        <div className="flex items-center gap-3">
          {!isChecklist && (
            <button
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
              disabled={idx === 0}
              className="px-4 py-3.5 rounded-xl border border-white/15 text-gray-300 hover:bg-white/[0.05] disabled:opacity-30 font-bold flex items-center gap-1"
            >
              <ChevronLeft size={20} /> <span className="hidden sm:inline">{t('sops.player.previous')}</span>
            </button>
          )}

          {!following ? (
            execApi ? (
              <button
                onClick={startFollowing}
                disabled={busy || steps.length === 0}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl text-lg font-black text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-40"
              >
                {busy ? <Loader2 size={20} className="animate-spin" /> : <PlayCircle size={22} />}
                {t('sops.player.start')}
              </button>
            ) : (
              <div className="flex-1 text-center text-gray-500 text-sm flex items-center justify-center gap-2">
                <ListChecks size={16} /> {t('sops.player.browseOnly')}
              </div>
            )
          ) : isChecklist ? (
            <button
              onClick={completeRun}
              disabled={busy || requiredLeft > 0}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl text-lg font-black text-white bg-green-600 hover:bg-green-500 disabled:opacity-40"
            >
              {busy ? <Loader2 size={20} className="animate-spin" /> : <CheckCircle2 size={22} />}
              {requiredLeft > 0
                ? t('sops.player.stepsLeft', { count: requiredLeft })
                : t('sops.player.complete')}
            </button>
          ) : (
            <>
              {step && (
                <button
                  onClick={() => toggleStep(step, { advance: true })}
                  disabled={busy}
                  className={`flex-1 flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl text-lg font-black transition-colors disabled:opacity-50 ${
                    checkedIds.has(step.id)
                      ? 'text-emerald-300 border border-emerald-500/50 bg-emerald-500/10 hover:bg-emerald-500/20'
                      : 'text-white bg-emerald-600 hover:bg-emerald-500'
                  }`}
                >
                  {busy ? <Loader2 size={20} className="animate-spin" /> : <Check size={22} />}
                  {checkedIds.has(step.id) ? t('sops.player.done') : t('sops.player.markDone')}
                </button>
              )}
              {requiredLeft === 0 && (
                <button
                  onClick={completeRun}
                  disabled={busy}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl text-lg font-black text-white bg-green-600 hover:bg-green-500 disabled:opacity-50"
                >
                  <CheckCircle2 size={22} /> {t('sops.player.complete')}
                </button>
              )}
            </>
          )}

          {!isChecklist && (
            <button
              onClick={() => setIdx((i) => Math.min(steps.length - 1, i + 1))}
              disabled={idx >= steps.length - 1}
              className="px-4 py-3.5 rounded-xl border border-white/15 text-gray-300 hover:bg-white/[0.05] disabled:opacity-30 font-bold flex items-center gap-1"
            >
              <span className="hidden sm:inline">{t('sops.player.next')}</span> <ChevronRight size={20} />
            </button>
          )}
        </div>
      </div>

      {/* ── Image lightbox ── */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[130] bg-black/90 flex items-center justify-center p-6"
          onClick={(e) => { e.stopPropagation(); setLightbox(null); }}
        >
          <img src={lightbox} alt="" className="max-w-full max-h-full rounded-xl" />
          <button className="absolute top-4 right-4 p-2 text-white/80 hover:text-white" aria-label={t('common.close')}>
            <X size={28} />
          </button>
        </div>
      )}
    </Shell>
  );
}

// ── Step media (photos / videos / links) ────────────────────────────────────────

function StepMediaGallery({ media, compact, onOpenImage }: {
  media: SopStepMedia[];
  compact?: boolean;
  onOpenImage: (url: string) => void;
}) {
  if (media.length === 0) return null;
  const images = media.filter((m) => m.media_type === 'image');
  const videos = media.filter((m) => m.media_type === 'video');
  const links = media.filter((m) => m.media_type === 'link');
  return (
    <div className={compact ? 'space-y-2 pt-1' : 'space-y-3'}>
      {images.length > 0 && (
        <div className={`grid gap-3 ${compact ? 'grid-cols-3 sm:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3'}`}>
          {images.map((m) => (
            <button
              key={m.id}
              onClick={(e) => { e.stopPropagation(); onOpenImage(m.url); }}
              className="group relative"
            >
              <img
                src={m.url}
                alt={m.caption ?? ''}
                className={`w-full object-cover rounded-xl border border-white/10 group-hover:border-blue-400/60 ${compact ? 'h-20' : 'h-36'}`}
              />
              {m.caption && !compact && (
                <span className="absolute bottom-0 inset-x-0 text-xs text-gray-200 bg-black/60 rounded-b-xl px-2 py-1 truncate">
                  {m.caption}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {videos.map((m) => (
        <div key={m.id} onClick={(e) => e.stopPropagation()}>
          <video
            src={m.url}
            controls
            preload="metadata"
            className={`w-full rounded-xl border border-white/10 bg-black ${compact ? 'max-h-56' : 'max-h-[340px]'}`}
          />
          {m.caption && <p className="text-xs text-gray-500 mt-1">{m.caption}</p>}
        </div>
      ))}
      {links.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {links.map((m) => (
            <a
              key={m.id}
              href={m.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-white/15 text-blue-300 hover:bg-blue-500/10 text-sm font-semibold"
            >
              <ExternalLink size={15} /> {m.caption || m.url}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  return (
    <div className="fixed inset-0 z-[120] bg-black/70 flex items-center justify-center sm:p-4" onClick={onClose}>
      <div
        className="w-full h-full sm:h-[92vh] sm:max-w-4xl bg-[#0d1421] sm:rounded-2xl border border-white/[0.08] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
