import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, BookOpen, PlayCircle, UploadCloud, Archive, RotateCcw, Copy,
  Trash2, Plus, X, Loader2, Image as ImageIcon, Video as VideoIcon,
  Link as LinkIcon, ChevronUp, ChevronDown, AlertTriangle, CheckCircle2,
  ExternalLink, History, Pencil, Check,
} from 'lucide-react';
import {
  fetchSop, updateSop, publishSop, archiveSop, restoreSop, duplicateSop, deleteSop,
  addSopStep, updateSopStep, deleteSopStep, reorderSopSteps,
  addSopStepMedia, deleteSopStepMedia, fetchSopExecutions,
  startSopExecution, setSopExecutionStep, completeSopExecution, abandonSopExecution,
  type Sop, type SopCategory, type SopExecution, type SopStep,
} from '../../api/sops';
import { fetchEquipment } from '../../api/workOrders';
import { uploadFile } from '../../api/uploads';
import type { Equipment } from '../../types';
import { usePermission } from '../../hooks/usePermission';
import SopPlayer from '../../components/sops/SopPlayer';
import { CATEGORY_CHIP, STATUS_CHIP, EquipmentPicker } from './SopList';

const CATEGORIES: SopCategory[] = ['operation', 'maintenance', 'safety', 'quality', 'setup'];

