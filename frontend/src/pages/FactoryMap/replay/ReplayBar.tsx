/**
 * Barra de transporte do Replay do Turno.
 *
 * Fica no rodapé da área do mapa enquanto o modo replay está ativo: escolher o
 * dia e o turno, reproduzir/pausar, acelerar, saltar para um horário e ver os
 * marcadores de eventos (alertas, tickets, rejeitos) da janela.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Play, Pause, SkipBack, SkipForward, ChevronsLeft, ChevronsRight, X, History,
} from 'lucide-react';
import { fetchReplayWindows, type ReplayWindow } from '../../../api/factoryReplay';
import { REPLAY_SPEEDS, type ReplayController, type ReplayRange } from './useReplay';

const KNOWN_SHIFTS = new Set(['morning', 'afternoon', 'night', 'day', 'evening']);

/** Cor do marcador na régua, por tipo de evento. */
const MARKER_HEX: Record<string, string> = {
  alert: '#f97316',
  ticket_opened: '#eab308',
  ticket_closed: '#22c55e',
  reject: '#ec4899',
};

// Formatadores por fuso são caros de construir e a régua formata cada marcador
// a cada render — daí o cache.
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat | null {
  const hit = fmtCache.get(key);
  if (hit) return hit;
  try {
    const f = new Intl.DateTimeFormat('en-GB', opts);
    fmtCache.set(key, f);
    return f;
  } catch { return null; }
}

