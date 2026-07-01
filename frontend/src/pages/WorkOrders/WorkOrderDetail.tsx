import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Play,
  CheckCircle2,
  XCircle,
  PauseCircle,
  RotateCcw,
  Wrench,
  User,
  Calendar,
  Clock,
  Package,
  FileText,
  AlertCircle,
  RefreshCw,
  Users,
  DollarSign,
  MessageSquare,
  Info,
  Plus,
  X,
  ChevronRight,
  ListChecks,
  CheckSquare,
  Square,
  UserPlus,
  Image as ImageIcon,
  Video as VideoIcon,
  ExternalLink,
  Loader2,
  Camera,
} from 'lucide-react';
import {
  fetchWorkOrder,
  startWorkOrder,
  completeWorkOrder,
  resumeWorkOrder,
  updateWorkOrderStatus,
  fetchWOLabor,
  addWOLabor,
  fetchWOParts,
  addWOPart,
  fetchWOCosts,
  addWOCost,
  fetchWOCostSummary,
  fetchWOActions,
  addWOAction,
  toggleWOAction,
  setWOActionProof,
  fetchTechnicians,
  addWOTechnician,
  removeWOTechnician,
} from '../../api/workOrders';
import { uploadFile } from '../../api/uploads';
import { humanDuration } from '../../utils/duration';
import type {
  WorkOrder,
  LaborRecord,
  WOPart,
  WOCost,
  WOCostSummary,
  WOAction,
  Technician,
} from '../../types';
import Badge from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';

type Tab = 'overview' | 'labor' | 'parts' | 'costs' | 'timeline';

const TABS: { id: Tab; icon: typeof Info; labelKey: string }[] = [
  { id: 'overview', icon: Info, labelKey: 'workOrders.overview' },
  { id: 'labor', icon: Users, labelKey: 'workOrders.labor' },
  { id: 'parts', icon: Package, labelKey: 'workOrders.parts' },
  { id: 'costs', icon: DollarSign, labelKey: 'workOrders.costs' },
  { id: 'timeline', icon: MessageSquare, labelKey: 'workOrders.timeline' },
];

const COST_TYPES = ['local_parts', 'labor', 'external_parts', 'contracts', 'rentals', 'other'];

// Proof can be a photo or a video — detect video by the served file extension.
const PROOF_VIDEO_EXT = /\.(mp4|mov|webm|m4v|ogg|ogv|avi|mkv)(\?|#|$)/i;
const isVideoUrl = (u?: string | null): boolean => !!u && PROOF_VIDEO_EXT.test(u);

const fmt = (d?: string | null) => {
  if (!d) return '—';
  return new Date(d).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};

const fmtDate = (d?: string | null) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
};

const fmtMoney = (n?: number | null, currency = 'CAD') => {
  if (n == null) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
};

const fmtDuration = (wo: WorkOrder): string | null => {
  let seconds: number | null = null;
  if (wo.total_minutes != null && wo.total_minutes > 0) {
    seconds = wo.total_minutes * 60;
  } else if (wo.repair_hours != null && wo.repair_hours > 0) {
    seconds = wo.repair_hours * 3600;
  } else if (wo.completed_at) {
    // Fall back to elapsed time; use started_at, else opened_at (to the second).
    const start = wo.started_at ?? wo.opened_at;
    if (start) {
      const diff = (new Date(wo.completed_at).getTime() - new Date(start).getTime()) / 1000;
      if (diff > 0) seconds = diff;
    }
  }
  return seconds && seconds > 0 ? humanDuration(seconds) : null;
};

const FieldRow = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div>
    <p className="text-gray-600 text-[11px] uppercase tracking-wide mb-0.5">{label}</p>
    <div className="text-gray-200 text-sm">{value ?? <span className="text-gray-600 italic">—</span>}</div>
  </div>
);

const SectionCard = ({ icon: Icon, title, children }: {
  icon: typeof Info;
  title: string;
  children: React.ReactNode;
}) => (
  <div className="glass-card p-5">
    <div className="flex items-center gap-2 mb-4">
      <Icon size={15} className="text-gray-500" />
      <h2 className="text-white font-semibold text-sm">{title}</h2>
    </div>
    {children}
  </div>
);

// ─── PM Checklist Section ────────────────────────────────────────────────────

const ChecklistSection = ({
  woId,
  checklist,
  enforcement = 'advisory',
  onToggle,
}: {
  woId: string;
  checklist: WOAction[];
  enforcement?: 'advisory' | 'required' | 'strict';
  onToggle: (action: WOAction) => void;
}) => {
  const { t } = useTranslation();

  const total = checklist.length;
  const done = checklist.filter((a) => a.is_completed).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const badge =
    enforcement === 'strict'
      ? { cls: 'text-red-300 border-red-500/40 bg-red-500/10', label: t('pm.enforcement.strict', 'Strict + photo') }
      : enforcement === 'required'
      ? { cls: 'text-amber-300 border-amber-500/40 bg-amber-500/10', label: t('pm.enforcement.required', 'Required') }
      : { cls: 'text-gray-400 border-white/15 bg-white/5', label: t('pm.enforcement.advisory', 'Advisory') };

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <ListChecks size={15} className="text-gray-500" />
          <h2 className="text-white font-semibold text-sm">{t('pm.procedure', 'Procedure')}</h2>
          <span className={`text-[10px] px-2 py-0.5 rounded-full border ${badge.cls}`}>{badge.label}</span>
        </div>
        <span className="text-xs font-mono text-gray-500">{done}/{total}</span>
      </div>
      <div className="w-full h-1.5 bg-white/[0.06] rounded-full mb-4 overflow-hidden">
        <div className="h-full bg-green-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="space-y-2">
        {checklist.map((action, idx) => (
          <ChecklistItem
            key={action.id}
            woId={woId}
            action={action}
            index={idx}
            strict={enforcement === 'strict'}
            onUpdated={onToggle}
          />
        ))}
      </div>
    </div>
  );
};

