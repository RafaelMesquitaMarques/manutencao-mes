import { useCallback, useState, useMemo } from 'react';
import { useGridFilter } from 'ag-grid-react';
import type { CustomFilterProps } from 'ag-grid-react';
import type { IRowNode } from 'ag-grid-community';

/**
 * Excel-style checkbox ("set") filter for AG Grid Community.
 * Lists the distinct values of the column with check / uncheck boxes, a search
 * box and select-all / clear. Model = array of allowed values, or null when all
 * are selected (no filter). Self-contained — only affects its own popup.
 */

const BLANK = '(vides)';
const keyOf = (v: unknown): string => (v == null || v === '' ? BLANK : String(v));

export default function ExcelSetFilter(props: CustomFilterProps<unknown, unknown, string[]>) {
  const { model, onModelChange, getValue, api } = props;
  const [search, setSearch] = useState('');

  const doesFilterPass = useCallback(
    ({ node }: { node: IRowNode }) => {
      if (model == null) return true;
      return model.includes(keyOf(getValue(node)));
    },
    [model, getValue],
  );

  useGridFilter({
    doesFilterPass,
    getModelAsString: (m: string[] | null) => (m ? `${m.length}` : ''),
  });

  // Distinct values, computed once per grid api (stable ref => no loop).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const values = useMemo(() => {
    const set = new Set<string>();
    api.forEachNode((node) => set.add(keyOf(getValue(node))));
    return Array.from(set).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
    );
  }, [api]);

  const isChecked = useCallback((v: string) => model == null || model.includes(v), [model]);

  const shown = useMemo(() => {
    const q = search.toLowerCase();
    return q ? values.filter((v) => v.toLowerCase().includes(q)) : values;
  }, [values, search]);

  const commit = useCallback(
    (next: string[]) => onModelChange(next.length === values.length ? null : next),
    [onModelChange, values.length],
  );

  const toggle = useCallback(
    (v: string) => {
      const current = model == null ? values : model;
      commit(current.includes(v) ? current.filter((x) => x !== v) : [...current, v]);
    },
    [model, values, commit],
  );

  return (
    <div style={{ width: 220, padding: 8, background: '#0f172a', color: '#e2e8f0', fontSize: 12 }}>
      <input
        autoFocus
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Rechercher…"
        style={{ width: '100%', padding: '5px 8px', marginBottom: 6, fontSize: 12, boxSizing: 'border-box',
          background: '#1e293b', border: '1px solid #334155', borderRadius: 6, color: '#e2e8f0' }}
      />
      <div style={{ display: 'flex', gap: 10, marginBottom: 6 }}>
        <button type="button" onClick={() => onModelChange(null)}
          style={{ background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', padding: 0, fontSize: 11 }}>
          Tout cocher
        </button>
        <button type="button" onClick={() => onModelChange([])}
          style={{ background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', padding: 0, fontSize: 11 }}>
          Tout décocher
        </button>
      </div>
      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
        {shown.length === 0 && <div style={{ color: '#64748b', padding: '6px 2px' }}>—</div>}
        {shown.map((v) => (
          <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 2px', cursor: 'pointer' }}>
            <input type="checkbox" checked={isChecked(v)} onChange={() => toggle(v)} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v}>{v}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
