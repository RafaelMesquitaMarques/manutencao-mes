import { useCallback, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useGridFilter } from 'ag-grid-react';
import type { CustomFilterProps } from 'ag-grid-react';
import type { IRowNode } from 'ag-grid-community';

/**
 * Excel-style checkbox ("set") filter for AG Grid Community.
 * Lists the distinct values of the column with check / uncheck boxes, a search
 * box and select-all / clear. Model = array of allowed values, or null when all
 * are selected (no filter). Self-contained — only affects its own popup.
 *
 * The value list normally comes from the rows the grid has loaded. That only
 * works with the client-side row model, where every row is loaded; a paged grid
 * would only ever offer the values on the current page. Such a column injects
 * the full list instead:
 *
 *   { field: 'status', filter: ExcelSetFilter, filterParams: { values: [...] } }
 *
 * and the rows are ignored. Without `filterParams.values` the behaviour is
 * unchanged, so the client-side callers need no edit.
 */

/**
 * Sentinel the model stores for empty cells. It is a value, not a label — the
 * displayed text is translated, this string is what travels in the filter model
 * and must stay stable for anyone mapping the model to a query.
 */
export const SET_FILTER_BLANK = '(vides)';

const keyOf = (v: unknown): string => (v == null || v === '' ? SET_FILTER_BLANK : String(v));

export default function ExcelSetFilter(props: CustomFilterProps<unknown, unknown, string[]>) {
  const { model, onModelChange, getValue, api, column, colDef } = props;
  const { t } = useTranslation();
  const [search, setSearch] = useState('');

  const blankLabel = t('grid.blanks', '(blanks)');

  // Display raw enum values (open, corrective…) through the column's own
  // valueFormatter so the checkbox list matches the localized cells. The model
  // still stores the RAW value, so filtering keeps working regardless of locale.
  const label = useCallback(
    (raw: string): string => {
      if (raw === SET_FILTER_BLANK) return blankLabel;
      const vf = column?.getColDef?.().valueFormatter;
      if (typeof vf === 'function') {
        try {
          const out = vf({ value: raw, column, api } as never);
          if (out) return String(out);
        } catch { /* fall through to raw */ }
      }
      return raw;
    },
    [column, api, blankLabel],
  );

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

  // A column that knows its own values (paged grid) hands them over; an empty
  // or missing list means "work them out from the rows", as before.
  const injected = useMemo(() => {
    const provided = (colDef?.filterParams as { values?: unknown } | undefined)?.values;
    if (!Array.isArray(provided) || provided.length === 0) return null;
    return provided.map((v) => keyOf(v));
  }, [colDef]);

  // Distinct values, computed once per grid api (stable ref => no loop).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const values = useMemo(() => {
    const set = new Set<string>();
    if (injected) {
      injected.forEach((v) => set.add(v));
    } else {
      api.forEachNode((node) => set.add(keyOf(getValue(node))));
    }
    return Array.from(set).sort((a, b) =>
      label(a).localeCompare(label(b), undefined, { numeric: true, sensitivity: 'base' }),
    );
  }, [api, label, injected]);

  const isChecked = useCallback((v: string) => model == null || model.includes(v), [model]);

  const shown = useMemo(() => {
    const q = search.toLowerCase();
    return q ? values.filter((v) => label(v).toLowerCase().includes(q)) : values;
  }, [values, search, label]);

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
        placeholder={t('grid.searchValues', 'Search…')}
        style={{ width: '100%', padding: '5px 8px', marginBottom: 6, fontSize: 12, boxSizing: 'border-box',
          background: '#1e293b', border: '1px solid #334155', borderRadius: 6, color: '#e2e8f0' }}
      />
      <div style={{ display: 'flex', gap: 10, marginBottom: 6 }}>
        <button type="button" onClick={() => onModelChange(null)}
          style={{ background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', padding: 0, fontSize: 11 }}>
          {t('grid.selectAll', 'Select all')}
        </button>
        <button type="button" onClick={() => onModelChange([])}
          style={{ background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', padding: 0, fontSize: 11 }}>
          {t('grid.clearAll', 'Clear all')}
        </button>
      </div>
      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
        {shown.length === 0 && <div style={{ color: '#64748b', padding: '6px 2px' }}>—</div>}
        {shown.map((v) => (
          <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 2px', cursor: 'pointer' }}>
            <input type="checkbox" checked={isChecked(v)} onChange={() => toggle(v)} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label(v)}>{label(v)}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
