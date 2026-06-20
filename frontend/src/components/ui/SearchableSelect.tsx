import { useState, useRef, useEffect, useMemo } from 'react';
import { Search, ChevronDown, Check, X } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;    // secondary line (e.g. code · location · department)
  search?: string;  // text matched against the query (defaults to label)
}

/** Single-select combobox with type-ahead search + keyboard nav (↑/↓/Enter/Esc).
 *  Built for long lists (hundreds of machines) where a native <select> is unusable. */
export default function SearchableSelect({
  value, onChange, options, placeholder = 'Select…', disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value) || null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => (o.search ?? o.label).toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (open) { setQuery(''); setActive(0); setTimeout(() => inputRef.current?.focus(), 0); }
  }, [open]);

  useEffect(() => { setActive(0); }, [query]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    (listRef.current.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = (o: SelectOption) => { onChange(o.value); setOpen(false); };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[active]) choose(filtered[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="input-field w-full flex items-center justify-between gap-2 text-left disabled:opacity-50"
      >
        <span className={selected ? 'text-gray-100 truncate' : 'text-gray-500'}>
          {selected ? selected.label : placeholder}
        </span>
        <span className="flex items-center gap-1 flex-shrink-0">
          {selected && (
            <X
              size={14}
              className="text-gray-500 hover:text-gray-300"
              onClick={(e) => { e.stopPropagation(); onChange(''); }}
            />
          )}
          <ChevronDown size={16} className={`text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full bg-[#0d1421] border border-white/10 rounded-lg shadow-2xl">
          <div className="p-2 border-b border-white/[0.06]">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKey}
                placeholder="Type to search…"
                className="w-full pl-8 pr-2 py-1.5 bg-[#0b1120] border border-white/10 rounded text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500/50"
              />
            </div>
          </div>
          <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-gray-600">No matches</p>
            )}
            {filtered.map((o, i) => (
              <button
                key={o.value}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(o)}
                className={`flex items-start gap-2 w-full px-3 py-2 text-left transition-colors ${
                  i === active ? 'bg-blue-600/20' : 'hover:bg-white/[0.04]'
                }`}
              >
                <Check size={14} className={`mt-0.5 flex-shrink-0 ${o.value === value ? 'text-blue-400' : 'text-transparent'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-gray-100 truncate">{o.label}</span>
                  {o.hint && <span className="block text-xs text-gray-500 truncate">{o.hint}</span>}
                </span>
              </button>
            ))}
          </div>
          <div className="px-3 py-1.5 border-t border-white/[0.06] text-[11px] text-gray-600">
            {filtered.length} / {options.length}
          </div>
        </div>
      )}
    </div>
  );
}
