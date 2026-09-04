import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Check, ChevronsUpDown, Filter } from 'lucide-react';

export type SortDir = 'asc' | 'desc';
export interface SortState { key: string; dir: SortDir }
export interface ColumnOption { value: string; label: string; count?: number }

interface Props {
  label: string;
  /** extra classes for the <th> (sticky, width, responsive helpers) */
  className?: string;
  /** Sorting: omit sortKey to make the column unsortable. */
  sortKey?: string;
  sortState?: SortState | null;
  onSort?: (key: string, dir: SortDir) => void;
  /** Value checklist: omit options to make the column unfilterable. */
  options?: ColumnOption[];
  selected?: string[];
  onFilter?: (values: string[]) => void;
}

const MENU_W = 232;

/**
 * Table header cell with an Excel-style menu: sort asc/desc plus a checkbox
 * list of the values present in the column. The menu is portalled to <body>
 * with fixed positioning so the scrolling/sticky table does not clip it.
 */
export default function TableColumnHeader({
  label, className = '', sortKey, sortState, onSort, options, selected = [], onFilter,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos]     = useState<{ top: number; left: number } | null>(null);
  const btnRef  = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const sortable   = !!sortKey && !!onSort;
  const filterable = !!options && !!onFilter;
  const dir        = sortable && sortState?.key === sortKey ? sortState.dir : null;
  const nFilter    = selected.length;

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const vw = document.documentElement.clientWidth  || window.innerWidth  || 0;
    const vh = document.documentElement.clientHeight || window.innerHeight || 0;
    const h  = menuRef.current?.offsetHeight ?? 340;
    let left = r.left;
    if (vw > MENU_W + 16) left = Math.max(8, Math.min(left, vw - MENU_W - 8));
    let top = r.bottom + 4;
    // Flip above the header when the menu would run past the viewport bottom.
    if (vh > 0 && top + h > vh - 8) top = Math.max(8, r.top - 4 - h);
    setPos((prev) => (prev && Math.abs(prev.top - top) < 1 && Math.abs(prev.left - left) < 1)
      ? prev            // same spot: keep the object identity so this cannot loop
      : { top, left });
  }, []);

  // Runs twice on open: once before the menu exists (estimated height), then
  // again with its real height once it is mounted.
  useLayoutEffect(() => { if (open) place(); }, [open, place, pos]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || btnRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  const handleTrigger = () => {
    // Sort-only columns toggle straight away; columns with a value list open the menu.
    if (!filterable && sortable) {
      onSort!(sortKey!, dir === 'asc' ? 'desc' : 'asc');
      return;
    }
    setQuery('');
    setOpen((o) => !o);
  };

  const applySort = (d: SortDir) => { onSort!(sortKey!, d); setOpen(false); };
  const toggle = (v: string) =>
    onFilter!(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  const shown = query
    ? options!.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options ?? [];

  return (
    <th className={`table-header-cell sticky top-0 z-10 bg-gray-900 border-b border-white/[0.06] ${className}`}>
      <button
        ref={btnRef}
        type="button"
        onClick={handleTrigger}
        disabled={!sortable && !filterable}
        title={label}
        className={`inline-flex items-center gap-1 transition-colors disabled:cursor-default ${
          nFilter || dir ? 'text-gray-100' : 'hover:text-gray-200'
        }`}
      >
        <span>{label}</span>
        {sortable && (dir === 'asc'
          ? <ArrowUp size={11} className="text-blue-400" />
          : dir === 'desc'
            ? <ArrowDown size={11} className="text-blue-400" />
            : <ChevronsUpDown size={11} className="opacity-40" />)}
        {filterable && (nFilter > 0
          ? <span className="text-[10px] font-bold leading-none px-1.5 py-0.5 rounded-full bg-blue-600 text-white">{nFilter}</span>
          : <Filter size={10} className="opacity-40" />)}
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          style={{ top: pos.top, left: pos.left, width: MENU_W }}
          className="fixed z-[100] bg-[#0d1421] border border-white/10 rounded-lg shadow-2xl p-2 normal-case tracking-normal"
        >
          {sortable && (
            <div className="space-y-0.5 pb-1.5 mb-1.5 border-b border-white/[0.06]">
              <button
                type="button"
                onClick={() => applySort('asc')}
                className={`flex items-center gap-2 w-full px-2 py-1.5 rounded text-left text-xs hover:bg-white/[0.05] transition-colors ${
                  dir === 'asc' ? 'text-blue-400' : 'text-gray-300'
                }`}
              >
                <ArrowUp size={12} /> {t('common.sortAsc')}
              </button>
              <button
                type="button"
                onClick={() => applySort('desc')}
                className={`flex items-center gap-2 w-full px-2 py-1.5 rounded text-left text-xs hover:bg-white/[0.05] transition-colors ${
                  dir === 'desc' ? 'text-blue-400' : 'text-gray-300'
                }`}
              >
                <ArrowDown size={12} /> {t('common.sortDesc')}
              </button>
            </div>
          )}

          {filterable && (
            <>
              <div className="flex items-center justify-between mb-1.5 px-1">
                <button
                  type="button"
                  onClick={() => onFilter!(options!.map((o) => o.value))}
                  className="text-[11px] text-blue-400 hover:text-blue-300"
                >
                  {t('common.selectAll')}
                </button>
                <button
                  type="button"
                  onClick={() => onFilter!([])}
                  className="text-[11px] text-gray-500 hover:text-gray-300"
                >
                  {t('common.clear')}
                </button>
              </div>
              {options!.length > 8 && (
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('common.search')}
                  className="w-full mb-1.5 px-2 py-1 bg-[#0b1120] border border-white/10 rounded text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500/50"
                />
              )}
              <div className="max-h-60 overflow-y-auto space-y-0.5">
                {shown.length === 0 && (
                  <p className="text-xs text-gray-600 px-2 py-3 text-center">{t('common.noMatches')}</p>
                )}
                {shown.map((o) => {
                  const on = selected.includes(o.value);
                  return (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => toggle(o.value)}
                      className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-left text-xs hover:bg-white/[0.05] transition-colors"
                    >
                      <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                        on ? 'bg-blue-600 border-blue-600' : 'border-white/20'
                      }`}>
                        {on && <Check size={11} className="text-white" />}
                      </span>
                      <span className={`truncate flex-1 ${on ? 'text-gray-100' : 'text-gray-400'}`}>{o.label}</span>
                      {o.count !== undefined && (
                        <span className="text-[10px] font-mono text-gray-600">{o.count}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </th>
  );
}
