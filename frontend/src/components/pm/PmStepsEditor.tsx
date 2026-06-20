import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus, Trash2, Image as ImageIcon, Video as VideoIcon, Link as LinkIcon,
  X, Loader2, ExternalLink,
} from 'lucide-react';
import type { PmTemplate, PmTemplateTask, PmTaskMedia } from '../../types';
import {
  addPmTemplateTask, updatePmTemplateTask, deletePmTemplateTask,
  addPmTaskMedia, deletePmTaskMedia, updatePmTemplate,
} from '../../api/pmTemplates';

const ENFORCEMENT_LEVELS = ['advisory', 'required', 'strict'] as const;
import { uploadFile } from '../../api/uploads';

interface Props {
  template: PmTemplate;
  onChange: () => void;
  readOnly?: boolean;
}

/**
 * Standard-operating-procedure editor for a PM template: ordered steps, each with
 * an instruction, an optional expected result, and photos / videos / external links.
 * Reused on the Equipment page (PM Templates) and on the Maintenance Plan page.
 */
export default function PmStepsEditor({ template, onChange, readOnly = false }: Props) {
  const { t } = useTranslation();
  const [newText, setNewText] = useState('');
  const [saving, setSaving] = useState(false);

  const addStep = async () => {
    if (!newText.trim()) return;
    setSaving(true);
    try {
      await addPmTemplateTask(template.id, {
        description: newText.trim(),
        sort_order: template.tasks.length,
        is_required: true,
      });
      setNewText('');
      onChange();
    } finally {
      setSaving(false);
    }
  };

  const setEnforcement = async (lvl: typeof ENFORCEMENT_LEVELS[number]) => {
    await updatePmTemplate(template.id, { enforcement: lvl });
    onChange();
  };
  const enforcement = template.enforcement ?? 'advisory';

  return (
    <div className="space-y-2.5">
      {!readOnly && (
        <div className="flex items-center gap-2 flex-wrap pb-1 border-b border-white/[0.06] mb-1">
          <span className="text-xs text-gray-500">{t('pm.enforcementLabel', 'Rigueur à la clôture de l’OT')}:</span>
          {ENFORCEMENT_LEVELS.map((lvl) => (
            <button
              key={lvl}
              type="button"
              onClick={() => setEnforcement(lvl)}
              title={t(`pm.enforcementHint.${lvl}`, '')}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                enforcement === lvl
                  ? (lvl === 'strict' ? 'text-red-300 border-red-500/50 bg-red-500/10'
                     : lvl === 'required' ? 'text-amber-300 border-amber-500/50 bg-amber-500/10'
                     : 'text-gray-300 border-white/20 bg-white/5')
                  : 'text-gray-600 border-white/10 hover:border-white/20'
              }`}
            >
              {t(`pm.enforcement.${lvl}`, lvl)}
            </button>
          ))}
        </div>
      )}

      {template.tasks.length === 0 && (
        <p className="text-gray-600 text-xs py-1">{t('pm.noTasks', 'No steps yet')}</p>
      )}

      {template.tasks.map((task, idx) => (
        <StepCard key={task.id} template={template} task={task} index={idx} onChange={onChange} readOnly={readOnly} />
      ))}

      {!readOnly && (
        <div className="flex gap-2 items-center pt-1">
          <input
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addStep(); }}
            placeholder={t('pm.newTaskPlaceholder', 'Add a step…')}
            className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-blue-500/50"
          />
          <button
            onClick={addStep}
            disabled={saving || !newText.trim()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 transition-colors"
          >
            <Plus size={14} /> {t('pm.addStep', 'Add step')}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Single step card ────────────────────────────────────────────────────────────

function StepCard({ template, task, index, onChange, readOnly }: {
  template: PmTemplate; task: PmTemplateTask; index: number; onChange: () => void; readOnly: boolean;
}) {
  const { t } = useTranslation();
  const [desc, setDesc] = useState(task.description);
  const [expected, setExpected] = useState(task.expected_result ?? '');
  const [uploading, setUploading] = useState(false);
  const [pct, setPct] = useState(0);
  const [showLink, setShowLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const saveDesc = async () => {
    const v = desc.trim();
    if (v && v !== task.description) { await updatePmTemplateTask(template.id, task.id, { description: v }); onChange(); }
  };
  const saveExpected = async () => {
    if ((expected ?? '') !== (task.expected_result ?? '')) {
      await updatePmTemplateTask(template.id, task.id, { expected_result: expected }); onChange();
    }
  };
  const toggleRequired = async () => {
    await updatePmTemplateTask(template.id, task.id, { is_required: !task.is_required }); onChange();
  };
  const removeStep = async () => { await deletePmTemplateTask(template.id, task.id); onChange(); };

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setPct(0); setErr('');
    try {
      const up = await uploadFile(file, setPct);
      await addPmTaskMedia(template.id, task.id, { media_type: up.media_type, url: up.url, sort_order: task.media.length });
      onChange();
    } catch (e2: unknown) {
      const d = (e2 as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setErr(typeof d === 'string' ? d : t('pm.uploadError', 'Upload failed'));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const addLink = async () => {
    if (!linkUrl.trim()) return;
    await addPmTaskMedia(template.id, task.id, { media_type: 'link', url: linkUrl.trim(), sort_order: task.media.length });
    setLinkUrl(''); setShowLink(false); onChange();
  };
  const delMedia = async (m: PmTaskMedia) => { await deletePmTaskMedia(template.id, task.id, m.id); onChange(); };

  return (
    <div className="rounded-xl p-3 space-y-2.5" style={{ background: '#0d1117', border: '1px solid #21262d' }}>
      <div className="flex items-start gap-3">
        <span className="mt-1.5 flex-shrink-0 w-6 h-6 rounded-full bg-blue-600/20 border border-blue-500/30 text-blue-300 text-xs font-semibold flex items-center justify-center">
          {index + 1}
        </span>

        <div className="flex-1 min-w-0 space-y-1.5">
          {readOnly ? (
            <p className="text-sm text-gray-100 font-medium">{task.description}</p>
          ) : (
            <input
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              onBlur={saveDesc}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              className="w-full bg-transparent text-sm text-gray-100 font-medium outline-none border-b border-transparent focus:border-blue-500/40 pb-0.5"
            />
          )}

          {readOnly ? (
            task.expected_result ? (
              <p className="text-xs text-gray-400">
                <span className="text-gray-600">{t('pm.expectedResult', 'Expected result')}: </span>{task.expected_result}
              </p>
            ) : null
          ) : (
            <input
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
              onBlur={saveExpected}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              placeholder={t('pm.expectedResultPlaceholder', 'Expected result (optional)…')}
              className="w-full bg-transparent text-xs text-gray-400 placeholder-gray-700 outline-none border-b border-transparent focus:border-blue-500/40 pb-0.5"
            />
          )}
        </div>

        {!readOnly && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={toggleRequired}
              className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                task.is_required
                  ? 'text-amber-400 border-amber-500/40 bg-amber-500/10'
                  : 'text-gray-600 border-gray-700/40'
              }`}>
              {task.is_required ? t('pm.required', 'Required') : t('pm.optional', 'Optional')}
            </button>
            <button onClick={removeStep} className="p-1 text-gray-600 hover:text-red-400 transition-colors">
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>

      {/* Media strip */}
      {(task.media.length > 0 || !readOnly) && (
        <div className="flex flex-wrap items-center gap-2 pl-9">
          {task.media.map((m) => (
            <MediaThumb key={m.id} m={m} onDelete={delMedia} readOnly={readOnly} />
          ))}

          {!readOnly && (
            <>
              <input ref={fileRef} type="file" accept="image/*,video/*" className="hidden" onChange={onPickFile} />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="h-20 w-20 flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-[#30363d] text-gray-500 hover:text-gray-300 hover:border-gray-500 transition-colors disabled:opacity-50"
                title={t('pm.addMedia', 'Add photo / video')}
              >
                {uploading ? (
                  <><Loader2 size={16} className="animate-spin" /><span className="text-[10px]">{pct}%</span></>
                ) : (
                  <><div className="flex gap-1"><ImageIcon size={14} /><VideoIcon size={14} /></div><span className="text-[10px]">{t('pm.addMedia', 'Photo / video')}</span></>
                )}
              </button>
              <button
                onClick={() => setShowLink((v) => !v)}
                className="h-20 w-20 flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-[#30363d] text-gray-500 hover:text-gray-300 hover:border-gray-500 transition-colors"
                title={t('pm.addLink', 'Add video link')}
              >
                <LinkIcon size={15} /><span className="text-[10px]">{t('pm.addLink', 'Link')}</span>
              </button>
            </>
          )}
        </div>
      )}

      {showLink && !readOnly && (
        <div className="flex gap-2 items-center pl-9">
          <input
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addLink(); }}
            placeholder="https://youtube.com/…  ·  https://drive.google.com/…"
            className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 outline-none focus:border-blue-500/50"
          />
          <button onClick={addLink} disabled={!linkUrl.trim()} className="px-3 py-1.5 rounded-lg text-xs bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40">
            {t('common.add', 'Add')}
          </button>
        </div>
      )}

      {err && <p className="text-red-400 text-xs pl-9">{err}</p>}
    </div>
  );
}

// ── Media thumbnail ───────────────────────────────────────────────────────────────

function MediaThumb({ m, onDelete, readOnly }: {
  m: PmTaskMedia; onDelete: (m: PmTaskMedia) => void; readOnly: boolean;
}) {
  return (
    <div className="relative group">
      {m.media_type === 'image' && (
        <a href={m.url} target="_blank" rel="noreferrer">
          <img src={m.url} alt={m.caption ?? ''} className="h-20 w-20 object-cover rounded-lg border border-[#30363d]" />
        </a>
      )}
      {m.media_type === 'video' && (
        <video src={m.url} className="h-20 w-32 rounded-lg border border-[#30363d] bg-black object-cover" controls preload="metadata" />
      )}
      {m.media_type === 'link' && (
        <a
          href={m.url} target="_blank" rel="noreferrer"
          className="flex items-start gap-1 h-20 w-32 p-2 rounded-lg border border-[#30363d] bg-[#0d1117] text-[11px] text-blue-300 hover:bg-white/5 overflow-hidden"
        >
          <ExternalLink size={13} className="shrink-0 mt-0.5" />
          <span className="break-all line-clamp-4">{m.caption || m.url}</span>
        </a>
      )}
      {!readOnly && (
        <button
          onClick={() => onDelete(m)}
          className="absolute -top-2 -right-2 bg-red-600 hover:bg-red-500 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
