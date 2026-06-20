import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar, ChevronDown, Search, Check, X } from 'lucide-react';
import type { Machine } from '../types';

export interface FilterState {
  mode: 'preset' | 'custom';
  days: number;            // active preset when mode === 'preset'
  startDate: string;       // YYYY-MM-DD when mode === 'custom'
  endDate: string;
  machineIds: string[];
}

export const DEFAULT_FILTERS: FilterState = {
  mode: 'preset', days: 30, startDate: '', endDate: '', machineIds: [],
};

/** Build the query params the dashboard/intervention endpoints expect. */
export function filtersToParams(f: FilterState): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.mode === 'custom' && f.startDate && f.endDate) {
    p.start_date = f.startDate;
    p.end_date = f.endDate;
    p.days = String(Math.max(1, Math.round((+new Date(f.endDate) - +new Date(f.startDate)) / 86400000) + 1));
  } else {
    p.period_days = String(f.days);
    p.days = String(f.days);
  }
  if (f.machineIds.length) p.machine_ids = f.machineIds.join(',');
  return p;
}

const PRESETS = [
  { days: 7,   label: '7j' },
  { days: 30,  label: '30j' },
  { days: 90,  label: '90j' },
  { days: 365, label: '12 mois' },
];

export default function DashboardFilters({
  value, machines, onChange,
}: {
  value: FilterState;
  machines: Machine[];
  onChange: (f: FilterState) => void;
}) {
  const { t } = useTranslation();
  const [machineOpen, setMachineOpen] = useState(false);
  const [search, setSearch] = useState('');
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!machineOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setMachineOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [machineOpen]);

  const activeMachines = machines.filter((m) => m.is_active !== false);
  const filtered = activeMachines.filter((m) => {
    const q = search.toLowerCase();
    return !q || (m.display_name || m.name).toLowerCase().includes(q) || (m.code || '').toLowerCase().includes(q);
  });

  const toggleMachine = (id: string) => {
    const next = value.machineIds.includes(id)
      ? value.machineIds.filter((x) => x !== id)
      : [...value.machineIds, id];
    onChange({ ...value, machineIds: next });
  };

  const machineLabel = value.machineIds.length === 0
    ? t('dashFilters.allMachines', 'Toutes les machines')
    : `${value.machineIds.length} ${t('dashFilters.machines', 'machine(s)')}`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Period presets */}
      <div className="flex gap-1 bg-white/[0.04] rounded-lg p-1">
        {PRESETS.map((p) => (
          <button
            key={p.days}
            onClick={() => onChange({ ...value, mode: 'preset', days: p.days })}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              value.mode === 'preset' && value.days === p.days
                ? 'bg-blue-600 text-white'
                : 'text-gray-400 hover:bg-white/[0.06]'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Custom range */}
      <div className={`flex items-center gap-1.5 rounded-lg px-2 py-1 border transition-colors ${
        value.mode === 'custom' && value.startDate && value.endDate ? 'border-blue-500/50 bg-blue-500/5' : 'border-white/[0.08]'
      }`}>
        <Calendar size={13} className="text-gray-500" />
        <input
          type="date"
          value={value.startDate}
          max={value.endDate || undefined}
          onChange={(e) => onChange({ ...value, mode: 'custom', startDate: e.target.value })}
          className="bg-transparent text-xs text-gray-300 focus:outline-none [color-scheme:dark]"
        />
        <span className="text-gray-600 text-xs">→</span>
        <input
          type="date"
          value={value.endDate}
          min={value.startDate || undefined}
          onChange={(e) => onChange({ ...value, mode: 'custom', endDate: e.target.value })}
          className="bg-transparent text-xs text-gray-300 focus:outline-none [color-scheme:dark]"
        />
      </div>

      {/* Machine multi-select */}
      <div className="relative" ref={popRef}>
        <button
          onClick={() => setMachineOpen((v) => !v)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] text-xs text-gray-300 hover:bg-white/[0.06]"
        >
          {machineLabel}
          {value.machineIds.length > 0 && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onChange({ ...value, machineIds: [] }); }}
              className="text-gray-500 hover:text-red-400"
            >
              <X size={12} />
            </span>
          )}
          <ChevronDown size={13} className={`transition-transform ${machineOpen ? 'rotate-180' : ''}`} />
        </button>

        {machineOpen && (
          <div className="absolute right-0 mt-1.5 w-64 z-[60] bg-[#0d1421] border border-white/[0.1] rounded-xl shadow-2xl shadow-black/60 p-2">
            <div className="relative mb-2">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-600" />
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('dashFilters.searchMachine', 'Chercher…')}
                className="w-full pl-8 pr-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-200 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex items-center justify-between px-1 mb-1">
              <button
                onClick={() => onChange({ ...value, machineIds: filtered.map((m) => m.id) })}
                className="text-[11px] text-blue-400 hover:text-blue-300"
              >
                {t('dashFilters.selectAll', 'Tout')}
              </button>
              <button
                onClick={() => onChange({ ...value, machineIds: [] })}
                className="text-[11px] text-gray-500 hover:text-gray-300"
              >
                {t('dashFilters.clear', 'Aucun')}
              </button>
            </div>
            <div className="max-h-60 overflow-y-auto space-y-0.5">
              {filtered.length === 0 && (
                <p className="text-xs text-gray-600 text-center py-3">{t('common.noData', 'Aucune donnée')}</p>
              )}
              {filtered.map((m) => {
                const on = value.machineIds.includes(m.id);
                return (
                  <button
                    key={m.id}
                    onClick={() => toggleMachine(m.id)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-white/[0.05]"
                  >
                    <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                      on ? 'bg-blue-600 border-blue-500' : 'border-gray-600'
                    }`}>
                      {on && <Check size={11} className="text-white" />}
                    </span>
                    <span className="text-xs text-gray-200 truncate flex-1">{m.display_name || m.name}</span>
                    {m.code && <span className="text-[10px] text-gray-600 font-mono">{m.code}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
