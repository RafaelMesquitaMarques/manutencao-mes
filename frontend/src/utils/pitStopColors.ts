// Pit Stop OF-state palette — deliberately DISTINCT from the machine-status
// palette (utils/statusColors.ts) so a "complete OF" never reads as a "running
// machine" on the same map. Layers of a stack are coloured by component
// CATEGORY (user-configurable, pit_stop_categories); the state below colours
// only the base plate / panel chips.
import type { PitStopOfStateKind } from '../api/pitStop';

export const OF_STATE_HEX: Record<PitStopOfStateKind, string> = {
  awaiting:  '#f97316',   // orange — components still missing
  complete:  '#14b8a6',   // teal — in full (100 %), ready for release
  released:  '#22d3ee',   // cyan — released toward its assembly line
  hold:      '#e2e8f0',   // white-ish — managerial hold
  quality:   '#e2e8f0',
  rework:    '#e2e8f0',
  cancelled: '#334155',   // slate — cancelled OF still physically present
};

export const ofStateColor = (state?: string | null): string =>
  OF_STATE_HEX[(state ?? 'awaiting') as PitStopOfStateKind] ?? OF_STATE_HEX.awaiting;

// Attention cone over a stack (late OF, or ETD = today) — traffic-cone orange.
export const OF_LATE_HEX = '#fb923c';

/** ETD (scheduled_date, YYYY-MM-DD) falls on the viewer's local today. */
export const isDueToday = (scheduled: string | null | undefined): boolean => {
  if (!scheduled) return false;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return scheduled === today;
};

// Fallback layer colour for components without a category.
export const OF_CATEGORY_FALLBACK = '#9ca3af';

// Completeness semaphore — the BASE PLATE of a stack reads the OF's completeness
// at a glance (same hues as the line-TV efficiency cells): green = in full
// (100 %), amber = ≥ 90 %, red = below, grey = no BOM yet (unknown).
export const COMPLETENESS_HEX = {
  full:    '#16a34a',
  almost:  '#eab308',   // yellow (platform's canonical yellow), not amber
  low:     '#dc2626',
  unknown: '#6b7280',
};

export const completenessColor = (pct: number | null | undefined, inFull: boolean): string =>
  inFull ? COMPLETENESS_HEX.full
  : pct == null ? COMPLETENESS_HEX.unknown
  : pct >= 90 ? COMPLETENESS_HEX.almost
  : COMPLETENESS_HEX.low;

/** Plate colour of one OF stack on the map: completeness semaphore, except a
 * cancelled OF which stays flattened slate. */
export const ofPlateColor = (state: string | null | undefined, pct: number | null | undefined, inFull: boolean): string =>
  state === 'cancelled' ? OF_STATE_HEX.cancelled : completenessColor(pct, inFull);