export default function SopDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canUpdate = usePermission('sops', 'update');
  const canDelete = usePermission('sops', 'delete');

  const [sop, setSop] = useState<Sop | null>(null);
  const [loading, setLoading] = useState(true);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [executions, setExecutions] = useState<SopExecution[]>([]);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    if (!id) return;
    fetchSop(id)
      .then(setSop)
      .catch(() => setSop(null))
      .finally(() => setLoading(false));
    fetchSopExecutions(id).then(setExecutions).catch(() => {});
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    // Whole catalog for the link picker (the endpoint defaults to 50 rows).
    if (canUpdate) fetchEquipment({ limit: '2000' }).then(setEquipment).catch(() => {});
  }, [canUpdate]);

  const apiError = (e: any) => {
    const detail = e?.response?.data?.detail;
    setError(typeof detail === 'string' && detail.startsWith('errors.') ? t(detail) : detail || t('common.saveError', 'Error'));
  };

  const patch = async (payload: Parameters<typeof updateSop>[1]) => {
    if (!sop) return;
    setError('');
    try { setSop(await updateSop(sop.id, payload)); }
    catch (e) { apiError(e); }
  };

  const action = async (fn: (sopId: string) => Promise<Sop>) => {
    if (!sop) return;
    setBusy(true); setError('');
    try { setSop(await fn(sop.id)); }
    catch (e) { apiError(e); }
    finally { setBusy(false); }
  };

  const handleDuplicate = async () => {
    if (!sop) return;
    setBusy(true);
    try {
      const copy = await duplicateSop(sop.id);
      navigate(`/sops/${copy.id}`);
      setLoading(true);
    } catch (e) { apiError(e); }
    finally { setBusy(false); }
  };

  const handleDelete = async () => {
    if (!sop || !window.confirm(t('sops.actions.deleteConfirm', { title: sop.title }))) return;
    setBusy(true);
    try { await deleteSop(sop.id); navigate('/sops'); }
    catch (e) { apiError(e); setBusy(false); }
  };

  if (loading) {
    return <div className="min-h-screen bg-gray-950 flex items-center justify-center"><Loader2 className="animate-spin text-indigo-500" size={28} /></div>;
  }
  if (!sop) {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center gap-3 text-gray-500">
        <BookOpen size={40} className="text-gray-700" />
        {t('sops.notFound')}
        <button onClick={() => navigate('/sops')} className="text-indigo-400 hover:text-indigo-300 text-sm">{t('common.back')}</button>
      </div>
    );
  }

  return (
    <div className="flex flex-col bg-gray-950 text-gray-100 min-h-screen">
      {/* ── Header ── */}
      <div className="px-6 py-5 border-b border-gray-800 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={() => navigate('/sops')} className="p-2 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-gray-800">
            <ArrowLeft size={18} />
          </button>
          <span className="font-mono text-xs text-gray-500">{sop.sop_number}</span>
          <span className={`text-[10px] px-2 py-0.5 rounded-full border font-bold uppercase tracking-wide ${STATUS_CHIP[sop.status]}`}>
            {t(`sops.statuses.${sop.status}`)}
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded-full border border-white/15 text-gray-400 font-mono">v{sop.version}</span>
          {sop.created_by_name && (
            <span className="text-xs text-gray-600">{t('sops.fields.createdBy', { name: sop.created_by_name })}</span>
          )}

          <div className="ml-auto flex items-center gap-2 flex-wrap">
            {sop.steps.length > 0 && (
              <button
                onClick={() => setPlaying(true)}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-white bg-blue-600 hover:bg-blue-500 rounded-lg"
              >
                <PlayCircle size={16} /> {t('sops.actions.follow')}
              </button>
            )}
            {canUpdate && sop.status !== 'archived' && (
              <button
                onClick={() => action(publishSop)}
                disabled={busy || sop.steps.length === 0}
                title={sop.steps.length === 0 ? t('sops.actions.publishNeedsSteps') : undefined}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg disabled:opacity-40"
              >
                <UploadCloud size={16} /> {sop.status === 'published' ? t('sops.actions.republish') : t('sops.actions.publish')}
              </button>
            )}
            {canUpdate && sop.status !== 'archived' && (
              <button
                onClick={() => action(archiveSop)}
                disabled={busy}
                className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-300 border border-white/10 hover:bg-white/[0.05] rounded-lg"
              >
                <Archive size={15} /> {t('sops.actions.archive')}
              </button>
            )}
            {canUpdate && sop.status === 'archived' && (
              <button
                onClick={() => action(restoreSop)}
                disabled={busy}
                className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-300 border border-white/10 hover:bg-white/[0.05] rounded-lg"
              >
                <RotateCcw size={15} /> {t('sops.actions.restore')}
              </button>
            )}
            {canUpdate && (
              <button
                onClick={handleDuplicate}
                disabled={busy}
                className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-300 border border-white/10 hover:bg-white/[0.05] rounded-lg"
              >
                <Copy size={15} /> {t('sops.actions.duplicate')}
              </button>
            )}
            {canDelete && (
              <button
                onClick={handleDelete}
                disabled={busy}
                className="flex items-center gap-1.5 px-3 py-2 text-sm text-red-400 border border-red-500/30 hover:bg-red-500/10 rounded-lg"
              >
                <Trash2 size={15} /> {t('common.delete')}
              </button>
            )}
          </div>
        </div>

        <EditableTitle value={sop.title} readOnly={!canUpdate} onSave={(title) => patch({ title })} />

        <div className="flex items-start gap-6 flex-wrap">
          <div>
            <p className="text-xs text-gray-600 font-semibold uppercase tracking-wide mb-1">{t('sops.fields.category')}</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  disabled={!canUpdate}
                  onClick={() => patch({ category: c })}
                  className={`text-xs px-3 py-1.5 rounded-full border font-bold transition-colors disabled:cursor-default ${
                    sop.category === c ? CATEGORY_CHIP[c] : 'text-gray-500 border-white/10 ' + (canUpdate ? 'hover:border-white/25' : '')
                  }`}
                >
                  {t(`sops.categories.${c}`)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs text-gray-600 font-semibold uppercase tracking-wide mb-1">{t('sops.fields.estimatedMinutes')}</p>
            <MinutesInput value={sop.estimated_minutes ?? null} readOnly={!canUpdate} onSave={(v) => patch({ estimated_minutes: v })} />
          </div>
          <div className="flex-1 min-w-[260px]">
            <p className="text-xs text-gray-600 font-semibold uppercase tracking-wide mb-1">{t('sops.fields.equipment')}</p>
            {canUpdate ? (
              <EquipmentPicker
                equipment={equipment}
                selected={sop.equipment.map((e) => e.equipment_id)}
                onChange={(ids) => patch({ equipment_ids: ids })}
              />
            ) : sop.equipment.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {sop.equipment.map((e) => (
                  <span key={e.equipment_id} className="text-xs px-2.5 py-1 rounded-full border border-white/15 text-gray-300">
                    {e.equipment_name}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-600">{t('sops.fields.noEquipment')}</p>
            )}
          </div>
        </div>

        <DescriptionEditor value={sop.description ?? ''} readOnly={!canUpdate} onSave={(description) => patch({ description })} />

        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>

      {/* ── Steps ── */}
      <div className="px-6 py-5 max-w-4xl w-full space-y-3">
        <h2 className="text-white font-bold flex items-center gap-2">
          <BookOpen size={16} className="text-indigo-400" />
          {t('sops.stepsTitle')} <span className="text-gray-600 text-sm font-normal">({sop.steps.length})</span>
        </h2>
        {sop.steps.length === 0 && <p className="text-sm text-gray-600">{t('sops.editor.noSteps')}</p>}
        {sop.steps.map((step, i) => (
          <StepEditorCard
            key={step.id}
            sop={sop}
            step={step}
            index={i}
            readOnly={!canUpdate}
            onChange={load}
            onError={apiError}
          />
        ))}
        {canUpdate && <AddStepRow sop={sop} onAdded={load} />}
      </div>

      {/* ── Execution history ── */}
      <div className="px-6 pb-10 max-w-4xl w-full space-y-3">
        <h2 className="text-white font-bold flex items-center gap-2">
          <History size={16} className="text-indigo-400" /> {t('sops.history.title')}
        </h2>
        {executions.length === 0 ? (
          <p className="text-sm text-gray-600">{t('sops.history.empty')}</p>
        ) : (
          <div className="border border-gray-800 rounded-xl overflow-hidden overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 uppercase tracking-wide bg-white/[0.02]">
                  <th className="px-4 py-2.5 font-semibold">{t('sops.history.who')}</th>
                  <th className="px-4 py-2.5 font-semibold">{t('sops.history.when')}</th>
                  <th className="px-4 py-2.5 font-semibold">{t('sops.history.source')}</th>
                  <th className="px-4 py-2.5 font-semibold">{t('sops.history.progress')}</th>
                  <th className="px-4 py-2.5 font-semibold">{t('sops.history.duration')}</th>
                  <th className="px-4 py-2.5 font-semibold">{t('sops.history.status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/70">
                {executions.map((ex) => (
                  <tr key={ex.id}>
                    <td className="px-4 py-2.5 text-gray-200">{ex.operator_name ?? '—'}</td>
                    <td className="px-4 py-2.5 text-gray-400 whitespace-nowrap">
                      {ex.started_at ? new Date(ex.started_at).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-gray-400">
                      {ex.source === 'kiosk'
                        ? `${t('sops.history.kioskSource')}${ex.machine_name ? ` · ${ex.machine_name}` : ''}`
                        : t('sops.history.appSource')}
                    </td>
                    <td className="px-4 py-2.5 text-gray-400">
                      {ex.steps.filter((s) => s.checked).length}/{sop.steps.length || sop.step_count}
                    </td>
                    <td className="px-4 py-2.5 text-gray-400">
                      {ex.duration_seconds != null ? `${Math.max(1, Math.round(ex.duration_seconds / 60))} min` : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border font-bold uppercase ${
                        ex.status === 'completed' ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10'
                        : ex.status === 'in_progress' ? 'text-blue-300 border-blue-500/40 bg-blue-500/10'
                        : 'text-gray-500 border-white/10'
                      }`}>
                        {t(`sops.history.${ex.status}`)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {playing && (
        <SopPlayer
          sop={sop}
          onClose={() => setPlaying(false)}
          onExecutionEnd={load}
          execApi={{
            start: () => startSopExecution(sop.id),
            setStep: (execId, stepId, checked) => setSopExecutionStep(execId, stepId, checked),
            complete: (execId, notes) => completeSopExecution(execId, notes),
            abandon: (execId) => abandonSopExecution(execId),
          }}
        />
      )}
    </div>
  );
}

// ─── Inline editors ─────────────────────────────────────────────────────────────

function EditableTitle({ value, readOnly, onSave }: { value: string; readOnly: boolean; onSave: (v: string) => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  if (readOnly || !editing) {
    return (
      <div className="flex items-center gap-2 group">
        <h1 className="text-2xl font-black text-white leading-tight">{value}</h1>
        {!readOnly && (
          <button
            onClick={() => setEditing(true)}
            aria-label={t('common.edit')}
            className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-gray-200 p-1"
          >
            <Pencil size={15} />
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <input
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) { onSave(draft.trim()); setEditing(false); }
          if (e.key === 'Escape') { setDraft(value); setEditing(false); }
        }}
        className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xl font-black text-white focus:outline-none focus:border-indigo-500"
      />
      <button
        onClick={() => { if (draft.trim()) { onSave(draft.trim()); } setEditing(false); }}
        className="text-emerald-400 hover:text-emerald-300 p-1.5"
      >
        <Check size={18} />
      </button>
    </div>
  );
}

function MinutesInput({ value, readOnly, onSave }: { value: number | null; readOnly: boolean; onSave: (v: number | null) => void }) {
  const [draft, setDraft] = useState(value != null ? String(value) : '');
  useEffect(() => setDraft(value != null ? String(value) : ''), [value]);
  if (readOnly) return <p className="text-sm text-gray-300 py-1.5">{value != null ? `${Math.round(value)} min` : '—'}</p>;
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ''))}
      onBlur={() => onSave(draft ? Number(draft) : null)}
      inputMode="numeric"
      className="w-24 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
    />
  );
}

function DescriptionEditor({ value, readOnly, onSave }: { value: string; readOnly: boolean; onSave: (v: string) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (readOnly) {
    return value ? <p className="text-sm text-gray-400 whitespace-pre-wrap">{value}</p> : null;
  }
  return (
    <textarea
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== value) onSave(draft); }}
      rows={2}
      placeholder={t('sops.fields.descriptionPlaceholder')}
      className="w-full max-w-3xl bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:border-indigo-500 resize-y"
    />
  );
}

// ─── Step editor card ───────────────────────────────────────────────────────────

function StepEditorCard({ sop, step, index, readOnly, onChange, onError }: {
  sop: Sop; step: SopStep; index: number; readOnly: boolean;
  onChange: () => void; onError: (e: any) => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(step.title ?? '');
  const [instruction, setInstruction] = useState(step.instruction);
  const [expected, setExpected] = useState(step.expected_result ?? '');
  const [warning, setWarning] = useState(step.warning ?? '');
  const [showExtra, setShowExtra] = useState(Boolean(step.expected_result || step.warning));
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitle(step.title ?? '');
    setInstruction(step.instruction);
    setExpected(step.expected_result ?? '');
    setWarning(step.warning ?? '');
  }, [step]);

  const save = async (payload: Parameters<typeof updateSopStep>[2]) => {
    try { await updateSopStep(sop.id, step.id, payload); onChange(); }
    catch (e) { onError(e); }
  };

  const move = async (dir: -1 | 1) => {
    const ids = sop.steps.map((s) => s.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    try { await reorderSopSteps(sop.id, ids); onChange(); }
    catch (e) { onError(e); }
  };

  const remove = async () => {
    if (!window.confirm(t('sops.editor.deleteStepConfirm'))) return;
    try { await deleteSopStep(sop.id, step.id); onChange(); }
    catch (e) { onError(e); }
  };

  const onFile = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    try {
      const res = await uploadFile(file);
      await addSopStepMedia(sop.id, step.id, {
        media_type: res.media_type === 'video' ? 'video' : 'image',
        url: res.url,
        sort_order: step.media.length,
      });
      onChange();
    } catch (e) { onError(e); }
    finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const addLink = async () => {
    const url = window.prompt(t('sops.editor.linkPrompt'));
    if (!url?.trim()) return;
    const caption = window.prompt(t('sops.editor.linkCaptionPrompt')) ?? undefined;
    try {
      await addSopStepMedia(sop.id, step.id, {
        media_type: 'link', url: url.trim(), caption: caption?.trim() || undefined, sort_order: step.media.length,
      });
      onChange();
    } catch (e) { onError(e); }
  };

  const removeMedia = async (mediaId: string) => {
    try { await deleteSopStepMedia(sop.id, step.id, mediaId); onChange(); }
    catch (e) { onError(e); }
  };

  return (
    <div className="bg-[#0d1421] border border-white/[0.06] rounded-2xl p-4 space-y-3">
      <div className="flex items-start gap-3">
        <span className="w-8 h-8 shrink-0 rounded-full bg-indigo-500/15 border border-indigo-500/40 text-indigo-300 font-black text-sm flex items-center justify-center mt-0.5">
          {index + 1}
        </span>
        <div className="flex-1 min-w-0 space-y-2">
          {readOnly ? (
            <>
              {step.title && <p className="text-white font-bold">{step.title}</p>}
              <p className="text-gray-300 text-sm whitespace-pre-wrap">{step.instruction}</p>
            </>
          ) : (
            <>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => { if (title !== (step.title ?? '')) save({ title: title || null }); }}
                placeholder={t('sops.editor.stepTitlePlaceholder')}
                className="w-full bg-transparent border-b border-transparent hover:border-gray-800 focus:border-indigo-500 px-0 py-1 text-white font-bold focus:outline-none placeholder-gray-600"
              />
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onBlur={() => { if (instruction.trim() && instruction !== step.instruction) save({ instruction }); }}
                rows={2}
                placeholder={t('sops.editor.instructionPlaceholder')}
                className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500 resize-y"
              />
            </>
          )}

          {/* expected / warning */}
          {readOnly ? (
            <>
              {step.warning && (
                <p className="text-amber-300/90 text-sm flex items-start gap-1.5">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {step.warning}
                </p>
              )}
              {step.expected_result && (
                <p className="text-emerald-300/90 text-sm flex items-start gap-1.5">
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> {step.expected_result}
                </p>
              )}
            </>
          ) : showExtra ? (
            <div className="grid sm:grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-emerald-400/80 font-bold uppercase tracking-wide">{t('sops.player.expected')}</label>
                <textarea
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                  onBlur={() => { if (expected !== (step.expected_result ?? '')) save({ expected_result: expected || null }); }}
                  rows={2}
                  className="mt-0.5 w-full bg-gray-900 border border-emerald-900/50 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-emerald-500 resize-y"
                />
              </div>
              <div>
                <label className="text-[10px] text-amber-400/80 font-bold uppercase tracking-wide">{t('sops.player.warning')}</label>
                <textarea
                  value={warning}
                  onChange={(e) => setWarning(e.target.value)}
                  onBlur={() => { if (warning !== (step.warning ?? '')) save({ warning: warning || null }); }}
                  rows={2}
                  className="mt-0.5 w-full bg-gray-900 border border-amber-900/50 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-amber-500 resize-y"
                />
              </div>
            </div>
          ) : (
            <button onClick={() => setShowExtra(true)} className="text-xs text-gray-600 hover:text-gray-400">
              + {t('sops.editor.addExpectedWarning')}
            </button>
          )}

          {/* media */}
          {(step.media.length > 0 || !readOnly) && (
            <div className="flex items-center gap-2 flex-wrap pt-1">
              {step.media.map((m) => (
                <div key={m.id} className="relative group">
                  {m.media_type === 'image' ? (
                    <img src={m.url} alt={m.caption ?? ''} className="h-16 w-24 object-cover rounded-lg border border-white/10" />
                  ) : m.media_type === 'video' ? (
                    <div className="h-16 w-24 rounded-lg border border-white/10 bg-black/60 flex items-center justify-center">
                      <VideoIcon size={20} className="text-gray-400" />
                    </div>
                  ) : (
                    <a
                      href={m.url} target="_blank" rel="noreferrer"
                      className="h-16 px-3 rounded-lg border border-white/10 bg-white/[0.03] flex items-center gap-1.5 text-xs text-blue-300 max-w-[160px]"
                    >
                      <ExternalLink size={13} className="shrink-0" />
                      <span className="truncate">{m.caption || m.url}</span>
                    </a>
                  )}
                  {!readOnly && (
                    <button
                      onClick={() => removeMedia(m.id)}
                      aria-label={t('common.delete')}
                      className="absolute -top-1.5 -right-1.5 bg-red-600 hover:bg-red-500 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100"
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              ))}
              {!readOnly && (
                <div className="flex items-center gap-1.5">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*,video/*"
                    className="hidden"
                    onChange={(e) => onFile(e.target.files?.[0] ?? null)}
                  />
                  <button
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    title={t('sops.editor.addMedia')}
                    className="h-9 px-2.5 rounded-lg border border-dashed border-white/15 text-gray-500 hover:text-gray-300 hover:border-white/30 flex items-center gap-1 text-xs"
                  >
                    {uploading ? <Loader2 size={14} className="animate-spin" /> : <ImageIcon size={14} />}
                    {t('sops.editor.addMedia')}
                  </button>
                  <button
                    onClick={addLink}
                    title={t('sops.editor.addLink')}
                    className="h-9 px-2.5 rounded-lg border border-dashed border-white/15 text-gray-500 hover:text-gray-300 hover:border-white/30 flex items-center gap-1 text-xs"
                  >
                    <LinkIcon size={14} /> {t('sops.editor.addLink')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {!readOnly && (
          <div className="flex flex-col items-center gap-1 shrink-0">
            <button onClick={() => move(-1)} disabled={index === 0} className="text-gray-600 hover:text-gray-300 disabled:opacity-25 p-1"><ChevronUp size={16} /></button>
            <button onClick={() => move(1)} disabled={index === sop.steps.length - 1} className="text-gray-600 hover:text-gray-300 disabled:opacity-25 p-1"><ChevronDown size={16} /></button>
            <button
              onClick={() => save({ is_required: !step.is_required })}
              title={t('sops.editor.requiredToggle')}
              className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded border ${
                step.is_required ? 'text-amber-300 border-amber-500/50' : 'text-gray-600 border-white/10'
              }`}
            >
              {step.is_required ? t('sops.player.required') : t('sops.player.optionalStep')}
            </button>
            <button onClick={remove} className="text-gray-600 hover:text-red-400 p-1"><Trash2 size={15} /></button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Add-step row ───────────────────────────────────────────────────────────────

function AddStepRow({ sop, onAdded }: { sop: Sop; onAdded: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await addSopStep(sop.id, { instruction: text.trim(), sort_order: sop.steps.length, is_required: true });
      setText('');
      onAdded();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex gap-2 items-center">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
        placeholder={t('sops.editor.newStepPlaceholder')}
        className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
      />
      <button
        onClick={add}
        disabled={busy || !text.trim()}
        className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {t('sops.editor.addStep')}
      </button>
    </div>
  );
}
