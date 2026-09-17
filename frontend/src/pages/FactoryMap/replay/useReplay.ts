/**
 * Relógio e carregamento do Replay do Turno.
 *
 * O replay é um MODO do mapa, não uma página nova: enquanto está ativo, o
 * WebSocket ao vivo e o poll de fallback ficam suspensos (ver FactoryMap.tsx) e
 * quem pinta o mapa é `overlayAt(cursor)`. Sair do replay volta a ligar o live
 * e recarrega o mapa — nada do modo ao vivo é alterado.
 *
 * A janela inteira vem num único fetch, por isso avançar/recuar/saltar no tempo
 * é instantâneo e não gera tráfego.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchReplayTimeline, type ReplayTimeline } from '../../../api/factoryReplay';
import { ReplayIndex, ms } from './replayModel';

/** Multiplicadores de velocidade (× tempo real). 900× faz um turno de 8 h em ~32 s. */
export const REPLAY_SPEEDS = [1, 10, 60, 300, 900, 1800] as const;
export const DEFAULT_SPEED = 300;

/** Período do relógio: 5 atualizações por segundo é fluido para o olho e leve
 *  para a cena 3D (o push ao vivo corre a 1 a cada 4 s). */
const TICK_MS = 200;

export interface ReplayRange { start: string; end: string; label?: string; key?: string }

export interface ReplayController {
  active: boolean;
  loading: boolean;
  error: string | null;
  index: ReplayIndex | null;
  range: ReplayRange | null;
  cursor: number;
  playing: boolean;
  speed: number;
  startMs: number;
  endMs: number;
  progress: number;                 // 0–1
  enter: (range: ReplayRange, plantId: string) => Promise<void>;
  exit: () => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  setSpeed: (s: number) => void;
  seek: (at: number) => void;
  seekProgress: (p: number) => void;
  step: (deltaMs: number) => void;
}

export function useReplay(): ReplayController {
  const [timeline, setTimeline] = useState<ReplayTimeline | null>(null);
  const [range, setRange] = useState<ReplayRange | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(DEFAULT_SPEED);
  // Cada pedido ganha um número: uma resposta de um pedido antigo (troca rápida
  // de turno) é descartada em vez de sobrescrever o replay atual.
  const reqRef = useRef(0);

  const index = useMemo(() => (timeline ? new ReplayIndex(timeline) : null), [timeline]);
  const startMs = index?.startMs ?? 0;
  const endMs = index?.endMs ?? 0;

  const enter = useCallback(async (r: ReplayRange, plantId: string) => {
    const req = ++reqRef.current;
    setLoading(true);
    setError(null);
    setPlaying(false);
    setRange(r);
    try {
      const data = await fetchReplayTimeline(plantId, r.start, r.end);
      if (reqRef.current !== req) return;
      setTimeline(data);
      setCursor(ms(data.start));
    } catch (e) {
      if (reqRef.current !== req) return;
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'load_failed');
      setTimeline(null);
      setRange(null);
    } finally {
      if (reqRef.current === req) setLoading(false);
    }
  }, []);

  const exit = useCallback(() => {
    reqRef.current += 1;      // invalida qualquer carregamento em voo
    setPlaying(false);
    setTimeline(null);
    setRange(null);
    setError(null);
    setLoading(false);
  }, []);

  const seek = useCallback((at: number) => {
    setCursor((cur) => {
      if (!Number.isFinite(at)) return cur;
      return at;
    });
  }, []);

  // O relógio: avança o cursor em tempo de fábrica e pára sozinho no fim da janela.
  useEffect(() => {
    if (!playing || !index) return;
    const iv = setInterval(() => {
      setCursor((cur) => {
        const next = cur + TICK_MS * speed;
        if (next >= index.endMs) { setPlaying(false); return index.endMs; }
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(iv);
  }, [playing, speed, index]);

  // Mantém o cursor dentro da janela sempre que a janela muda.
  useEffect(() => {
    if (!index) return;
    setCursor((cur) => Math.min(Math.max(cur, index.startMs), index.endMs));
  }, [index]);

  const clamp = useCallback((at: number) => {
    if (!index) return at;
    return Math.min(Math.max(at, index.startMs), index.endMs);
  }, [index]);

  const span = endMs - startMs;
  return {
    active: index !== null || loading,
    loading,
    error,
    index,
    range,
    cursor,
    playing,
    speed,
    startMs,
    endMs,
    progress: span > 0 ? Math.min(1, Math.max(0, (cursor - startMs) / span)) : 0,
    enter,
    exit,
    play: useCallback(() => setPlaying(true), []),
    pause: useCallback(() => setPlaying(false), []),
    toggle: useCallback(() => setPlaying((p) => !p), []),
    setSpeed,
    seek: useCallback((at: number) => { setPlaying(false); seek(clamp(at)); }, [clamp, seek]),
    seekProgress: useCallback((p: number) => {
      if (span <= 0) return;
      setPlaying(false);
      seek(clamp(startMs + p * span));
    }, [clamp, seek, span, startMs]),
    step: useCallback((delta: number) => { setPlaying(false); setCursor((cur) => clamp(cur + delta)); }, [clamp]),
  };
}
