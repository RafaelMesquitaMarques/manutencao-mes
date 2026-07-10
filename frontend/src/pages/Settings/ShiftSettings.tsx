import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, Plus, Trash2, AlertCircle, Save, Coffee } from 'lucide-react';
import type { ShiftTemplate, ShiftBreak, ShiftBreakKind } from '../../types';
import {
  fetchShiftTemplates, createShiftTemplate, updateShiftTemplate, deleteShiftTemplate,
} from '../../api/shifts';
import Spinner from '../../components/ui/Spinner';
import { usePermission } from '../../hooks/usePermission';

const BREAK_KINDS: ShiftBreakKind[] = ['lunch', 'break', 'pause'];
const emptyBreak = (): ShiftBreak => ({ kind: 'break', name: '', start_time: '10:00', end_time: '10:15', paid: true });

// Editable copy of a template (breaks carry a client id via array index).
type Draft = Omit<ShiftTemplate, 'id'> & { id?: string };

export default function ShiftSettings() {
  const { t } = useTranslation();
  const canEdit = usePermission('technicians', 'update');
  const [templates, setTemplates] = useState<ShiftTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = () => {
    setLoading(true);
    fetchShiftTemplates()
      .then(setTemplates)
      .catch(() => setError(t('common.error')))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const addNew = () => {
    setTemplates([...templates, {
      id: '', key: '', name: '', start_time: '08:00', end_time: '16:30', active: true, breaks: [],
    }]);
  };

  if (loading) return <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>;

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Clock size={22} className="text-blue-400" />
            {t('shiftSettings.title')}
          </h1>
          <p className="text-gray-500 text-sm mt-1">{t('shiftSettings.subtitle')}</p>
        </div>
        {canEdit && (
          <button onClick={addNew} className="btn-primary flex-shrink-0">
            <Plus size={16} /> {t('shiftSettings.newShift')}
          </button>
        )}
      </div>

      <div className="flex items-start gap-2.5 p-3 bg-blue-500/10 border border-blue-500/25 rounded-lg">
        <AlertCircle size={14} className="text-blue-400 flex-shrink-0 mt-0.5" />
        <p className="text-blue-400 text-sm">{t('shiftSettings.downtimeNote')}</p>
      </div>

      {error && (
        <div className="flex items-center gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
          <AlertCircle size={14} className="text-red-400" />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {templates.length === 0 ? (
        <p className="text-gray-600 text-sm text-center py-8">{t('shiftSettings.noShifts')}</p>
      ) : (
        templates.map((tpl, i) => (
          <ShiftCard
            key={tpl.id || `new-${i}`}
            template={tpl}
            canEdit={canEdit}
            onSaved={load}
            onDeleted={load}
            onRemoveLocal={() => setTemplates(templates.filter((_, j) => j !== i))}
          />
        ))
      )}
    </div>
  );
}

function ShiftCard({
  template, canEdit, onSaved, onDeleted, onRemoveLocal,
}: {
  template: ShiftTemplate;
  canEdit: boolean;
  onSaved: () => void;
  onDeleted: () => void;
  onRemoveLocal: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>({ ...template, breaks: template.breaks.map((b) => ({ ...b })) });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const isNew = !template.id;

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setBreak = (idx: number, patch: Partial<ShiftBreak>) =>
    set({ breaks: draft.breaks.map((b, j) => (j === idx ? { ...b, ...patch } : b)) });

  const save = async () => {
    if (!canEdit) return;
    if (!draft.key.trim()) { setErr(t('shiftSettings.keyRequired')); return; }
    setSaving(true);
    setErr('');
    const payload = {
      key: draft.key.trim(), name: draft.name, start_time: draft.start_time,
      end_time: draft.end_time, active: draft.active,
      breaks: draft.breaks.map(({ kind, name, start_time, end_time, paid }) => ({ kind, name, start_time, end_time, paid })),
    };
    try {
      if (isNew) await createShiftTemplate(payload);
      else await updateShiftTemplate(template.id, payload);
      onSaved();
    } catch {
      setErr(t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (isNew) { onRemoveLocal(); return; }
    if (!window.confirm(t('shiftSettings.deleteConfirm'))) return;
    try { await deleteShiftTemplate(template.id); onDeleted(); }
    catch { setErr(t('common.error')); }
  };

  return (
    <div className="glass-card p-5 space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <label className="label">{t('shiftSettings.key')}</label>
          <input className="input-field font-mono" placeholder="day" value={draft.key}
            disabled={!canEdit} onChange={(e) => set({ key: e.target.value })} />
        </div>
        <div>
          <label className="label">{t('shiftSettings.name')}</label>
          <input className="input-field" placeholder="Day" value={draft.name}
            disabled={!canEdit} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div>
          <label className="label">{t('shiftSettings.start')}</label>
          <input type="time" className="input-field" value={draft.start_time}
            disabled={!canEdit} onChange={(e) => set({ start_time: e.target.value })} />
        </div>
        <div>
          <label className="label">{t('shiftSettings.end')}</label>
          <input type="time" className="input-field" value={draft.end_time}
            disabled={!canEdit} onChange={(e) => set({ end_time: e.target.value })} />
        </div>
      </div>
      {draft.end_time <= draft.start_time && (
        <p className="text-amber-400 text-xs flex items-center gap-1.5">
          <Clock size={12} /> {t('shiftSettings.overnightNote')}
        </p>
      )}

      {/* Breaks */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-gray-400 text-xs uppercase tracking-wide flex items-center gap-1.5">
            <Coffee size={13} /> {t('shiftSettings.breaks')}
          </p>
          {canEdit && (
            <button onClick={() => set({ breaks: [...draft.breaks, emptyBreak()] })}
              className="text-blue-400 hover:text-blue-300 text-xs flex items-center gap-1">
              <Plus size={12} /> {t('shiftSettings.addBreak')}
            </button>
          )}
        </div>
        {draft.breaks.length === 0 ? (
          <p className="text-gray-600 text-xs">{t('shiftSettings.noBreaks')}</p>
        ) : (
          draft.breaks.map((b, idx) => (
            <div key={idx} className="flex flex-wrap items-end gap-2 p-2 bg-white/[0.02] rounded-lg">
              <div className="w-28">
                <label className="label text-[10px]">{t('shiftSettings.breakKind')}</label>
                <select className="input-field py-1.5 text-sm" value={b.kind} disabled={!canEdit}
                  onChange={(e) => setBreak(idx, { kind: e.target.value as ShiftBreakKind })}>
                  {BREAK_KINDS.map((k) => <option key={k} value={k}>{t(`breakKind.${k}`)}</option>)}
                </select>
              </div>
              <div className="flex-1 min-w-[100px]">
                <label className="label text-[10px]">{t('shiftSettings.name')}</label>
                <input className="input-field py-1.5 text-sm" value={b.name} disabled={!canEdit}
                  onChange={(e) => setBreak(idx, { name: e.target.value })} />
              </div>
              <div className="w-24">
                <label className="label text-[10px]">{t('shiftSettings.start')}</label>
                <input type="time" className="input-field py-1.5 text-sm" value={b.start_time} disabled={!canEdit}
                  onChange={(e) => setBreak(idx, { start_time: e.target.value })} />
              </div>
              <div className="w-24">
                <label className="label text-[10px]">{t('shiftSettings.end')}</label>
                <input type="time" className="input-field py-1.5 text-sm" value={b.end_time} disabled={!canEdit}
                  onChange={(e) => setBreak(idx, { end_time: e.target.value })} />
              </div>
              <label className="flex items-center gap-1.5 text-xs text-gray-400 pb-2">
                <input type="checkbox" checked={b.paid} disabled={!canEdit}
                  onChange={(e) => setBreak(idx, { paid: e.target.checked })} />
                {t('shiftSettings.paid')}
              </label>
              {canEdit && (
                <button onClick={() => set({ breaks: draft.breaks.filter((_, j) => j !== idx) })}
                  className="text-gray-500 hover:text-red-400 pb-2" title={t('common.delete')}>
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {err && <p className="text-red-400 text-sm">{err}</p>}

      {canEdit && (
        <div className="flex justify-between items-center pt-2 border-t border-white/[0.06]">
          <label className="flex items-center gap-2 text-sm text-gray-400">
            <input type="checkbox" checked={draft.active}
              onChange={(e) => set({ active: e.target.checked })} />
            {t('shiftSettings.active')}
          </label>
          <div className="flex gap-2">
            <button onClick={remove} className="btn-danger py-1.5 px-3">
              <Trash2 size={14} /> {isNew ? t('common.cancel') : t('common.delete')}
            </button>
            <button onClick={save} disabled={saving} className="btn-primary py-1.5">
              <Save size={14} /> {saving ? t('technicians.saving') : t('common.save')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
