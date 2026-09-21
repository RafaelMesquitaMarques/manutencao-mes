/**
 * Shift Replay clock and loading.
 *
 * The replay is a MODE of the map, not a new page: while it is active, the
 * live WebSocket and the fallback poll are suspended (see FactoryMap.tsx) and
 * what paints the map is `overlayAt(cursor)`. Leaving the replay turns live
 * back on and reloads the map — nothing in live mode is changed.
 *
 * The whole window comes in a single fetch, so moving forward/back/jumping in
 * time is instantaneous and generates no traffic.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchReplayTimeline, type ReplayTimeline } from '../../../api/factoryReplay';
import { ReplayIndex, ms } from './replayModel';

/** Speed multipliers (× real time). 900× plays an 8 h shift in ~32 s. */
export const REPLAY_SPEEDS = [1, 10, 60, 300, 900, 1800] as const;
export const DEFAULT_SPEED = 300;

/** Clock period: 5 updates per second is smooth to the eye and light on the
 *  3D scene (the live push runs at 1 every 4 s). */
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
  // Each request gets a number: a response to an older request (quick shift
  // change) is discarded instead of overwriting the current replay.
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
    reqRef.current += 1;      // invalidates any in-flight load
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

  // The clock: advances the cursor in factory time and stops on its own at the window's end.
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

  // Keeps the cursor inside the window whenever the window changes.
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
