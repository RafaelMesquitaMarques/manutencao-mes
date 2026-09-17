/**
 * Formatting helpers and small building blocks shared by every Costs panel.
 * Extracted from CostsDashboard so the new control panels render identically
 * to the existing tabs — same money format, same card, same palette.
 */
import type { ReactNode } from 'react';
import type { SlotStatus } from '../../api/costs';

export const money = (v: number) => `$${Math.round(v).toLocaleString()}`;
export const signedMoney = (v: number) => `${v < 0 ? '-' : ''}$${Math.round(Math.abs(v)).toLocaleString()}`;
export const compactMoney = (v: number) => {
  const a = Math.abs(v);
  const s = a >= 1000 ? `${Math.round(a / 100) / 10}k` : `${Math.round(a)}`;
  return `${v < 0 ? '-' : ''}$${s}`;
};
export const pct = (v: number | null | undefined, digits = 0) =>
  v == null ? '—' : `${v >= 0 && digits === 0 ? '' : ''}${v.toFixed(digits)}%`;
export const signedPct = (v: number | null | undefined) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${Math.round(v)}%`;

export const sumMonths = (arr: number[], months: number[]) =>
  months.reduce((s, m) => s + (arr[m - 1] ?? 0), 0);
export const cumulative = (arr: number[]) =>
  arr.reduce<number[]>((acc, v, i) => { acc.push((acc[i - 1] ?? 0) + v); return acc; }, []);
export const ZEROS = Array(12).fill(0) as number[];

export const TYPE_COLORS: Record<string, string> = {
  labor: '#3b82f6', parts: '#8b5cf6', local_parts: '#06b6d4', external_parts: '#ec4899',
  contracts: '#f59e0b', rentals: '#10b981', other: '#64748b',
};
const EXTRA_COLORS = ['#3b82f6', '#8b5cf6', '#06b6d4', '#ec4899', '#f59e0b', '#10b981', '#f97316', '#84cc16'];
export const colorFor = (key: string): string => {
  if (TYPE_COLORS[key]) return TYPE_COLORS[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return EXTRA_COLORS[h % EXTRA_COLORS.length];
};

// Slot state against the cut-off. `awaiting` is amber on purpose: an elapsed
// month with nothing posted is a data gap, not a month that cost nothing.
export const SLOT_COLORS: Record<SlotStatus, string> = {
  closed: '#3b82f6', partial: '#a855f7', awaiting: '#f59e0b', future: '#64748b',
};
export const SLOT_DOT: Record<SlotStatus, string> = {
  closed: 'bg-blue-400', partial: 'bg-purple-400', awaiting: 'bg-amber-400', future: 'bg-gray-500',
};

export const SEVERITY_CLASS: Record<string, string> = {
  critical: 'text-red-400 bg-red-500/10 border-red-500/25',
  high: 'text-amber-400 bg-amber-500/10 border-amber-500/25',
  medium: 'text-blue-400 bg-blue-500/10 border-blue-500/25',
};

export type CardColor = 'blue' | 'amber' | 'green' | 'purple' | 'red' | 'cyan' | 'gray';

// Tailwind class names must be literal for the JIT purge — hence the map.
const CARD_BG: Record<CardColor, string> = {
  blue: 'bg-blue-500/10', amber: 'bg-amber-500/10', green: 'bg-green-500/10',
  purple: 'bg-purple-500/10', red: 'bg-red-500/10', cyan: 'bg-cyan-500/10',
  gray: 'bg-gray-500/10',
};

export function Card({ icon, label, value, sub, color, valueClass, onClick, title }: {
  icon: ReactNode;
  label: string;
  value: string;
  sub?: string;
  color: CardColor;
  valueClass?: string;
  onClick?: () => void;
  title?: string;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">{label}</p>
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${CARD_BG[color]}`}>{icon}</div>
      </div>
      <p className={`text-2xl font-bold ${valueClass ?? 'text-white'}`}>{value}</p>
      {sub && <p className="text-xs text-gray-600 mt-1">{sub}</p>}
    </>
  );
  const cls = 'bg-[#0d1421] border border-white/[0.06] rounded-xl p-4 text-left w-full';
  return onClick ? (
    <button type="button" onClick={onClick} title={title}
      className={`${cls} hover:border-white/[0.14] transition-colors`}>{body}</button>
  ) : (
    <div className={cls} title={title}>{body}</div>
  );
}

/** Section shell used by every new panel — keeps the page's card look. */
export function Panel({ icon, title, subtitle, right, children, className }: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-[#0d1421] border border-white/[0.06] rounded-xl p-4 ${className ?? ''}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
        <div>
          <div className="flex items-center gap-2">
            {icon}
            <h3 className="text-sm font-semibold text-gray-300">{title}</h3>
          </div>
          {subtitle && <p className="text-xs text-gray-600 mt-0.5">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

/** A labelled figure in a compact read-out row. */
export function Stat({ label, value, valueClass, hint }: {
  label: string; value: string; valueClass?: string; hint?: string;
}) {
  return (
    <div title={hint}>
      <p className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</p>
      <p className={`text-sm font-semibold font-mono ${valueClass ?? 'text-gray-200'}`}>{value}</p>
    </div>
  );
}

export const varianceClass = (v: number) => (v >= 0 ? 'text-green-400' : 'text-red-400');
