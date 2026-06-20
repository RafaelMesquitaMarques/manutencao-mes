// Human-readable durations — granular to the second, never rounded to bare hours.
// Shows the two most-significant non-zero units, e.g. "1 h 23 min", "4 min 12 s", "45 s".

export function humanDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null) return '—';
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  if (sec && !h) parts.push(`${sec} s`); // seconds only matter for sub-hour durations
  if (parts.length === 0) return '0 min';
  return parts.slice(0, 2).join(' ');
}

export const humanMinutes = (minutes: number | null | undefined): string =>
  minutes == null ? '—' : humanDuration(minutes * 60);

export const humanHours = (hours: number | null | undefined): string =>
  hours == null ? '—' : humanDuration(hours * 3600);
