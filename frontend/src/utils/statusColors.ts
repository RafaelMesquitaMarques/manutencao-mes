// Canonical machine-status palette — the single source of truth for status color
// across the app: the kiosk frame + status pill, the 3D floor mats, and the 2D map
// nodes. Anywhere a color reflects machine status, import from here so they never drift.
//
//   running      → green   (machine operating)
//   planned_stop → blue    (planned stop)
//   stopped      → red     (unplanned / generic stop)
//   maintenance  → yellow  (maintenance called — waiting for the technician)
//   intervention → purple  (technician actively working on the machine)
//   unjustified  → pink    (MES-detected stop, no reason entered yet)
//   idle         → gray    (no activity / unknown)
export const STATUS_HEX: Record<string, string> = {
  running:      '#22c55e',
  planned_stop: '#3b82f6',
  stopped:      '#ef4444',
  maintenance:  '#eab308',
  intervention: '#a855f7',
  unjustified:  '#ec4899',
  idle:         '#6b7280',
};

export const statusColor = (status?: string | null): string =>
  STATUS_HEX[status || 'idle'] || STATUS_HEX.idle;

export const STATUS_LABEL: Record<string, { en: string; fr: string; es: string }> = {
  running:      { en: 'Running',      fr: 'En marche',     es: 'En marcha' },
  planned_stop: { en: 'Planned stop', fr: 'Arrêt planifié', es: 'Parada planificada' },
  stopped:      { en: 'Stopped',      fr: 'Arrêté',        es: 'Parado' },
  maintenance:  { en: 'Maintenance',  fr: 'Maintenance',   es: 'Mantenimiento' },
  intervention: { en: 'Intervention', fr: 'Intervention',  es: 'Intervención' },
  unjustified:  { en: 'Unjustified',  fr: 'Non justifié',  es: 'Sin justificar' },
  idle:         { en: 'Idle',         fr: 'Inactif',       es: 'Inactivo' },
};