const todayIn = (tz: string): string => {
  const f = formatter(`day:${tz}`, { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  // en-CA dá YYYY-MM-DD; en-GB dá DD/MM/YYYY, então reordenamos a partir das partes.
  if (!f) return new Date().toISOString().slice(0, 10);
  const parts = f.formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
};

export const formatInTz = (at: number, tz: string, withSeconds = true): string => {
  const f = formatter(`t${withSeconds ? 's' : ''}:${tz}`, {
    timeZone: tz, hour: '2-digit', minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
    // h23 explícito: `hour12: false` sozinho rende "24:00" à meia-noite em
    // alguns runtimes, o que partiria o salto para um horário.
    hourCycle: 'h23',
  });
  if (!f) return new Date(at).toISOString().slice(11, withSeconds ? 19 : 16);
  return f.format(new Date(at));
};

/** Minutos desde a meia-noite local da planta, para um instante UTC. */
function localMinutes(at: number, tz: string): number {
  const hhmm = formatInTz(at, tz, false);
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

interface Props {
  plantId: string;
  plantTimezone: string;
  replay: ReplayController;
  onExit: () => void;
}

export default function ReplayBar({ plantId, plantTimezone, replay, onExit }: Props) {
  const { t } = useTranslation();
  const [day, setDay] = useState(() => todayIn(plantTimezone));
  const [windows, setWindows] = useState<ReplayWindow[] | null>(null);
  const [dayRange, setDayRange] = useState<{ start: string; end: string } | null>(null);
  const [selected, setSelected] = useState<string>('');     // '' = dia inteiro
  const [windowsError, setWindowsError] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);

  const tz = replay.index?.timezone ?? plantTimezone;

  useEffect(() => {
    if (!plantId) return;
    let cancelled = false;
    setWindows(null);
    setWindowsError(false);
    fetchReplayWindows(plantId, day)
      .then((res) => {
        if (cancelled) return;
        setWindows(res.windows);
        setDayRange(res.day);
        // Pré-seleciona o turno mais recente que JÁ COMEÇOU — é quase sempre o que
        // se quer rever numa reunião de produção. Nenhum começou ainda (dia
        // futuro/madrugada) → o primeiro da lista.
        setSelected((cur) => {
          if (res.windows.some((w) => w.start === cur)) return cur;
          const now = Date.now();
          const started = res.windows.filter((w) => Date.parse(w.start) <= now);
          return (started[started.length - 1] ?? res.windows[0])?.start ?? '';
        });
      })
      .catch(() => { if (!cancelled) { setWindows([]); setWindowsError(true); } });
    return () => { cancelled = true; };
  }, [plantId, day]);

  const chosen: ReplayRange | null = useMemo(() => {
    if (selected) {
      const w = windows?.find((x) => x.start === selected);
      if (w) return { start: w.start, end: w.end, key: w.key, label: shiftLabel(w.key, t) };
    }
    if (dayRange) return { start: dayRange.start, end: dayRange.end, label: t('replay.wholeDay') };
    return null;
  }, [selected, windows, dayRange, t]);

  const markers = useMemo(() => replay.index?.markers() ?? [], [replay.index]);

  const onScrub = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    replay.seekProgress((clientX - rect.left) / rect.width);
  };

  const loaded = replay.index !== null;
  const cursorLabel = loaded ? formatInTz(replay.cursor, tz) : '—';

  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 border-t border-amber-500/30 bg-gray-950/95 backdrop-blur px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="flex items-center gap-1.5 font-semibold text-amber-300">
          <History size={14} /> {t('replay.title')}
        </span>

        <input
          type="date" value={day} max={todayIn(plantTimezone)}
          onChange={(e) => setDay(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-gray-200 focus:outline-none focus:border-amber-500"
        />

        <select
          value={selected} onChange={(e) => setSelected(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-gray-200 focus:outline-none focus:border-amber-500 max-w-[220px]"
        >
          {(windows ?? []).map((w) => (
            <option key={w.start} value={w.start}>
              {shiftLabel(w.key, t)} · {formatInTz(Date.parse(w.start), tz, false)}–{formatInTz(Date.parse(w.end), tz, false)} ({w.machine_count})
            </option>
          ))}
          <option value="">{t('replay.wholeDay')}</option>
        </select>

        <button
          onClick={() => chosen && replay.enter(chosen, plantId)}
          disabled={!chosen || replay.loading}
          className="px-2.5 py-1 rounded-lg bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-40"
        >
          {replay.loading ? t('replay.loading') : t('replay.load')}
        </button>

        {windows?.length === 0 && !windowsError && (
          <span className="text-gray-500">{t('replay.noShiftConfig')}</span>
        )}
        {windowsError && <span className="text-red-400">{t('replay.windowsError')}</span>}
        {replay.error && <span className="text-red-400">{t(`replay.error.${replay.error}`, t('replay.error.load_failed'))}</span>}

        <span className="w-px h-5 bg-gray-700 mx-0.5" />

        <button onClick={() => replay.seek(replay.startMs)} disabled={!loaded}
          title={t('replay.restart')}
          className="p-1.5 rounded-lg text-gray-300 hover:text-white hover:bg-gray-800 disabled:opacity-30"><SkipBack size={15} /></button>
        <button onClick={() => replay.step(-5 * 60_000)} disabled={!loaded}
          title={t('replay.stepBack')}
          className="p-1.5 rounded-lg text-gray-300 hover:text-white hover:bg-gray-800 disabled:opacity-30"><ChevronsLeft size={15} /></button>
        <button onClick={replay.toggle} disabled={!loaded}
          title={replay.playing ? t('replay.pause') : t('replay.play')}
          className="p-1.5 rounded-lg text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-30">
          {replay.playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <button onClick={() => replay.step(5 * 60_000)} disabled={!loaded}
          title={t('replay.stepForward')}
          className="p-1.5 rounded-lg text-gray-300 hover:text-white hover:bg-gray-800 disabled:opacity-30"><ChevronsRight size={15} /></button>
        <button onClick={() => replay.seek(replay.endMs)} disabled={!loaded}
          title={t('replay.toEnd')}
          className="p-1.5 rounded-lg text-gray-300 hover:text-white hover:bg-gray-800 disabled:opacity-30"><SkipForward size={15} /></button>

        <select
          value={replay.speed} onChange={(e) => replay.setSpeed(Number(e.target.value))} disabled={!loaded}
          title={t('replay.speedHint')}
          className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-gray-200 focus:outline-none focus:border-amber-500 disabled:opacity-40"
        >
          {REPLAY_SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
        </select>

        <span className="font-mono text-sm text-amber-200 tabular-nums">{cursorLabel}</span>

        <label className="flex items-center gap-1 text-gray-400">
          {t('replay.jumpTo')}
          <input
            type="time" step={60} disabled={!loaded}
            onChange={(e) => {
              const v = e.target.value;
              if (!v || !replay.index) return;
              const [h, m] = v.split(':').map(Number);
              // O horário digitado é hora de parede da planta. Deslocamos a partir
              // do início da janela; se cair antes dele, o turno virou a
              // meia-noite e o instante pedido está no dia seguinte.
              const wanted = (h || 0) * 60 + (m || 0);
              let target = replay.startMs + (wanted - localMinutes(replay.startMs, tz)) * 60_000;
              if (target < replay.startMs) target += 86_400_000;
              replay.seek(target);   // seek já limita o cursor à janela
            }}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-gray-200 focus:outline-none focus:border-amber-500 disabled:opacity-40"
          />
        </label>

        <button onClick={onExit}
          className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 hover:bg-emerald-500/20">
          <X size={13} /> {t('replay.backToLive')}
        </button>
      </div>

      {/* Régua: progresso + marcadores de eventos da janela */}
      <div className="flex items-center gap-2 mt-2">
        <span className="font-mono text-[10px] text-gray-500 tabular-nums w-10">
          {loaded ? formatInTz(replay.startMs, tz, false) : '—'}
        </span>
        <div
          ref={trackRef}
          onPointerDown={(e) => { if (!loaded) return; e.currentTarget.setPointerCapture(e.pointerId); onScrub(e.clientX); }}
          onPointerMove={(e) => { if (loaded && e.buttons === 1) onScrub(e.clientX); }}
          role="slider" aria-label={t('replay.scrubber')}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(replay.progress * 100)}
          tabIndex={0}
          onKeyDown={(e) => {
            if (!loaded) return;
            if (e.key === 'ArrowLeft') { e.preventDefault(); replay.step(-60_000); }
            if (e.key === 'ArrowRight') { e.preventDefault(); replay.step(60_000); }
          }}
          className={`relative flex-1 h-6 rounded-md bg-gray-800 border border-gray-700 ${loaded ? 'cursor-pointer' : 'opacity-40'}`}
        >
          <div className="absolute inset-y-0 left-0 rounded-l-md bg-amber-500/25 pointer-events-none"
            style={{ width: `${replay.progress * 100}%` }} />
          {markers.map((m, i) => (
            <span key={`${m.kind}-${i}`} title={`${formatInTz(m.at, tz, false)} · ${m.label ?? t(`replay.marker.${m.kind}`)}`}
              className="absolute top-1 bottom-1 w-[2px] rounded-full pointer-events-none"
              style={{ left: `${m.pos * 100}%`, background: MARKER_HEX[m.kind] ?? '#94a3b8' }} />
          ))}
          <span className="absolute -top-0.5 -bottom-0.5 w-[3px] bg-amber-300 rounded-full pointer-events-none"
            style={{ left: `calc(${replay.progress * 100}% - 1.5px)` }} />
        </div>
        <span className="font-mono text-[10px] text-gray-500 tabular-nums w-10 text-right">
          {loaded ? formatInTz(replay.endMs, tz, false) : '—'}
        </span>
      </div>
    </div>
  );
}

function shiftLabel(key: string, t: (k: string) => string): string {
  return KNOWN_SHIFTS.has(key) ? t(`shift.${key}`) : key;
}
