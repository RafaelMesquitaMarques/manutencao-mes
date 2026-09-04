// Shared presentation bits for the Machine Reports page (report / compare /
// productivity views). Kept in one place so the three views stay visually
// identical and neither imports the other.
import { useEffect, useRef, useState } from 'react';
import { CalendarDays, Check, ChevronDown, X } from 'lucide-react';

export function fmtMinutes(min: number | null | undefined): string {
  if (min == null) return '—';
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function fmtPct(v: number | null | undefined): string {
  return v == null ? '—' : `${v}%`;
}

export function fmtHours(v: number | null | undefined): string {
  if (v == null) return '—';
  if (v > 0 && v < 1) return `${Math.round(v * 60)} min`;
  return `${v}h`;
}

export function fmtInt(v: number | null | undefined): string {
  return v == null ? '—' : Math.round(v).toLocaleString();
}

/** Compact form for chart labels / axis ticks (12 500 → 12.5k). */
export function fmtCompact(v: number | null | undefined): string {
  if (v == null) return '—';
  const n = Math.round(v);
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return String(n);
}

export const CARD = 'bg-[#0d1421] border border-white/[0.06] rounded-xl';
export const AXIS_COLOR = '#94a3b8';
export const SPLIT_COLOR = '#1e293b';

export type CardColor = 'blue' | 'amber' | 'green' | 'purple' | 'red' | 'gray' | 'teal';

export function MetricCard({ icon, label, value, sub, color }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  color: CardColor;
}) {
  const styles: Record<CardColor, { bg: string; text: string }> = {
    blue:   { bg: 'bg-blue-500/10',   text: 'text-blue-400' },
    amber:  { bg: 'bg-amber-500/10',  text: 'text-amber-400' },
    green:  { bg: 'bg-green-500/10',  text: 'text-green-400' },
    purple: { bg: 'bg-purple-500/10', text: 'text-purple-400' },
    red:    { bg: 'bg-red-500/10',    text: 'text-red-400' },
    gray:   { bg: 'bg-gray-500/10',   text: 'text-gray-400' },
    teal:   { bg: 'bg-teal-500/10',   text: 'text-teal-400' },
  };
  const s = styles[color];
  return (
    <div className={`${CARD} p-4`}>
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] text-gray-500 font-medium uppercase tracking-wide">{label}</p>
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${s.bg} ${s.text}`}>
          {icon}
        </div>
      </div>
      <p className="text-xl font-bold text-white">{value}</p>
      <p className="text-xs text-gray-600 mt-0.5">{sub}</p>
    </div>
  );
}

/** `label` is required on purpose: a hardcoded English fallback would be one more
 *  untranslated string waiting to reach a French or Spanish user. */
export function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center h-64 text-gray-500 text-sm">
      <div className="animate-spin rounded-full h-6 w-6 border-2 border-blue-500 border-t-transparent mr-3" />
      {label}
    </div>
  );
}

export function Empty({ label, hint, tall }: { label: string; hint?: string; tall?: boolean }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-1 ${tall ? 'h-64' : 'h-[220px]'} text-center px-4`}>
      <span className="text-gray-600 text-sm">{label}</span>
      {hint && <span className="text-gray-700 text-xs max-w-md">{hint}</span>}
    </div>
  );
}

