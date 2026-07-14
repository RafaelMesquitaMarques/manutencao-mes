// Temperature helpers. Values are stored/served in Celsius everywhere; the UI
// converts to the viewer's preferred unit (User.temp_unit) at display time.
export type TempUnit = 'C' | 'F';

export const cToF = (c: number): number => (c * 9) / 5 + 32;

/** Convert a Celsius value to the given unit and round to a whole degree. */
export const toUnit = (celsius: number, unit: TempUnit): number =>
  Math.round(unit === 'F' ? cToF(celsius) : celsius);

/** e.g. formatTemp(21.4, 'F') === "71°F". Returns '—' for null/undefined. */
export const formatTemp = (
  celsius: number | null | undefined,
  unit: TempUnit,
): string => (celsius == null ? '—' : `${toUnit(celsius, unit)}°${unit}`);

/** A blue→red colour for a Celsius reading, for the badge ring / 3D fill.
 * ~10°C and below = cold blue, ~30°C and above = hot red. */
export const tempColor = (celsius: number | null | undefined): string => {
  if (celsius == null) return '#64748b'; // slate — no reading
  const t = Math.max(10, Math.min(30, celsius));
  const k = (t - 10) / 20; // 0 cold … 1 hot
  const hue = 210 - k * 210; // 210 (blue) → 0 (red)
  return `hsl(${Math.round(hue)}, 85%, 55%)`;
};

// WMO weather-code → emoji icon for the outdoor badge (coarse buckets are enough).
export const weatherIcon = (code: number | null | undefined): string => {
  if (code == null) return '🌡️';
  if (code === 0) return '☀️';
  if (code <= 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code <= 48) return '🌫️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '❄️';
  if (code <= 82) return '🌦️';
  if (code <= 86) return '🌨️';
  return '⛈️';
};
