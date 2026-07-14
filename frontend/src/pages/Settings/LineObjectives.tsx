import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Target, Palette, Globe, Plus, Loader2, Trash2, X, Check } from 'lucide-react';
import {
  fetchLineObjectives, saveLineObjective, fetchTvSettings, saveTvSettings,
  fetchGlobalObjective, saveGlobalObjective, createAssemblyLine, deleteAssemblyLine,
  SHIFT_KEYS,
  type LineObjective, type WorkPause, type TvSettings, type Shift, type ShiftKey,
} from '../../api/lineObjectives';
import { usePermission } from '../../hooks/usePermission';
import Spinner from '../../components/ui/Spinner';

const inputCls =
  'bg-[#0b1120] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500';

// Editable copy of one objective, tracked per machine id (or GLOBAL_ID). `shifts`
// is set for the per-line cards (the 3-shift grid), absent for the global clock.
type Draft = {
  cadence_per_hour: number;
  work_start: string;
  work_end: string;
  shifts?: Record<ShiftKey, Shift>;
  pauses: WorkPause[];
};

const toDraft = (l: {
  cadence_per_hour: number; work_start: string | null; work_end: string | null;
  pauses: WorkPause[]; shifts?: Record<ShiftKey, Shift>;
}): Draft => ({
  cadence_per_hour: l.cadence_per_hour,
  work_start: l.work_start ?? '',
  work_end: l.work_end ?? '',
  shifts: l.shifts
    ? (Object.fromEntries(SHIFT_KEYS.map((k) => [k, { ...l.shifts![k] }])) as Record<ShiftKey, Shift>)
    : undefined,
  pauses: l.pauses.map((p) => ({ ...p })),
});

// Drafts-map key for the GLOBAL clock (own objective, not a machine).
const GLOBAL_ID = '__global__';

