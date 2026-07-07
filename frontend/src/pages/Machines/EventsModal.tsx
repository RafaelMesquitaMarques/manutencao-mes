import { useEffect, useMemo, useState } from 'react';
import { X, Pencil, Check, Loader2, MessageSquare, Tags } from 'lucide-react';
import type { MachineStopOut } from '../../types';
import type { RejectLogItem } from '../../api/machines';
import { stopColor } from './MachinePage';

type Tab = 'status' | 'rejects' | 'performance';
type T = Record<string, string>;

function timeOf(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function durationOf(startISO: string, endISO?: string | null): string {
  if (!endISO) return '—';
  const secs = Math.max(0, Math.round((new Date(endISO).getTime() - new Date(startISO).getTime()) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}min`;
  return `${String(m).padStart(2, '0')}min ${String(s).padStart(2, '0')}sec`;
}

function causeLabel(stop: MachineStopOut): string {
  const cat = stop.category?.name;
  const sub = stop.subcategory?.name;
  if (cat && sub) return `${cat} · ${sub}`;
  return cat || sub || '—';
}

export default function EventsModal({
  t, stops, rejects, resetKey, onClose, onEditCause, onBulkEditCause, onSaveComment,
}: {
  t: T;
  stops: MachineStopOut[];
  rejects: RejectLogItem[];
  resetKey: number;
  onClose: () => void;
  onEditCause: (stop: MachineStopOut) => void;
  onBulkEditCause: (stops: MachineStopOut[]) => void;
  onSaveComment: (stop: MachineStopOut, comment: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>('status');
  const [onlyWithComment, setOnlyWithComment] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Clear the selection once a bulk reclassify has been applied upstream.
  useEffect(() => { setSelected(new Set()); }, [resetKey]);

  // Most recent first (matches the reference app).
  const sortedStops = useMemo(
    () => [...stops].sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()),
    [stops],
  );
  const visibleStops = useMemo(
    () => (onlyWithComment ? sortedStops.filter((s) => (s.comments || '').trim()) : sortedStops),
    [sortedStops, onlyWithComment],
  );

  const startEdit = (s: MachineStopOut) => { setEditingId(s.id); setDraft(s.comments || ''); };
  const saveEdit = async (s: MachineStopOut) => {
    setSavingId(s.id);
    try {
      await onSaveComment(s, draft.trim());
      setEditingId(null);
    } finally {
      setSavingId(null);
    }
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const allVisibleSelected = visibleStops.length > 0 && visibleStops.every((s) => selected.has(s.id));
  const toggleAll = () =>
    setSelected(allVisibleSelected ? new Set() : new Set(visibleStops.map((s) => s.id)));
  const bulkEdit = () => {
    const chosen = stops.filter((s) => selected.has(s.id));
    if (chosen.length) onBulkEditCause(chosen);
  };

  const th = 'text-left text-xs font-semibold uppercase tracking-wider text-gray-400 px-4 py-3';
  const td = 'px-4 py-3 text-sm text-gray-200 align-top';

  return (
    <div className="fixed inset-0 z-40 bg-black/85 flex flex-col" onClick={onClose}>
      <div
        className="m-auto w-[min(1200px,95vw)] h-[min(88vh,900px)] flex flex-col bg-[#0d1421] rounded-2xl border border-white/[0.08] overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <h2 className="text-xl font-bold text-white">{t.eventsTitle}</h2>
          <button onClick={onClose} aria-label="close">
            <X size={26} className="text-gray-500 hover:text-gray-200" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-4 border-b border-white/[0.06]">
          <TabBtn active={tab === 'status'} onClick={() => setTab('status')} label={t.tabStatus} count={stops.length} />
          <TabBtn active={tab === 'rejects'} onClick={() => setTab('rejects')} label={t.rejects} count={rejects.length} />
          <TabBtn active={tab === 'performance'} onClick={() => setTab('performance')} label={t.tabPerformance} />
        </div>

        <div className="flex-1 overflow-auto">
          {/* ── Machine status (stops) ── */}
          {tab === 'status' && (
            <div>
              <div className="flex items-center justify-between gap-4 px-4 py-3">
                <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={onlyWithComment}
                    onChange={(e) => setOnlyWithComment(e.target.checked)}
                    className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-blue-500"
                  />
                  {t.onlyWithComment}
                </label>
                {selected.size > 0 && (
                  <button
                    onClick={bulkEdit}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
                  >
                    <Tags size={15} /> {t.changeCauseSelected.replace('{n}', String(selected.size))}
                  </button>
                )}
              </div>

              {visibleStops.length === 0 ? (
                <p className="px-4 py-10 text-center text-gray-600 text-sm">{t.noEvents}</p>
              ) : (
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 bg-[#0d1421]">
                    <tr className="border-b border-white/[0.06]">
                      <th className="w-10 px-4 py-3">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={toggleAll}
                          className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-blue-500"
                        />
                      </th>
                      <th className={th}>{t.colStart}</th>
                      <th className={th}>{t.colDuration}</th>
                      <th className={th}>{t.colOperator}</th>
                      <th className={th}>{t.colJob}</th>
                      <th className={th}>{t.colCause}</th>
                      <th className={th}>{t.colComment}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleStops.map((s) => {
                      const ongoing = !s.ended_at;
                      const color = stopColor(s);
                      const editing = editingId === s.id;
                      const isSel = selected.has(s.id);
                      return (
                        <tr
                          key={s.id}
                          className="border-b border-white/[0.04] transition-colors"
                          style={{
                            backgroundColor: color + (isSel ? '4d' : '26'),
                            boxShadow: `inset 4px 0 0 ${color}`,
                          }}
                        >
                          <td className="w-10 px-4 py-3 align-top">
                            <input
                              type="checkbox"
                              checked={isSel}
                              onChange={() => toggle(s.id)}
                              className="w-4 h-4 rounded bg-gray-800 border-gray-600 text-blue-500"
                            />
                          </td>
                          <td className={`${td} font-mono whitespace-nowrap`}>
                            {timeOf(s.started_at)}
                            {ongoing && (
                              <span className="ml-2 text-[10px] uppercase tracking-wide" style={{ color }}>{t.ongoingStop}</span>
                            )}
                          </td>
                          <td className={`${td} font-mono whitespace-nowrap text-gray-200`}>{durationOf(s.started_at, s.ended_at)}</td>
                          <td className={td}>{s.operator_name || '—'}</td>
                          <td className={`${td} font-mono`}>{s.job_number || '—'}</td>
                          {/* Cause — click to reclassify (reuses the kiosk picker) */}
                          <td className={td}>
                            <button
                              onClick={() => onEditCause(s)}
                              title={t.changeCause}
                              className="group inline-flex items-center gap-1.5 text-left rounded px-2 py-1 -mx-2 hover:bg-black/20 transition-colors"
                            >
                              <span className="font-semibold" style={{ color }}>{causeLabel(s)}</span>
                              <Pencil size={12} className="text-gray-400 group-hover:text-white" />
                            </button>
                          </td>
                          {/* Comment — inline editable */}
                          <td className={td}>
                            {editing ? (
                              <div className="flex items-center gap-1.5">
                                <input
                                  autoFocus
                                  value={draft}
                                  onChange={(e) => setDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') saveEdit(s);
                                    if (e.key === 'Escape') setEditingId(null);
                                  }}
                                  className="flex-1 min-w-[160px] bg-[#0b1120] border border-white/10 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
                                />
                                <button onClick={() => saveEdit(s)} disabled={savingId === s.id} title={t.save}
                                  className="text-gray-300 hover:text-green-300 disabled:opacity-40">
                                  {savingId === s.id ? <Loader2 size={15} className="animate-spin" /> : <Check size={16} />}
                                </button>
                                <button onClick={() => setEditingId(null)} title={t.cancel} className="text-gray-400 hover:text-white">
                                  <X size={15} />
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => startEdit(s)}
                                title={t.editComment}
                                className="group inline-flex items-center gap-1.5 text-left rounded px-2 py-1 -mx-2 hover:bg-black/20 transition-colors min-w-[120px]"
                              >
                                <span className={s.comments ? 'text-gray-100' : 'text-gray-400 italic'}>
                                  {s.comments || '—'}
                                </span>
                                <Pencil size={12} className="text-gray-400 group-hover:text-white shrink-0" />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* ── Rejects (read-only) ── */}
          {tab === 'rejects' && (
            rejects.length === 0 ? (
              <p className="px-4 py-10 text-center text-gray-600 text-sm">{t.noEvents}</p>
            ) : (
              <table className="w-full border-collapse">
                <thead className="sticky top-0 bg-[#0d1421]">
                  <tr className="border-b border-white/[0.06]">
                    <th className={th}>{t.colStart}</th>
                    <th className={th}>{t.colOperator}</th>
                    <th className={th}>{t.colCause}</th>
                    <th className={th}>{t.quantity}</th>
                    <th className={th}>{t.colComment}</th>
                  </tr>
                </thead>
                <tbody>
                  {rejects.map((r) => (
                    <tr key={r.id} className="border-b border-white/[0.04]" style={{ backgroundColor: '#ec489922', boxShadow: 'inset 4px 0 0 #ec4899' }}>
                      <td className={`${td} font-mono whitespace-nowrap`}>{timeOf(r.created_at)}</td>
                      <td className={td}>{r.operator_name || '—'}</td>
                      <td className={td}>
                        {r.category_name ? (r.subcategory_name ? `${r.category_name} · ${r.subcategory_name}` : r.category_name) : '—'}
                      </td>
                      <td className={`${td} font-mono`}>{r.quantity}</td>
                      <td className={td}>
                        <span className={r.comments ? 'text-gray-100' : 'text-gray-400 italic'}>{r.comments || '—'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {/* ── Performance (placeholder) ── */}
          {tab === 'performance' && (
            <div className="flex flex-col items-center justify-center gap-3 py-20 text-gray-600">
              <MessageSquare size={32} className="opacity-40" />
              <p className="text-sm">{t.comingSoon}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button
      onClick={onClick}
      className={`relative px-4 py-3 text-sm font-medium transition-colors ${
        active ? 'text-white' : 'text-gray-500 hover:text-gray-300'
      }`}
    >
      <span className="inline-flex items-center gap-2">
        {label}
        {count != null && count > 0 && (
          <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[11px] font-bold">
            {count}
          </span>
        )}
      </span>
      {active && <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-blue-500" />}
    </button>
  );
}
