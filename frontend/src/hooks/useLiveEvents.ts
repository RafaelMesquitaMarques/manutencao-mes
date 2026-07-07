import { useEffect, useRef } from 'react';
import { useAuthStore } from '../store/authStore';

/**
 * Live-update events over a single shared WebSocket (/api/live/ws).
 *
 * The backend pushes tiny {topic, ref?} hints when something changes (see
 * backend/app/services/event_bus.py); subscribers refetch through the regular
 * REST endpoints. Pages keep a slow polling interval as a fallback for missed
 * events — this bus is what makes them feel instant.
 *
 * Topics: "machines" (ref = machine id | code | page_slug, or null for a
 * plant-wide broadcast), "badges", "ping" (keepalive), plus a synthetic
 * "reconnect" emitted locally after a dropped connection is re-established so
 * subscribers can catch up on anything missed while offline.
 */
export interface LiveEvent {
  topic: string;
  ref?: string | null;
}

type Handler = (e: LiveEvent) => void;

const handlers = new Set<Handler>();
let ws: WebSocket | null = null;
let wasConnected = false;
let retries = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function emit(e: LiveEvent) {
  handlers.forEach((h) => {
    try { h(e); } catch { /* one bad handler must not break the others */ }
  });
}

function connect() {
  if (ws || !handlers.size) return;
  const token = useAuthStore.getState().token;
  if (!token) return;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${window.location.host}/api/live/ws?token=${token}`);
  ws = sock;
  sock.onopen = () => {
    retries = 0;
    if (wasConnected) emit({ topic: 'reconnect' });
    wasConnected = true;
  };
  sock.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data) as LiveEvent;
      if (e.topic !== 'ping') emit(e);
    } catch { /* ignore malformed frames */ }
  };
  sock.onclose = () => {
    ws = null;
    scheduleReconnect();
  };
  sock.onerror = () => sock.close();
}

function scheduleReconnect() {
  if (reconnectTimer || !handlers.size) return;
  const delay = Math.min(30_000, 1_000 * 2 ** retries);
  retries += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// Returning to a backgrounded tab: reconnect right away instead of waiting
// out the backoff timer.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && handlers.size && !ws) {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      retries = 0;
      connect();
    }
  });
}

function subscribeLive(h: Handler): () => void {
  handlers.add(h);
  connect();
  return () => {
    handlers.delete(h);
    if (!handlers.size) {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      wasConnected = false;
      retries = 0;
      ws?.close();
      ws = null;
    }
  };
}

/** Subscribe to live events for the lifetime of the component. */
export function useLiveEvents(handler: Handler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => subscribeLive((e) => handlerRef.current(e)), []);
}

/**
 * Refetch trigger for one machine: fires when a "machines" event matches any of
 * the given refs (id / code / page_slug — pass all you know), on plant-wide
 * broadcasts, and after a reconnect.
 */
export function useMachineLive(refs: Array<string | null | undefined>, onChange: () => void) {
  const refsRef = useRef(refs);
  refsRef.current = refs;
  useLiveEvents((e) => {
    if (e.topic === 'reconnect') { onChange(); return; }
    if (e.topic !== 'machines') return;
    if (!e.ref || refsRef.current.includes(e.ref)) onChange();
  });
}