export default function LineObjectives() {
  const { t } = useTranslation();
  const canEdit = usePermission('settings_machines', 'update');

  const [lines, setLines] = useState<LineObjective[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [tv, setTv] = useState<TvSettings>({ green_from: 95, amber_from: 80 });
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [savedId, setSavedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newLine, setNewLine] = useState({ name: '', code: '', cadence_per_hour: 0 });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ls, tvs, g] = await Promise.all([
        fetchLineObjectives(), fetchTvSettings(), fetchGlobalObjective(),
      ]);
      setLines(ls);
      setDrafts({
        ...Object.fromEntries(ls.map((l) => [l.machine_id, toDraft(l)])),
        [GLOBAL_ID]: toDraft(g),
      });
      setTv(tvs);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const handleSaveTv = async () => {
    setBusyId('tv'); setErr('');
    try {
      setTv(await saveTvSettings(tv));
      setSavedId('tv');
      setTimeout(() => setSavedId((s) => (s === 'tv' ? null : s)), 2500);
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setErr(detail === 'invalid_thresholds' ? t('lineObjectives.invalidThresholds') : t('common.error'));
    } finally { setBusyId(null); }
  };

  const setDraft = (id: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));

  const setPause = (id: string, i: number, patch: Partial<WorkPause>) =>
    setDrafts((d) => {
      const pauses = d[id].pauses.map((p, j) => (j === i ? { ...p, ...patch } : p));
      return { ...d, [id]: { ...d[id], pauses } };
    });

  const addPause = (id: string) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id], pauses: [...d[id].pauses, { start: '', end: '' }] } }));

  const removePause = (id: string, i: number) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id], pauses: d[id].pauses.filter((_, j) => j !== i) } }));

  const setShift = (id: string, key: ShiftKey, patch: Partial<Shift>) =>
    setDrafts((d) => {
      const cur = d[id]?.shifts;
      if (!cur) return d;
      return { ...d, [id]: { ...d[id], shifts: { ...cur, [key]: { ...cur[key], ...patch } } } };
    });

  const handleSave = async (id: string) => {
    const dr = drafts[id];
    if (!dr) return;
    setBusyId(id); setErr('');
    try {
      const body = {
        cadence_per_hour: dr.cadence_per_hour,
        work_start: dr.work_start || null,
        work_end: dr.work_end || null,
        pauses: dr.pauses.filter((p) => p.start && p.end),
        ...(dr.shifts ? { shifts: dr.shifts } : {}),
      };
      if (id === GLOBAL_ID) {
        const saved = await saveGlobalObjective(body);
        setDrafts((d) => ({ ...d, [GLOBAL_ID]: toDraft(saved) }));
      } else {
        const saved = await saveLineObjective(id, body);
        setLines((ls) => ls.map((l) => (l.machine_id === id ? saved : l)));
        setDrafts((d) => ({ ...d, [id]: toDraft(saved) }));
      }
      setSavedId(id);
      setTimeout(() => setSavedId((s) => (s === id ? null : s)), 2500);
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setErr(detail === 'invalid_time_format' ? t('lineObjectives.invalidTime')
        : detail === 'at_least_one_shift' ? t('lineObjectives.atLeastOneShift')
        : t('common.error'));
    } finally { setBusyId(null); }
  };

  // Add a line to the active plant — the kiosk/Machine is created server-side.
  const handleCreate = async () => {
    const name = newLine.name.trim();
    const code = newLine.code.trim();
    if (!name || !code) { setErr(t('lineObjectives.nameCodeRequired')); return; }
    setCreating(true); setErr('');
    try {
      const created = await createAssemblyLine({
        name, code, cadence_per_hour: Number(newLine.cadence_per_hour) || 0,
      });
      setLines((ls) => [...ls, created]);
      setDrafts((d) => ({ ...d, [created.machine_id]: toDraft(created) }));
      setNewLine({ name: '', code: '', cadence_per_hour: 0 });
      setAdding(false);
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setErr(detail === 'code_taken' ? t('lineObjectives.codeTaken')
        : detail === 'name_and_code_required' ? t('lineObjectives.nameCodeRequired')
        : t('common.error'));
    } finally { setCreating(false); }
  };

  // Remove a line (soft) — history is kept, it just leaves the lists/TVs/map.
  const handleRemove = async (l: LineObjective) => {
    if (!window.confirm(t('lineObjectives.confirmRemove', { name: l.name }))) return;
    setBusyId(l.machine_id); setErr('');
    try {
      await deleteAssemblyLine(l.machine_id);
      setLines((ls) => ls.filter((x) => x.machine_id !== l.machine_id));
      setDrafts((d) => {
        const next = { ...d };
        delete next[l.machine_id];
        return next;
      });
    } catch {
      setErr(t('common.error'));
    } finally { setBusyId(null); }
  };

  // The cadence/window/pauses editor — shared by the GLOBAL clock card and the
  // per-line cards (drafts are keyed by machine id, or GLOBAL_ID).
  const objectiveEditor = (id: string) => {
    const dr = drafts[id];
    if (!dr) return null;
    return (
      <>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <label className="space-y-1">
            <span className="text-xs text-gray-400">{t('lineObjectives.cadence')}</span>
            <input type="number" min={0} value={dr.cadence_per_hour} disabled={!canEdit}
              onChange={(e) => setDraft(id, { cadence_per_hour: Number(e.target.value) })}
              className={`${inputCls} w-full`} />
            <span className="block text-[11px] text-gray-600">{t('lineObjectives.cadenceHint')}</span>
          </label>
          {/* The GLOBAL clock keeps a single window; per-line cards use the shift grid below. */}
          {!dr.shifts && (
            <>
              <label className="space-y-1">
                <span className="text-xs text-gray-400">{t('lineObjectives.workStart')}</span>
                <input type="time" value={dr.work_start} disabled={!canEdit}
                  onChange={(e) => setDraft(id, { work_start: e.target.value })}
                  className={`${inputCls} w-full`} />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-gray-400">{t('lineObjectives.workEnd')}</span>
                <input type="time" value={dr.work_end} disabled={!canEdit}
                  onChange={(e) => setDraft(id, { work_end: e.target.value })}
                  className={`${inputCls} w-full`} />
              </label>
            </>
          )}
        </div>

        {/* Per-line shift grid: switch each shift on/off + set its window. */}
        {dr.shifts && (
          <div className="space-y-2">
            <span className="text-xs text-gray-400">{t('lineObjectives.shifts')}</span>
            <p className="text-[11px] text-gray-600 -mt-1">{t('lineObjectives.shiftsHint')}</p>
            {SHIFT_KEYS.map((key) => {
              const sh = dr.shifts![key];
              return (
                <div key={key} className="flex items-center gap-2.5 flex-wrap">
                  <button type="button" disabled={!canEdit}
                    onClick={() => setShift(id, key, { enabled: !sh.enabled })}
                    aria-pressed={sh.enabled}
                    className={`inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium border transition-colors w-40 disabled:opacity-60 ${
                      sh.enabled
                        ? 'bg-green-500/15 border-green-500/40 text-green-300'
                        : 'bg-white/[0.03] border-white/10 text-gray-500'
                    }`}>
                    <span className={`w-8 h-4 rounded-full relative transition-colors ${sh.enabled ? 'bg-green-500' : 'bg-gray-600'}`}>
                      <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${sh.enabled ? 'left-4' : 'left-0.5'}`} />
                    </span>
                    {t(`lineObjectives.shift_${key}`)}
                  </button>
                  <input type="time" value={sh.start} disabled={!canEdit || !sh.enabled}
                    onChange={(e) => setShift(id, key, { start: e.target.value })}
                    className={`${inputCls} disabled:opacity-40`} />
                  <span className="text-gray-600 text-xs">→</span>
                  <input type="time" value={sh.end} disabled={!canEdit || !sh.enabled}
                    onChange={(e) => setShift(id, key, { end: e.target.value })}
                    className={`${inputCls} disabled:opacity-40`} />
                </div>
              );
            })}
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400">{t('lineObjectives.pauses')}</span>
            {canEdit && (
              <button onClick={() => addPause(id)}
                className="inline-flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300">
                <Plus size={12} /> {t('lineObjectives.addPause')}
              </button>
            )}
          </div>
          {dr.pauses.length === 0 ? (
            <p className="text-[11px] text-gray-600">{t('lineObjectives.noPauses')}</p>
          ) : dr.pauses.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <input type="time" value={p.start} disabled={!canEdit}
                onChange={(e) => setPause(id, i, { start: e.target.value })}
                className={inputCls} />
              <span className="text-gray-600 text-xs">→</span>
              <input type="time" value={p.end} disabled={!canEdit}
                onChange={(e) => setPause(id, i, { end: e.target.value })}
                className={inputCls} />
              {canEdit && (
                <button onClick={() => removePause(id, i)}
                  className="text-gray-600 hover:text-red-400 transition-colors" title={t('common.delete')}>
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>

        {canEdit && (
          <button onClick={() => handleSave(id)} disabled={busyId === id}
            className="btn-primary py-1.5 px-4 text-sm disabled:opacity-40">
            {busyId === id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {t('common.save')}
          </button>
        )}
      </>
    );
  };

  if (loading) return <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>;

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Target size={22} className="text-blue-400" /> {t('lineObjectives.title')}
        </h1>
        <p className="text-gray-500 text-sm mt-0.5">{t('lineObjectives.subtitle')}</p>
      </div>

      {!canEdit && (
        <div className="p-3 bg-blue-500/10 border border-blue-500/25 rounded-lg">
          <p className="text-blue-300 text-sm">{t('lineObjectives.viewOnly')}</p>
        </div>
      )}
      {err && (
        <div className="flex items-center gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
          <X size={14} className="text-red-400" /><p className="text-red-400 text-sm">{err}</p>
        </div>
      )}

      {/* TV efficiency colours — plant-wide thresholds (line TVs + global header) */}
      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
            <Palette size={15} className="text-purple-400" /> {t('lineObjectives.colors')}
          </h3>
          {savedId === 'tv' && (
            <span className="inline-flex items-center gap-1.5 text-green-400 text-xs">
              <Check size={13} /> {t('common.saved')}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <label className="space-y-1">
            <span className="text-xs text-gray-400 flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-green-500 inline-block" /> {t('lineObjectives.greenFrom')}
            </span>
            <input type="number" min={0} max={200} value={tv.green_from} disabled={!canEdit}
              onChange={(e) => setTv((v) => ({ ...v, green_from: Number(e.target.value) }))}
              className={`${inputCls} w-full`} />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-gray-400 flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" /> {t('lineObjectives.amberFrom')}
            </span>
            <input type="number" min={0} max={200} value={tv.amber_from} disabled={!canEdit}
              onChange={(e) => setTv((v) => ({ ...v, amber_from: Number(e.target.value) }))}
              className={`${inputCls} w-full`} />
          </label>
          <div className="flex items-end">
            {canEdit && (
              <button onClick={handleSaveTv} disabled={busyId === 'tv'}
                className="btn-primary py-1.5 px-4 text-sm disabled:opacity-40">
                {busyId === 'tv' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {t('common.save')}
              </button>
            )}
          </div>
        </div>
        {/* the resulting scale, red included — what the TVs will apply */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-green-500/10 border border-green-500/25 text-green-400">
            <span className="w-2 h-2 rounded-full bg-green-500 inline-block" /> ≥ {tv.green_from} %
          </span>
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/25 text-amber-400">
            <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" /> ≥ {tv.amber_from} %
          </span>
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/25 text-red-400">
            <span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> {t('lineObjectives.redBelow', { pct: tv.amber_from })}
          </span>
        </div>
        <p className="text-[11px] text-gray-600">{t('lineObjectives.colorsHint')}</p>
      </div>

      {/* GLOBAL clock — its OWN objective, independent of the per-line ones */}
      <div className="bg-[#0d1421] border border-amber-500/25 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
              <Globe size={15} className="text-amber-400" /> {t('lineObjectives.globalTitle')}
            </h3>
            <p className="text-[11px] text-gray-600 mt-0.5">{t('lineObjectives.globalHint')}</p>
          </div>
          {savedId === GLOBAL_ID && (
            <span className="inline-flex items-center gap-1.5 text-green-400 text-xs">
              <Check size={13} /> {t('common.saved')}
            </span>
          )}
        </div>
        {objectiveEditor(GLOBAL_ID)}
      </div>

      {/* Per-line objectives — add / remove the plant's lines */}
      <div className="flex items-center justify-between gap-3 pt-2">
        <h3 className="text-sm font-semibold text-gray-200">{t('lineObjectives.linesTitle')}</h3>
        {canEdit && !adding && (
          <button onClick={() => { setAdding(true); setErr(''); }}
            className="inline-flex items-center gap-1.5 btn-secondary py-1.5 px-3 text-sm">
            <Plus size={14} /> {t('lineObjectives.addLine')}
          </button>
        )}
      </div>

      {adding && (
        <div className="bg-[#0d1421] border border-blue-500/25 rounded-xl p-5 space-y-4">
          <h4 className="text-sm font-semibold text-gray-200">{t('lineObjectives.newLineTitle')}</h4>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('lineObjectives.lineName')}</span>
              <input type="text" value={newLine.name} disabled={creating}
                onChange={(e) => setNewLine((n) => ({ ...n, name: e.target.value }))}
                placeholder={t('lineObjectives.lineNamePlaceholder')}
                className={`${inputCls} w-full`} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('lineObjectives.lineCode')}</span>
              <input type="text" value={newLine.code} disabled={creating}
                onChange={(e) => setNewLine((n) => ({ ...n, code: e.target.value }))}
                placeholder={t('lineObjectives.lineCodePlaceholder')}
                className={`${inputCls} w-full`} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-gray-400">{t('lineObjectives.cadence')}</span>
              <input type="number" min={0} value={newLine.cadence_per_hour} disabled={creating}
                onChange={(e) => setNewLine((n) => ({ ...n, cadence_per_hour: Number(e.target.value) }))}
                className={`${inputCls} w-full`} />
            </label>
          </div>
          <p className="text-[11px] text-gray-600">{t('lineObjectives.newLineHint')}</p>
          <div className="flex items-center gap-2">
            <button onClick={handleCreate} disabled={creating}
              className="btn-primary py-1.5 px-4 text-sm disabled:opacity-40">
              {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {t('lineObjectives.create')}
            </button>
            <button onClick={() => { setAdding(false); setErr(''); }} disabled={creating}
              className="btn-secondary py-1.5 px-4 text-sm">
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {lines.length === 0 ? (
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-5">
          <p className="text-gray-600 text-sm">{t('lineObjectives.noLines')}</p>
        </div>
      ) : lines.map((l) => (
        <div key={l.machine_id} className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-gray-200">
              {l.name}
              {l.code && <span className="ml-2 text-[11px] text-gray-600 font-mono">{l.code}</span>}
            </h3>
            <div className="flex items-center gap-3">
              {savedId === l.machine_id && (
                <span className="inline-flex items-center gap-1.5 text-green-400 text-xs">
                  <Check size={13} /> {t('common.saved')}
                </span>
              )}
              {canEdit && (
                <button onClick={() => handleRemove(l)} disabled={busyId === l.machine_id}
                  title={t('lineObjectives.removeLine')}
                  className="text-gray-600 hover:text-red-400 transition-colors disabled:opacity-40">
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          </div>
          {objectiveEditor(l.machine_id)}
        </div>
      ))}

      <p className="text-xs text-gray-600">{t('lineObjectives.note')}</p>
    </div>
  );
}