const ChecklistItem = ({
  woId, action, index, strict, onUpdated,
}: {
  woId: string;
  action: WOAction;
  index: number;
  strict: boolean;
  onUpdated: (action: WOAction) => void;
}) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const toggle = async () => {
    setBusy(true);
    try { onUpdated(await toggleWOAction(woId, action.id, !action.is_completed)); }
    catch { /* keep UI */ } finally { setBusy(false); }
  };

  const onPickProof = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const up = await uploadFile(file);
      onUpdated(await setWOActionProof(woId, action.id, up.url));
    } catch { /* ignore */ } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const clearProof = async () => { onUpdated(await setWOActionProof(woId, action.id, null)); };

  const needsProof = strict && action.is_required && !action.proof_photo_url;

  return (
    <div className={`rounded-lg border px-3 py-2.5 ${
      action.is_completed ? 'border-white/[0.04] bg-white/[0.01]' : needsProof ? 'border-red-500/20' : 'border-white/[0.06]'
    }`}>
      <div className="flex items-start gap-2.5">
        <button onClick={toggle} disabled={busy} className="flex-shrink-0 mt-0.5 disabled:opacity-50">
          {action.is_completed
            ? <CheckSquare size={17} className="text-green-400" />
            : <Square size={17} className="text-gray-600" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-gray-600 text-xs">{index + 1}.</span>
            <span className={`text-sm ${action.is_completed ? 'text-gray-500 line-through' : 'text-gray-200'}`}>
              {action.description}
            </span>
            {action.is_required && (
              <span className="text-[10px] text-amber-400/80 border border-amber-500/25 px-1.5 py-0.5 rounded-full flex-shrink-0">
                {t('pm.required', 'Required')}
              </span>
            )}
          </div>
          {action.expected_result && (
            <p className="text-xs text-gray-500 mt-0.5">
              <span className="text-gray-600">{t('pm.expectedResult', 'Expected result')}: </span>{action.expected_result}
            </p>
          )}

          {/* SOP media (how to do it) */}
          {action.media && action.media.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {action.media.map((m) => (
                m.media_type === 'image' ? (
                  <a key={m.id} href={m.url} target="_blank" rel="noreferrer">
                    <img src={m.url} alt={m.caption ?? ''} className="h-16 w-16 object-cover rounded-lg border border-white/10" />
                  </a>
                ) : m.media_type === 'video' ? (
                  <video key={m.id} src={m.url} className="h-16 w-24 rounded-lg border border-white/10 bg-black object-cover" controls preload="metadata" />
                ) : (
                  <a key={m.id} href={m.url} target="_blank" rel="noreferrer"
                    title={m.caption ?? m.url}
                    className="flex items-center gap-1 h-16 px-2 rounded-lg border border-white/10 text-[11px] text-blue-300 hover:bg-white/5 max-w-[140px]">
                    <ExternalLink size={13} className="flex-shrink-0" />
                    <span className="line-clamp-3 break-all">{m.caption || t('pm.openDocument', 'Open')}</span>
                  </a>
                )
              ))}
            </div>
          )}

          {/* Proof photo (strict) */}
          {strict && action.is_required && (
            <div className="mt-2 flex items-center gap-2">
              {action.proof_photo_url ? (
                <div className="relative group">
                  {isVideoUrl(action.proof_photo_url) ? (
                    <video src={action.proof_photo_url} controls preload="metadata"
                      className="h-16 w-24 object-cover rounded-lg border border-green-500/40 bg-black" />
                  ) : (
                    <a href={action.proof_photo_url} target="_blank" rel="noreferrer">
                      <img src={action.proof_photo_url} alt="" className="h-16 w-16 object-cover rounded-lg border border-green-500/40" />
                    </a>
                  )}
                  <button onClick={clearProof} className="absolute -top-2 -right-2 bg-red-600 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 z-10">
                    <X size={11} />
                  </button>
                  <span className="absolute bottom-0 inset-x-0 text-[9px] text-center bg-green-600/80 text-white rounded-b-lg pointer-events-none">{t('pm.proof', 'Preuve')}</span>
                </div>
              ) : (
                <>
                  <input ref={fileRef} type="file" accept="image/*,video/*" capture="environment" className="hidden" onChange={onPickProof} />
                  <button onClick={() => fileRef.current?.click()} disabled={uploading}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-red-500/30 text-red-300 text-xs hover:bg-red-500/10 disabled:opacity-50">
                    {uploading ? <Loader2 size={13} className="animate-spin" /> : <Camera size={13} />}
                    {t('pm.addProof', 'Photo / vidéo de preuve')}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Technician notes (on the overview, reuses the timeline comment action) ──────

const NotesSection = ({ woId, notes, onAdded }: {
  woId: string; notes: WOAction[]; onAdded: (a: WOAction) => void;
}) => {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const sorted = [...notes].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const post = async () => {
    if (!text.trim()) return;
    setPosting(true);
    try {
      const a = await addWOAction(woId, { action_type: 'comment', content: text.trim() });
      onAdded(a);
      setText('');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="glass-card p-5">
      <div className="flex items-center gap-2 mb-1">
        <MessageSquare size={14} className="text-gray-500" />
        <h3 className="text-white font-semibold text-sm">{t('workOrders.technicianNotes')}</h3>
      </div>
      <p className="text-gray-600 text-xs mb-3">{t('workOrders.technicianNotesHint')}</p>
      <textarea
        rows={2}
        className="input-field resize-none w-full"
        placeholder={t('workOrders.commentPlaceholder')}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex justify-end mt-2">
        <button onClick={post} disabled={posting || !text.trim()} className="btn-primary py-1.5">
          {posting ? <Spinner size="xs" /> : <Plus size={14} />}
          {posting ? t('common.posting') : t('workOrders.addComment')}
        </button>
      </div>
      {sorted.length > 0 && (
        <div className="mt-4 space-y-2">
          {sorted.map((a) => (
            <div key={a.id} className="rounded-lg border border-white/[0.06] p-3">
              <p className="text-[11px] text-gray-500 font-mono mb-1">{fmt(a.created_at)}</p>
              <p className="text-gray-200 text-sm whitespace-pre-wrap leading-relaxed">{a.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Overview Tab ────────────────────────────────────────────────────────────

const OverviewTab = ({
  wo,
  checklist,
  notes,
  onToggleChecklist,
  onNoteAdded,
}: {
  wo: WorkOrder;
  checklist: WOAction[];
  notes: WOAction[];
  onToggleChecklist: (action: WOAction) => void;
  onNoteAdded: (a: WOAction) => void;
}) => {
  const { t } = useTranslation();

  const textFields = [
    { key: 'short_description', label: t('workOrders.shortDescription'), val: wo.short_description },
    { key: 'description', label: t('common.description'), val: wo.description },
    { key: 'root_cause', label: t('workOrders.rootCause'), val: wo.root_cause },
    { key: 'solution_applied', label: t('workOrders.solutionApplied'), val: wo.solution_applied },
  ].filter((f) => f.val);

  return (
    <div className="grid lg:grid-cols-3 gap-4">
      {/* Left — description fields */}
      <div className="lg:col-span-2 space-y-4">
        {checklist.length > 0 && (
          <ChecklistSection woId={wo.id} checklist={checklist} enforcement={wo.checklist_enforcement} onToggle={onToggleChecklist} />
        )}
        {textFields.length === 0 ? (
          <div className="glass-card p-8 text-center">
            <p className="text-gray-600 text-sm">{t('common.noData')}</p>
          </div>
        ) : (
          textFields.map(({ key, label, val }) => (
            <div key={key} className="glass-card p-5">
              <div className="flex items-center gap-2 mb-3">
                <FileText size={14} className="text-gray-500" />
                <h3 className="text-white font-semibold text-sm">{label}</h3>
              </div>
              <p className="text-gray-300 text-sm leading-relaxed whitespace-pre-wrap">{val}</p>
            </div>
          ))
        )}
        <NotesSection woId={wo.id} notes={notes} onAdded={onNoteAdded} />
      </div>

      {/* Right — metadata */}
      <div className="space-y-4">
        <SectionCard icon={Wrench} title={t('workOrders.equipment')}>
          <div className="space-y-2">
            {wo.equipment_id ? (
              <Link to={`/equipment/${wo.equipment_id}`}
                className="text-blue-400 hover:text-blue-300 text-sm font-medium flex items-center gap-1 transition-colors">
                {wo.equipment_name ?? wo.equipment_id}
                <ChevronRight size={13} />
              </Link>
            ) : (
              <p className="text-gray-200 text-sm font-medium">{wo.equipment_name ?? '—'}</p>
            )}
            {wo.equipment_location && (
              <p className="text-gray-500 text-xs">{wo.equipment_location}</p>
            )}
            {wo.tag && (
              <p className="text-gray-500 font-mono text-xs">Tag: {wo.tag}</p>
            )}
          </div>
        </SectionCard>

        {wo.ticket_id && (
          <SectionCard icon={AlertCircle} title={t('workOrders.linkedTicket')}>
            <Link to={`/tickets/${wo.ticket_id}`}
              className="text-blue-400 hover:text-blue-300 text-sm font-medium flex items-center gap-1 transition-colors">
              {wo.ticket_number ?? wo.ticket_id.slice(0, 8)}
              <ChevronRight size={13} />
            </Link>
          </SectionCard>
        )}

        <SectionCard icon={Calendar} title={t('common.date')}>
          <div className="space-y-3 text-sm">
            <FieldRow label={t('workOrders.openedAt')} value={<span className="font-mono text-xs text-gray-300">{fmt(wo.opened_at)}</span>} />
            {wo.due_date && (
              <FieldRow label={t('workOrders.dueDate')} value={<span className="font-mono text-xs text-amber-400">{fmtDate(wo.due_date)}</span>} />
            )}
            {wo.started_at && (
              <FieldRow label={t('workOrders.startedAt')} value={<span className="font-mono text-xs text-gray-300">{fmt(wo.started_at)}</span>} />
            )}
            {wo.completed_at && (
              <FieldRow label={t('workOrders.completedAt')} value={<span className="font-mono text-xs text-green-400">{fmt(wo.completed_at)}</span>} />
            )}
          </div>
        </SectionCard>

        <SectionCard icon={Clock} title={t('workOrders.hoursWorked')}>
          <div className="space-y-3">
            {(() => {
              const dur = fmtDuration(wo);
              return dur ? (
                <FieldRow label={t('workOrders.repairHours')} value={
                  <span className="font-mono text-blue-400 font-semibold text-base">{dur}</span>
                } />
              ) : (
                <p className="text-gray-600 text-sm italic">
                  {wo.status === 'in_progress' ? t('workOrders.timeInProgress') : t('workOrders.noTimeRecorded')}
                </p>
              );
            })()}
            {wo.total_cost != null && (
              <FieldRow label={t('workOrders.totalCost')} value={
                <span className="font-mono text-green-400 font-semibold">{fmtMoney(wo.total_cost)}</span>
              } />
            )}
          </div>
        </SectionCard>

        {/* Additional CMMS fields */}
        {(wo.execution_mode || wo.classification || wo.failure_code || wo.component ||
          wo.project_number || wo.cost_center) && (
          <SectionCard icon={Info} title={t('workOrders.classification')}>
            <div className="space-y-3">
              {wo.execution_mode && (
                <FieldRow label={t('workOrders.executionMode')} value={wo.execution_mode} />
              )}
              {wo.classification && (
                <FieldRow label={t('workOrders.classification')} value={wo.classification} />
              )}
              {wo.failure_code && (
                <FieldRow label={t('workOrders.failureCode')} value={<span className="font-mono text-xs">{wo.failure_code}</span>} />
              )}
              {wo.component && (
                <FieldRow label={t('workOrders.component')} value={wo.component} />
              )}
              {wo.cost_center && (
                <FieldRow label={t('workOrders.costCenter')} value={<span className="font-mono text-xs">{wo.cost_center}</span>} />
              )}
              {wo.project_number && (
                <FieldRow label={t('workOrders.projectNumber')} value={<span className="font-mono text-xs">{wo.project_number}</span>} />
              )}
            </div>
          </SectionCard>
        )}
      </div>
    </div>
  );
};

// ─── Labor Tab ───────────────────────────────────────────────────────────────

const LaborTab = ({
  woId,
  records,
  technicians,
  onAdded,
}: {
  woId: string;
  records: LaborRecord[];
  technicians: Technician[];
  onAdded: (r: LaborRecord) => void;
}) => {
  const { t } = useTranslation();
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({
    technician_id: '',
    date: new Date().toISOString().slice(0, 10),
    hours_worked: '',
    minutes_worked: '',
    hourly_rate: '',
    activity: '',
    notes: '',
  });

  const totalHours = records.reduce((s, r) => s + r.hours_worked, 0);
  const totalCost = records.reduce((s, r) => s + (r.labor_cost ?? 0), 0);

  const byTech = records.reduce<Record<string, { name: string; hours: number; cost: number }>>(
    (acc, r) => {
      const entry = acc[r.technician_id] ?? {
        name: r.technician_name ?? `${r.technician_id.slice(0, 8)}…`,
        hours: 0,
        cost: 0,
      };
      entry.hours += r.hours_worked;
      entry.cost += r.labor_cost ?? 0;
      acc[r.technician_id] = entry;
      return acc;
    },
    {}
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const hoursDecimal = Number(form.hours_worked || 0) + Number(form.minutes_worked || 0) / 60;
    if (!form.technician_id || hoursDecimal <= 0) return;
    setSubmitting(true);
    setErr(null);
    try {
      const rec = await addWOLabor(woId, {
        technician_id: form.technician_id,
        date: form.date,
        hours_worked: hoursDecimal,   // fractional → labor cost is proportional to minutes
        hourly_rate: form.hourly_rate ? Number(form.hourly_rate) : undefined,
        activity: form.activity || undefined,
        notes: form.notes || undefined,
      });
      onAdded(rec);
      setShowForm(false);
      setForm({ technician_id: '', date: new Date().toISOString().slice(0, 10), hours_worked: '', minutes_worked: '', hourly_rate: '', activity: '', notes: '' });
    } catch {
      setErr(t('common.error'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Summary + Add button */}
      <div className="flex items-center justify-between">
        <div className="flex gap-6">
          <div>
            <p className="text-gray-600 text-[11px] uppercase tracking-wide">{t('workOrders.hoursWorked')}</p>
            <p className="text-white font-mono font-semibold">{totalHours > 0 ? humanDuration(totalHours * 3600) : '0 min'}</p>
          </div>
          {totalCost > 0 && (
            <div>
              <p className="text-gray-600 text-[11px] uppercase tracking-wide">{t('workOrders.laborTotal')}</p>
              <p className="text-green-400 font-mono font-semibold">{fmtMoney(totalCost)}</p>
            </div>
          )}
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="btn-primary"
        >
          <Plus size={14} />
          {t('workOrders.addLabor')}
        </button>
      </div>

      {/* Per-technician breakdown */}
      {Object.keys(byTech).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(byTech).map(([techId, s]) => (
            <div
              key={techId}
              className="flex items-center gap-3 bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2"
            >
              <div className="w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                <User size={12} className="text-blue-400" />
              </div>
              <div>
                <p className="text-xs text-gray-300 font-medium">{s.name}</p>
                <p className="text-[11px] font-mono">
                  <span className="text-blue-400">{s.hours.toFixed(1)} {t('common.hours')}</span>
                  {s.cost > 0 && <span className="text-green-400 ml-2">{fmtMoney(s.cost)}</span>}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="glass-card p-5 space-y-4 border border-blue-500/20">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-white font-semibold text-sm">{t('workOrders.addLabor')}</h3>
            <button type="button" onClick={() => setShowForm(false)} className="text-gray-500 hover:text-gray-300">
              <X size={16} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="label">{t('workOrders.technicianLabel')} *</label>
              <select
                className="input-field"
                value={form.technician_id}
                onChange={(e) => setForm({ ...form, technician_id: e.target.value })}
                required
              >
                <option value="">{t('form.selectTechnician')}</option>
                {technicians.map((t) => (
                  <option key={t.id} value={t.id}>{t.full_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">{t('common.date')} *</label>
              <input type="date" className="input-field" value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })} required />
            </div>
            <div>
              <label className="label">{t('workOrders.timeWorked', 'Temps travaillé')} *</label>
              <div className="flex gap-2">
                <div className="flex items-center gap-1.5">
                  <input type="number" min="0" step="1" className="input-field w-20"
                    placeholder="0" value={form.hours_worked}
                    onChange={(e) => setForm({ ...form, hours_worked: e.target.value })} />
                  <span className="text-gray-500 text-sm">h</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <input type="number" min="0" max="59" step="1" className="input-field w-20"
                    placeholder="0" value={form.minutes_worked}
                    onChange={(e) => setForm({ ...form, minutes_worked: e.target.value })} />
                  <span className="text-gray-500 text-sm">min</span>
                </div>
              </div>
            </div>
            <div>
              <label className="label">{t('workOrders.rateLabel')}</label>
              <input type="number" min="0" step="0.01" className="input-field"
                placeholder="45.00" value={form.hourly_rate}
                onChange={(e) => setForm({ ...form, hourly_rate: e.target.value })} />
            </div>
            <div>
              <label className="label">{t('workOrders.activityLabel')}</label>
              <input type="text" className="input-field" placeholder={t('workOrders.activityPlaceholder')}
                value={form.activity}
                onChange={(e) => setForm({ ...form, activity: e.target.value })} />
            </div>
          </div>
          {err && <p className="text-red-400 text-xs">{err}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowForm(false)} className="btn-secondary" disabled={submitting}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? <Spinner size="xs" /> : <Plus size={14} />}
              {submitting ? t('common.adding') : t('common.add')}
            </button>
          </div>
        </form>
      )}

      {/* Table */}
      <div className="glass-card overflow-hidden">
        {records.length === 0 ? (
          <p className="text-gray-600 text-sm text-center py-10">{t('workOrders.noLabor')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.04]">
                  <th className="table-header-cell">{t('workOrders.technicianLabel')}</th>
                  <th className="table-header-cell">{t('workOrders.laborStart')}</th>
                  <th className="table-header-cell">{t('workOrders.laborEnd')}</th>
                  <th className="table-header-cell text-right">{t('workOrders.hoursWorked')}</th>
                  <th className="table-header-cell text-right">{t('workOrders.rateLabel')}</th>
                  <th className="table-header-cell text-right">{t('workOrders.totalCost')}</th>
                  <th className="table-header-cell">{t('workOrders.activityLabel')}</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => {
                  const durSecs = r.started_at && r.stopped_at
                    ? (new Date(r.stopped_at).getTime() - new Date(r.started_at).getTime()) / 1000
                    : r.hours_worked > 0 ? r.hours_worked * 3600 : null;
                  const durStr = durSecs != null ? humanDuration(durSecs) : '…';
                  return (
                    <tr key={r.id} className="table-row">
                      <td className="table-cell text-gray-200">
                        {r.technician_name ?? `${r.technician_id.slice(0, 8)}…`}
                      </td>
                      <td className="table-cell font-mono text-xs text-gray-400">
                        {r.started_at ? fmt(r.started_at) : fmtDate(r.date)}
                      </td>
                      <td className="table-cell font-mono text-xs text-gray-400">
                        {r.stopped_at ? fmt(r.stopped_at) : <span className="text-amber-400">{t('status.in_progress')}</span>}
                      </td>
                      <td className="table-cell text-right font-mono text-blue-400">{durStr}</td>
                      <td className="table-cell text-right font-mono text-gray-400 text-xs">
                        {r.hourly_rate ? `$${r.hourly_rate}/h` : '—'}
                      </td>
                      <td className="table-cell text-right font-mono text-green-400">
                        {r.labor_cost ? fmtMoney(r.labor_cost) : '—'}
                      </td>
                      <td className="table-cell text-gray-400 text-xs">{r.activity ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Intervention Parts Section (kiosk-added) ────────────────────────────────

const IPART_STYLE: Record<string, string> = {
  approved: 'bg-green-500/10 text-green-400 border-green-500/30',
  rejected: 'bg-red-500/10 text-red-400 border-red-500/30',
  pending:  'bg-amber-500/10 text-amber-400 border-amber-500/30',
};

const InterventionPartsSection = ({ wo }: { wo: WorkOrder }) => {
  const { t } = useTranslation();
  const iParts = wo.intervention_parts ?? [];
  if (iParts.length === 0) return null;
  return (
    <div className="glass-card overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2">
        <Package size={14} className="text-amber-500" />
        <span className="text-sm font-medium text-gray-300">{t('workOrders.partsViaKiosk')}</span>
        <span className="ml-auto text-xs text-gray-600 font-mono">{t('workOrders.partsCount', { count: iParts.length })}</span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/[0.04]">
            <th className="table-header-cell">{t('workOrders.code')}</th>
            <th className="table-header-cell">{t('common.description')}</th>
            <th className="table-header-cell text-right">{t('workOrders.quantity')}</th>
            <th className="table-header-cell text-center">{t('common.status')}</th>
          </tr>
        </thead>
        <tbody>
          {iParts.map((p) => (
            <tr key={p.id} className="table-row">
              <td className="table-cell font-mono text-blue-400 text-xs">{p.item_code || '—'}</td>
              <td className="table-cell text-gray-300">{p.item_description || '—'}</td>
              <td className="table-cell text-right font-mono">{p.quantity_used} {p.unit}</td>
              <td className="table-cell text-center">
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border ${IPART_STYLE[p.approval_status] ?? IPART_STYLE.pending}`}>
                  {t(`partApprovalStatus.${p.approval_status}`, p.approval_status)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ─── Parts Tab ───────────────────────────────────────────────────────────────

const PartsTab = ({
  wo,
  woId,
  parts,
  onAdded,
}: {
  wo: WorkOrder;
  woId: string;
  parts: WOPart[];
  onAdded: (p: WOPart) => void;
}) => {
  const { t } = useTranslation();
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({
    description: '',
    part_number: '',
    quantity: '1',
    unit: 'un',
    unit_cost: '',
    supplier: '',
  });

  const totalCost = parts.reduce((s, p) => s + (p.total_cost ?? 0), 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.description) return;
    setSubmitting(true);
    setErr(null);
    try {
      const part = await addWOPart(woId, {
        description: form.description,
        part_number: form.part_number || undefined,
        quantity: Number(form.quantity),
        unit: form.unit,
        unit_cost: form.unit_cost ? Number(form.unit_cost) : undefined,
        supplier: form.supplier || undefined,
      });
      onAdded(part);
      setShowForm(false);
      setForm({ description: '', part_number: '', quantity: '1', unit: 'un', unit_cost: '', supplier: '' });
    } catch {
      setErr(t('common.error'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <InterventionPartsSection wo={wo} />
      <div className="flex items-center justify-between">
        {totalCost > 0 && (
          <div>
            <p className="text-gray-600 text-[11px] uppercase tracking-wide">{t('workOrders.partsTotal')}</p>
            <p className="text-green-400 font-mono font-semibold">{fmtMoney(totalCost)}</p>
          </div>
        )}
        <div className="ml-auto">
          <button onClick={() => setShowForm(!showForm)} className="btn-primary">
            <Plus size={14} />
            {t('workOrders.addPart')}
          </button>
        </div>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="glass-card p-5 space-y-4 border border-blue-500/20">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-white font-semibold text-sm">{t('workOrders.addPart')}</h3>
            <button type="button" onClick={() => setShowForm(false)} className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="label">{t('common.description')} *</label>
              <input type="text" className="input-field" placeholder={t('workOrders.partDescriptionPlaceholder')}
                value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required />
            </div>
            <div>
              <label className="label">{t('workOrders.partNumber')}</label>
              <input type="text" className="input-field font-mono" placeholder="PN-12345"
                value={form.part_number} onChange={(e) => setForm({ ...form, part_number: e.target.value })} />
            </div>
            <div>
              <label className="label">{t('workOrders.supplier')}</label>
              <input type="text" className="input-field" placeholder={t('workOrders.supplierPlaceholder')}
                value={form.supplier} onChange={(e) => setForm({ ...form, supplier: e.target.value })} />
            </div>
            <div>
              <label className="label">{t('workOrders.quantity')} *</label>
              <input type="number" min="0.01" step="0.01" className="input-field"
                value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} required />
            </div>
            <div>
              <label className="label">{t('workOrders.unit')}</label>
              <input type="text" className="input-field" placeholder="un"
                value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
            </div>
            <div className="col-span-2">
              <label className="label">{t('workOrders.unitCost')}</label>
              <input type="number" min="0" step="0.01" className="input-field"
                placeholder="0.00" value={form.unit_cost} onChange={(e) => setForm({ ...form, unit_cost: e.target.value })} />
            </div>
          </div>
          {err && <p className="text-red-400 text-xs">{err}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowForm(false)} className="btn-secondary" disabled={submitting}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? <Spinner size="xs" /> : <Plus size={14} />}
              {submitting ? t('common.adding') : t('common.add')}
            </button>
          </div>
        </form>
      )}

      <div className="glass-card overflow-hidden">
        {parts.length === 0 ? (
          <p className="text-gray-600 text-sm text-center py-10">{t('workOrders.noParts')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.04]">
                  <th className="table-header-cell">{t('common.description')}</th>
                  <th className="table-header-cell">{t('workOrders.partNumber')}</th>
                  <th className="table-header-cell">{t('workOrders.supplier')}</th>
                  <th className="table-header-cell text-right">{t('workOrders.quantity')}</th>
                  <th className="table-header-cell text-right">{t('workOrders.unitCost')}</th>
                  <th className="table-header-cell text-right">{t('workOrders.totalCost')}</th>
                </tr>
              </thead>
              <tbody>
                {parts.map((p) => (
                  <tr key={p.id} className="table-row">
                    <td className="table-cell text-gray-200">{p.description}</td>
                    <td className="table-cell font-mono text-gray-400 text-xs">{p.part_number ?? '—'}</td>
                    <td className="table-cell text-gray-400 text-xs">{p.supplier ?? '—'}</td>
                    <td className="table-cell text-right font-mono">{p.quantity} {p.unit}</td>
                    <td className="table-cell text-right font-mono text-gray-400 text-xs">
                      {p.unit_cost != null ? fmtMoney(p.unit_cost) : '—'}
                    </td>
                    <td className="table-cell text-right font-mono text-blue-400">
                      {p.total_cost != null ? fmtMoney(p.total_cost) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Costs Tab ───────────────────────────────────────────────────────────────

const CostsTab = ({
  woId,
  costs,
  summary,
  laborRecords,
  onAdded,
}: {
  woId: string;
  costs: WOCost[];
  summary: WOCostSummary | null;
  laborRecords: LaborRecord[];
  onAdded: (c: WOCost) => void;
}) => {
  const { t } = useTranslation();
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    transaction_type: 'other',
    description: '',
    amount: '',
    currency: 'CAD',
    date: today,
    reference: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.description || !form.amount) return;
    setSubmitting(true);
    setErr(null);
    try {
      const cost = await addWOCost(woId, {
        transaction_type: form.transaction_type,
        description: form.description,
        amount: Number(form.amount),
        currency: form.currency,
        date: form.date,
        reference: form.reference || undefined,
      });
      onAdded(cost);
      setShowForm(false);
      setForm({ transaction_type: 'other', description: '', amount: '', currency: 'CAD', date: today, reference: '' });
    } catch {
      setErr(t('common.error'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      {summary && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: t('workOrders.laborTotal'), val: summary.labor_total, color: 'text-blue-400' },
              { label: t('workOrders.partsTotal'), val: summary.parts_total, color: 'text-purple-400' },
              { label: t('workOrders.otherTotal'), val: summary.other_total, color: 'text-amber-400' },
              { label: t('workOrders.grandTotal'), val: summary.grand_total, color: 'text-green-400' },
            ].map(({ label, val, color }) => (
              <div key={label} className="glass-card p-4">
                <p className="text-gray-600 text-[11px] uppercase tracking-wide mb-1">{label}</p>
                <p className={`font-mono font-semibold text-lg ${color}`}>{fmtMoney(val)}</p>
              </div>
            ))}
          </div>
          {summary.labor_total === 0 && laborRecords.length > 0 && (
            <div className="flex items-center gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
              <AlertCircle size={14} className="text-amber-400 flex-shrink-0" />
              <p className="text-amber-300 text-xs">
                {t('workOrders.noRateWarningPrefix')}<strong>{t('workOrders.noRateWarningLink')}</strong>{t('workOrders.noRateWarningSuffix')}
              </p>
            </div>
          )}
        </>
      )}

      <div className="flex justify-end">
        <button onClick={() => setShowForm(!showForm)} className="btn-primary">
          <Plus size={14} />
          {t('workOrders.addCost')}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="glass-card p-5 space-y-4 border border-blue-500/20">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-white font-semibold text-sm">{t('workOrders.addCost')}</h3>
            <button type="button" onClick={() => setShowForm(false)} className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">{t('workOrders.transactionType')}</label>
              <select className="input-field" value={form.transaction_type}
                onChange={(e) => setForm({ ...form, transaction_type: e.target.value })}>
                {COST_TYPES.map((ct) => (
                  <option key={ct} value={ct}>{t(`costType.${ct}`)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">{t('common.date')}</label>
              <input type="date" className="input-field" value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </div>
            <div className="col-span-2">
              <label className="label">{t('common.description')} *</label>
              <input type="text" className="input-field" placeholder={t('workOrders.costDescriptionPlaceholder')}
                value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required />
            </div>
            <div>
              <label className="label">{t('workOrders.amount')} *</label>
              <input type="number" min="0" step="0.01" className="input-field"
                placeholder="0.00" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
            </div>
            <div>
              <label className="label">{t('workOrders.reference')}</label>
              <input type="text" className="input-field font-mono" placeholder="PO-1234"
                value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
            </div>
          </div>
          {err && <p className="text-red-400 text-xs">{err}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowForm(false)} className="btn-secondary" disabled={submitting}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? <Spinner size="xs" /> : <Plus size={14} />}
              {submitting ? t('common.adding') : t('common.add')}
            </button>
          </div>
        </form>
      )}

      <div className="glass-card overflow-hidden">
        {costs.length === 0 ? (
          <p className="text-gray-600 text-sm text-center py-10">{t('workOrders.noCosts')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.04]">
                  <th className="table-header-cell">{t('common.date')}</th>
                  <th className="table-header-cell">{t('workOrders.transactionType')}</th>
                  <th className="table-header-cell">{t('common.description')}</th>
                  <th className="table-header-cell">{t('workOrders.reference')}</th>
                  <th className="table-header-cell text-right">{t('workOrders.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {costs.map((c) => (
                  <tr key={c.id} className="table-row">
                    <td className="table-cell font-mono text-xs text-gray-400">{fmtDate(c.date)}</td>
                    <td className="table-cell">
                      <span className="text-xs bg-white/[0.06] text-gray-300 px-2 py-0.5 rounded">
                        {t(`costType.${c.transaction_type}`)}
                      </span>
                    </td>
                    <td className="table-cell text-gray-200">{c.description}</td>
                    <td className="table-cell font-mono text-gray-500 text-xs">{c.reference ?? '—'}</td>
                    <td className="table-cell text-right font-mono text-green-400">{fmtMoney(c.amount, c.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Timeline Tab ─────────────────────────────────────────────────────────────

const ACTION_ICONS: Record<string, string> = {
  comment: '💬',
  status_change: '🔄',
  assignment: '👤',
  attachment: '📎',
};

const TimelineTab = ({
  woId,
  actions,
  onAdded,
}: {
  woId: string;
  actions: WOAction[];
  onAdded: (a: WOAction) => void;
}) => {
  const { t } = useTranslation();
  const [comment, setComment] = useState('');
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handlePost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!comment.trim()) return;
    setPosting(true);
    setErr(null);
    try {
      const action = await addWOAction(woId, { action_type: 'comment', content: comment.trim() });
      onAdded(action);
      setComment('');
    } catch {
      setErr(t('common.error'));
    } finally {
      setPosting(false);
    }
  };

  const sorted = [...actions].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return (
    <div className="space-y-4">
      {/* Comment form */}
      <form onSubmit={handlePost} className="glass-card p-4 space-y-3">
        <label className="label">{t('workOrders.addComment')}</label>
        <textarea
          rows={3}
          className="input-field resize-none"
          placeholder={t('workOrders.commentPlaceholder')}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        {err && <p className="text-red-400 text-xs">{err}</p>}
        <div className="flex justify-end">
          <button type="submit" className="btn-primary" disabled={posting || !comment.trim()}>
            {posting ? <Spinner size="xs" /> : <MessageSquare size={14} />}
            {posting ? t('common.posting') : t('workOrders.postComment')}
          </button>
        </div>
      </form>

      {/* Timeline list */}
      {sorted.length === 0 ? (
        <div className="glass-card p-8 text-center">
          <p className="text-gray-600 text-sm">{t('workOrders.noActions')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map((a) => (
            <div key={a.id} className="glass-card p-4 flex gap-3">
              <div className="w-8 h-8 rounded-full bg-white/[0.06] flex items-center justify-center flex-shrink-0 text-base">
                {ACTION_ICONS[a.action_type] ?? '📋'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-gray-500 uppercase tracking-wide">{a.action_type.replace('_', ' ')}</span>
                  <span className="text-gray-700">·</span>
                  <span className="text-gray-500 text-xs font-mono">{fmt(a.created_at)}</span>
                </div>
                {a.content && (
                  <p className="text-gray-200 text-sm leading-relaxed whitespace-pre-wrap">{a.content}</p>
                )}
                {(a.old_value || a.new_value) && (
                  <div className="flex items-center gap-2 text-xs mt-1">
                    {a.old_value && <span className="text-red-400 line-through">{a.old_value}</span>}
                    {a.old_value && a.new_value && <ChevronRight size={12} className="text-gray-600" />}
                    {a.new_value && <span className="text-green-400">{a.new_value}</span>}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Main Component ───────────────────────────────────────────────────────────

const WorkOrderDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [wo, setWo] = useState<WorkOrder | null>(null);
  const [labor, setLabor] = useState<LaborRecord[]>([]);
  const [parts, setParts] = useState<WOPart[]>([]);
  const [costs, setCosts] = useState<WOCost[]>([]);
  const [costSummary, setCostSummary] = useState<WOCostSummary | null>(null);
  const [actions, setActions] = useState<WOAction[]>([]);
  const [techOptions, setTechOptions] = useState<Technician[]>([]);

  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [isLoading, setIsLoading] = useState(true);
  const [isActioning, setIsActioning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [showAddTech, setShowAddTech] = useState(false);

  const load = async () => {
    if (!id) return;
    setIsLoading(true);
    setError(null);
    const results = await Promise.allSettled([
      fetchWorkOrder(id),
      fetchWOLabor(id),
      fetchWOParts(id),
      fetchWOCosts(id),
      fetchWOCostSummary(id),
      fetchWOActions(id),
      fetchTechnicians(),
    ]);
    if (results[0].status === 'fulfilled') setWo(results[0].value);
    else setError(t('common.error'));
    if (results[1].status === 'fulfilled') setLabor(results[1].value);
    if (results[2].status === 'fulfilled') setParts(results[2].value);
    if (results[3].status === 'fulfilled') setCosts(results[3].value);
    if (results[4].status === 'fulfilled') setCostSummary(results[4].value);
    if (results[5].status === 'fulfilled') setActions(results[5].value);
    if (results[6].status === 'fulfilled') setTechOptions(results[6].value);
    setIsLoading(false);
  };

  useEffect(() => { load(); }, [id]);

  const checklist = actions
    .filter((a) => a.action_type === 'checklist')
    .sort((a, b) => a.sort_order - b.sort_order);

  const handleToggleChecklist = (updated: WOAction) => {
    setActions((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  };

  const handleAddTech = async (techId: string) => {
    if (!wo) return;
    setActionError(null);
    try {
      const updated = await addWOTechnician(wo.id, techId);
      setWo(updated);
    } catch {
      setActionError(t('common.error'));
    }
  };

  const handleRemoveTech = async (techId: string) => {
    if (!wo) return;
    setActionError(null);
    try {
      const updated = await removeWOTechnician(wo.id, techId);
      setWo(updated);
    } catch {
      setActionError(t('common.error'));
    }
  };

  const handleAction = async (status: string) => {
    if (!wo) return;
    setIsActioning(true);
    setActionError(null);
    try {
      let updated: WorkOrder;
      if (status === 'in_progress') {
        updated = wo.status === 'on_hold' ? await resumeWorkOrder(wo.id) : await startWorkOrder(wo.id);
      } else if (status === 'completed') {
        updated = await completeWorkOrder(wo.id);
        await load(); // refresh labor records
        setIsActioning(false);
        setShowCompleteModal(false);
        return;
      } else {
        updated = await updateWorkOrderStatus(wo.id, status);
      }
      setWo(updated);
    } catch (err: unknown) {
      // Surface the backend's reason (e.g. strict checklist: missing required
      // steps or proof photos) instead of a generic error.
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setActionError(typeof detail === 'string' && detail ? detail : t('common.error'));
    } finally {
      setIsActioning(false);
      setShowCompleteModal(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error || !wo) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p className="text-red-400 text-sm">{error ?? t('common.error')}</p>
        <button onClick={load} className="btn-secondary flex items-center gap-2">
          <RefreshCw size={14} /> {t('common.retry')}
        </button>
      </div>
    );
  }

  const isTerminal = wo.status === 'completed' || wo.status === 'cancelled';

  return (
    <div className="space-y-5 animate-fade-in">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm">
        <button
          onClick={() => navigate('/work-orders')}
          className="flex items-center gap-1.5 text-gray-500 hover:text-gray-300 transition-colors"
        >
          <ArrowLeft size={15} />
          {t('workOrders.title')}
        </button>
        <span className="text-gray-700">/</span>
        <span className="text-gray-400 font-mono text-xs">{wo.wo_number}</span>
      </div>

      {/* Header + Action buttons */}
      <div className="flex flex-col md:flex-row md:items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="font-mono text-blue-400 text-sm">{wo.wo_number}</span>
            <Badge value={wo.status} variant="status" size="md" />
            <Badge value={wo.priority} variant="priority" size="md" />
            <Badge value={wo.type} variant="type" size="md" />
            {wo.from_iot && (
              <span className="text-[11px] bg-orange-500/15 text-orange-400 border border-orange-500/20 px-2 py-0.5 rounded-full">
                IoT
              </span>
            )}
          </div>
          <h1 className="text-xl font-bold text-white leading-tight">{wo.title}</h1>
          {wo.short_description && (
            <p className="text-gray-400 text-sm mt-1">{wo.short_description}</p>
          )}
        </div>

        {!isTerminal && (
          <div className="flex flex-wrap gap-2 flex-shrink-0">
            {wo.status === 'open' && (
              <button onClick={() => handleAction('in_progress')} disabled={isActioning} className="btn-success">
                {isActioning ? <Spinner size="xs" /> : <Play size={14} />}
                {t('workOrders.startWO')}
              </button>
            )}
            {wo.status === 'on_hold' && (
              <button onClick={() => handleAction('in_progress')} disabled={isActioning} className="btn-success">
                {isActioning ? <Spinner size="xs" /> : <RotateCcw size={14} />}
                {t('workOrders.resumeWO')}
              </button>
            )}
            {wo.status === 'in_progress' && (
              <>
                <button onClick={() => setShowCompleteModal(true)} disabled={isActioning} className="btn-success">
                  <CheckCircle2 size={14} />
                  {t('workOrders.completeWO')}
                </button>
                <button onClick={() => handleAction('on_hold')} disabled={isActioning} className="btn-warning">
                  <PauseCircle size={14} />
                  {t('workOrders.holdWO')}
                </button>
              </>
            )}
            {(wo.status === 'open' || wo.status === 'in_progress' || wo.status === 'on_hold') && (
              <button onClick={() => handleAction('cancelled')} disabled={isActioning} className="btn-danger">
                <XCircle size={14} />
                {t('workOrders.cancelWO')}
              </button>
            )}
          </div>
        )}
      </div>

      {actionError && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
          <AlertCircle size={14} className="text-red-400" />
          <p className="text-red-400 text-sm">{actionError}</p>
        </div>
      )}

      {/* Equipment + assignment quick-bar */}
      <div className="flex flex-wrap gap-4 text-sm">
        {wo.equipment_name && (
          <div className="flex items-center gap-2 text-gray-400">
            <Wrench size={13} className="text-gray-600" />
            {wo.equipment_id ? (
              <Link to={`/equipment/${wo.equipment_id}`} className="hover:text-blue-400 transition-colors">
                {wo.equipment_name}
              </Link>
            ) : (
              <span>{wo.equipment_name}</span>
            )}
          </div>
        )}
        <div className="flex items-center gap-2 text-gray-400 flex-wrap">
          <Users size={13} className="text-gray-600" />
          <span>{t('workOrders.assignedTechnicians')}:</span>
          {(wo.technicians ?? []).map((tech) => (
            <span
              key={tech.technician_id}
              className="inline-flex items-center gap-1.5 bg-blue-500/10 border border-blue-500/25 text-blue-300 rounded-full pl-2.5 pr-1.5 py-0.5 text-xs"
            >
              <User size={10} className="text-blue-400/70" />
              {tech.name ?? `${tech.technician_id.slice(0, 8)}…`}
              {!isTerminal && (
                <button
                  onClick={() => handleRemoveTech(tech.technician_id)}
                  className="text-blue-400/60 hover:text-red-400 transition-colors"
                >
                  <X size={12} />
                </button>
              )}
            </span>
          ))}
          {(wo.technicians ?? []).length === 0 && (
            wo.assigned_to_name
              ? <span>{wo.assigned_to_name}</span>
              : <span className="text-gray-600">—</span>
          )}
          {!isTerminal && (
            showAddTech ? (
              <select
                autoFocus
                className="input-field !w-48 !py-1 !text-xs"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) handleAddTech(e.target.value);
                  setShowAddTech(false);
                }}
                onBlur={() => setShowAddTech(false)}
              >
                <option value="">{t('form.selectTechnician')}</option>
                {techOptions
                  .filter((o) => !(wo.technicians ?? []).some((a) => a.technician_id === o.id))
                  .map((o) => (
                    <option key={o.id} value={o.id}>{o.full_name}</option>
                  ))}
              </select>
            ) : (
              <button
                onClick={() => setShowAddTech(true)}
                className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-blue-400 border border-dashed border-white/15 hover:border-blue-500/40 rounded-full px-2 py-0.5 transition-colors"
              >
                <UserPlus size={11} />
                {t('workOrders.addTechnician')}
              </button>
            )
          )}
        </div>
        {wo.cost_center && (
          <div className="flex items-center gap-2 text-gray-400">
            <DollarSign size={13} className="text-gray-600" />
            <span className="font-mono text-xs">{wo.cost_center}</span>
          </div>
        )}
        <div className="flex items-center gap-2 text-gray-500">
          <Calendar size={13} className="text-gray-600" />
          <span className="font-mono text-xs">{fmtDate(wo.opened_at)}</span>
        </div>
      </div>

      {/* Tab bar */}
      <div className="border-b border-white/[0.06]">
        <nav className="flex gap-1 -mb-px">
          {TABS.map(({ id: tabId, icon: Icon, labelKey }) => (
            <button
              key={tabId}
              onClick={() => setActiveTab(tabId)}
              className={[
                'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
                activeTab === tabId
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-300 hover:border-white/20',
              ].join(' ')}
            >
              <Icon size={14} />
              {t(labelKey)}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div className="min-h-[300px]">
        {activeTab === 'overview' && (
          <OverviewTab
            wo={wo}
            checklist={checklist}
            notes={actions.filter((a) => a.action_type === 'comment')}
            onToggleChecklist={handleToggleChecklist}
            onNoteAdded={(a) => setActions((prev) => [...prev, a])}
          />
        )}
        {activeTab === 'labor' && (
          <LaborTab
            woId={wo.id}
            records={labor}
            technicians={techOptions}
            onAdded={(r) => setLabor((prev) => [...prev, r])}
          />
        )}
        {activeTab === 'parts' && (
          <PartsTab
            wo={wo}
            woId={wo.id}
            parts={parts}
            onAdded={(p) => setParts((prev) => [...prev, p])}
          />
        )}
        {activeTab === 'costs' && (
          <CostsTab
            woId={wo.id}
            costs={costs}
            summary={costSummary}
            laborRecords={labor}
            onAdded={(c) => setCosts((prev) => [...prev, c])}
          />
        )}
        {activeTab === 'timeline' && (
          <TimelineTab
            woId={wo.id}
            actions={actions}
            onAdded={(a) => setActions((prev) => [...prev, a])}
          />
        )}
      </div>

      {/* Complete modal */}
      {showCompleteModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#111827] border border-white/10 rounded-2xl p-6 w-full max-w-sm shadow-2xl animate-slide-in">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-green-500/15 flex items-center justify-center">
                <CheckCircle2 size={20} className="text-green-400" />
              </div>
              <h3 className="text-white font-semibold">{t('workOrders.confirmComplete')}</h3>
            </div>
            <p className="text-gray-400 text-sm mb-5">
              {t('workOrders.completeTimeNote')}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowCompleteModal(false)}
                className="btn-secondary"
                disabled={isActioning}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => handleAction('completed')}
                className="btn-success"
                disabled={isActioning}
              >
                {isActioning ? <Spinner size="xs" /> : <CheckCircle2 size={14} />}
                {t('workOrders.completeWO')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WorkOrderDetail;