/** Section shell: title + optional subtitle + body, matching the report cards. */
export function Panel({ title, sub, right, children, className }: {
  title: string;
  sub?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`${CARD} p-4 ${className ?? ''}`}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-300">{title}</h3>
          {sub && <p className="text-xs text-gray-600 mt-0.5">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

// ─── Filter controls ──────────────────────────────────────────────────────────

export const INPUT =
  'bg-[#0d1421] border border-white/[0.06] rounded-lg px-3 py-2 text-sm text-gray-200 ' +
  'focus:outline-none focus:border-blue-500';

export interface MultiOption {
  value: string;
  label: string;
  hint?: string;      // secondary line (machine code, department…)
  count?: number;     // ranking figure shown right-aligned (pieces)
}

/**
 * Searchable checkbox dropdown. Needed because a plant has dozens of machines and
 * many operators: a plain <select multiple> is unusable at that size, and the
 * filters have to be combinable (these 3 machines AND those 2 operators).
 * `max` caps the selection — a comparison chart can only carry so many series.
 */
export function MultiSelect({
  options, selected, onChange, placeholder, searchPlaceholder,
  emptyLabel, allLabel, noneLabel, max, width = 'w-56',
}: {
  options: MultiOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  searchPlaceholder: string;
  emptyLabel: string;
  allLabel: string;
  noneLabel: string;
  max?: number;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const shown = query.trim()
    ? options.filter((o) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
    : options;
  const atMax = max != null && selected.length >= max;

  const toggle = (value: string) => {
    if (selected.includes(value)) onChange(selected.filter((v) => v !== value));
    else if (!atMax) onChange([...selected, value]);
  };

  const label = selected.length === 0
    ? placeholder
    : selected.length === 1
      ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
      : `${selected.length} · ${placeholder}`;

  return (
    <div className={`relative ${width}`} ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${INPUT} w-full flex items-center justify-between gap-2 text-left`}
      >
        <span className={selected.length ? 'text-gray-200 truncate' : 'text-gray-500 truncate'}>
          {label}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          {selected.length > 0 && (
            <X
              size={13}
              className="text-gray-500 hover:text-gray-200"
              onClick={(e) => { e.stopPropagation(); onChange([]); }}
            />
          )}
          <ChevronDown size={14} className="text-gray-500" />
        </span>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full min-w-[15rem] bg-[#0d1421] border border-white/10 rounded-lg shadow-xl shadow-black/40">
          <div className="p-2 border-b border-white/[0.06]">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full bg-[#0b1120] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
            />
            <div className="flex items-center justify-between mt-1.5 text-[11px]">
              {/* "Select all" is meaningless under a cap — hide it instead of
                  silently truncating the click. */}
              {max == null ? (
                <button
                  type="button"
                  onClick={() => onChange(shown.map((o) => o.value))}
                  className="text-gray-500 hover:text-gray-200"
                >
                  {allLabel}
                </button>
              ) : (
                <span className="text-gray-700">{selected.length}/{max}</span>
              )}
              <button type="button" onClick={() => onChange([])} className="text-gray-500 hover:text-gray-200">
                {noneLabel}
              </button>
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {shown.length === 0 && (
              <p className="px-3 py-3 text-xs text-gray-600 text-center">{emptyLabel}</p>
            )}
            {shown.map((o) => {
              const on = selected.includes(o.value);
              return (
                <button
                  type="button"
                  key={o.value}
                  onClick={() => toggle(o.value)}
                  disabled={!on && atMax}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-white/[0.04] ${
                    !on && atMax ? 'opacity-40 cursor-not-allowed' : ''
                  }`}
                >
                  <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                    on ? 'bg-blue-600 border-blue-600' : 'border-white/20'
                  }`}>
                    {on && <Check size={10} className="text-white" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-gray-200 block truncate">{o.label}</span>
                    {o.hint && <span className="text-gray-600 block truncate">{o.hint}</span>}
                  </span>
                  {o.count != null && (
                    <span className="text-gray-600 shrink-0">{o.count.toLocaleString()}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Segmented button group — the view / dimension / metric picker used throughout. */
export function Segmented<T extends string>({ value, onChange, options, size = 'sm' }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  size?: 'sm' | 'xs';
}) {
  const pad = size === 'xs' ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-xs';
  return (
    <div className="flex flex-wrap gap-1 bg-[#0b1120] border border-white/[0.06] rounded-lg p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`${pad} rounded font-medium transition-colors ${
            value === o.value ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Distinguishable series colors for multi-entity comparison charts. */
export const SERIES_COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#14b8a6',
  '#ef4444', '#eab308', '#ec4899', '#06b6d4', '#84cc16',
  '#f97316', '#8b5cf6',
];

// ─── Date range ───────────────────────────────────────────────────────────────

export interface DayRange {
  start: string;   // ISO day, inclusive
  end: string;     // ISO day, inclusive
}

/** Local calendar day as YYYY-MM-DD. `toISOString()` would give the UTC day,
 *  which is the previous one for anyone west of Greenwich after 19:00. */
export function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function todayISO(): string {
  return isoDay(new Date());
}

export function addDaysISO(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return isoDay(new Date(y, m - 1, d + delta));
}

/** Days covered by an inclusive range: 2026-08-01 → 2026-08-01 is 1, not 0. */
export function inclusiveDays(start: string, end: string): number {
  const [ys, ms, ds] = start.split('-').map(Number);
  const [ye, me, de] = end.split('-').map(Number);
  return Math.round((Date.UTC(ye, me - 1, de) - Date.UTC(ys, ms - 1, ds)) / 86400000) + 1;
}

export function rangeComplete(r: DayRange): boolean {
  return !!r.start && !!r.end && r.start <= r.end;
}

/** From/to day pickers with a live span readout. `hint` is pre-formatted by the
 *  caller so this stays free of i18n wiring. */
export function DateRangePicker({ value, onChange, fromLabel, toLabel, hint, warn }: {
  value: DayRange;
  onChange: (r: DayRange) => void;
  fromLabel: string;
  toLabel: string;
  hint?: string;
  warn?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 bg-[#0d1421] border border-white/[0.06] rounded-lg px-2.5 py-1.5">
      <CalendarDays size={14} className="text-gray-500 shrink-0" />
      <input
        type="date"
        value={value.start}
        max={value.end || undefined}
        onChange={(e) => onChange({ ...value, start: e.target.value })}
        aria-label={fromLabel}
        className="bg-transparent text-sm text-gray-200 focus:outline-none [color-scheme:dark]"
      />
      <span className="text-gray-600 text-xs">→</span>
      <input
        type="date"
        value={value.end}
        min={value.start || undefined}
        onChange={(e) => onChange({ ...value, end: e.target.value })}
        aria-label={toLabel}
        className="bg-transparent text-sm text-gray-200 focus:outline-none [color-scheme:dark]"
      />
      {hint && (
        <span className={`text-[11px] whitespace-nowrap ${warn ? 'text-amber-400/90' : 'text-gray-600'}`}>
          {hint}
        </span>
      )}
    </div>
  );
}
