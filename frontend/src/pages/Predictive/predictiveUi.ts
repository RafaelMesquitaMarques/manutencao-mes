import type { HealthLevel } from '../../api/predictive';

export const LEVEL_COLORS: Record<HealthLevel, string> = {
  normal: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400',
  watch: 'border-amber-500/20 bg-amber-500/10 text-amber-400',
  alert: 'border-orange-500/20 bg-orange-500/10 text-orange-400',
  critical: 'border-red-500/20 bg-red-500/10 text-red-400',
  no_data: 'border-gray-500/20 bg-gray-500/10 text-gray-400',
};

export const LEVEL_HEX: Record<HealthLevel, string> = {
  normal: '#34d399',
  watch: '#fbbf24',
  alert: '#fb923c',
  critical: '#f87171',
  no_data: '#9ca3af',
};

export const scoreLevelHex = (score: number): string => {
  if (score >= 70) return LEVEL_HEX.critical;
  if (score >= 50) return LEVEL_HEX.alert;
  if (score >= 25) return LEVEL_HEX.watch;
  return LEVEL_HEX.normal;
};
