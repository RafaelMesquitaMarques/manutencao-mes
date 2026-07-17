import { create } from 'zustand';

// ── Map editor core: save tracking + undo/redo history ───────────────────────
// Every layout mutation goes through `runSave` so the UI can show a truthful
// Saving… / Saved / Failed(retry) state instead of silently swallowing errors,
// and through `pushHistory` so any edit can be undone (Ctrl+Z) / redone.
//
// History entries carry closures (apply local state + call the API) built by
// useMapEditor — the store only owns the stacks and the save ledger. Deleted
// props get RECREATED on undo with a NEW id; `alias` maps the old id to the
// new one so later history entries (and the current selection) stay valid.

export interface HistoryEntry {
  label: string;
  undo: () => void;
  redo: () => void;
}

interface FailedSave {
  id: number;
  run: () => Promise<void>;
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface EditorState {
  pending: number;                 // API writes in flight
  failed: FailedSave[];            // writes that errored — retryable
  lastSavedAt: number | null;

  history: HistoryEntry[];
  future: HistoryEntry[];

  aliases: Record<string, string>; // old prop id → recreated prop id

  snap: boolean;                   // grid/angle snapping for the 3D gizmo

  runSave: (op: () => Promise<void>) => void;
  retryFailed: () => void;
  discardFailed: () => void;

  pushHistory: (entry: HistoryEntry) => void;
  /** Group every entry pushed inside `fn` into ONE composite undo/redo step
   * (multi-delete, group operations). No-op wrapper when nothing is pushed. */
  batch: (label: string, fn: () => void) => void;
  undo: () => void;
  redo: () => void;
  clearHistory: () => void;

  addAlias: (oldId: string, newId: string) => void;
  resolveId: (id: string) => string;

  setSnap: (v: boolean) => void;

  status: () => SaveStatus;
  reset: () => void;
}

const SNAP_KEY = 'kaizo-map-snap';
const HISTORY_LIMIT = 100;
let failedSeq = 0;
// While non-null, pushHistory collects entries here instead of the stack (batch()).
let batchBuffer: HistoryEntry[] | null = null;

export const useEditorStore = create<EditorState>((set, get) => ({
  pending: 0,
  failed: [],
  lastSavedAt: null,
  history: [],
  future: [],
  aliases: {},
  snap: localStorage.getItem(SNAP_KEY) !== '0',

  runSave: (op) => {
    set((s) => ({ pending: s.pending + 1 }));
    op()
      .then(() => set((s) => ({ pending: s.pending - 1, lastSavedAt: Date.now() })))
      .catch(() => set((s) => ({
        pending: s.pending - 1,
        failed: [...s.failed, { id: ++failedSeq, run: op }],
      })));
  },

  retryFailed: () => {
    const { failed, runSave } = get();
    set({ failed: [] });
    failed.forEach((f) => runSave(f.run));
  },

  discardFailed: () => set({ failed: [] }),

  pushHistory: (entry) => {
    if (batchBuffer) { batchBuffer.push(entry); return; }
    set((s) => ({
      history: [...s.history.slice(-(HISTORY_LIMIT - 1)), entry],
      future: [],
    }));
  },

  batch: (label, fn) => {
    const isOuter = batchBuffer === null;
    if (isOuter) batchBuffer = [];
    try {
      fn();
    } finally {
      if (isOuter) {
        const entries = batchBuffer!;
        batchBuffer = null;
        if (entries.length === 1) get().pushHistory(entries[0]);
        else if (entries.length > 1) {
          get().pushHistory({
            label,
            undo: () => { for (let i = entries.length - 1; i >= 0; i--) entries[i].undo(); },
            redo: () => { for (const e of entries) e.redo(); },
          });
        }
      }
    }
  },

  undo: () => {
    const { history } = get();
    const entry = history[history.length - 1];
    if (!entry) return;
    set((s) => ({ history: s.history.slice(0, -1), future: [...s.future, entry] }));
    entry.undo();
  },

  redo: () => {
    const { future } = get();
    const entry = future[future.length - 1];
    if (!entry) return;
    set((s) => ({ future: s.future.slice(0, -1), history: [...s.history, entry] }));
    entry.redo();
  },

  clearHistory: () => set({ history: [], future: [], aliases: {} }),

  addAlias: (oldId, newId) => set((s) => {
    // re-point any alias that resolved to oldId, then add the new hop
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.aliases)) next[k] = v === oldId ? newId : v;
    next[oldId] = newId;
    return { aliases: next };
  }),

  resolveId: (id) => get().aliases[id] ?? id,

  setSnap: (v) => {
    localStorage.setItem(SNAP_KEY, v ? '1' : '0');
    set({ snap: v });
  },

  status: () => {
    const { pending, failed, lastSavedAt } = get();
    if (failed.length) return 'error';
    if (pending > 0) return 'saving';
    return lastSavedAt ? 'saved' : 'idle';
  },

  reset: () => set({ pending: 0, failed: [], history: [], future: [], aliases: {}, lastSavedAt: null }),
}));
