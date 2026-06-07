import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, Play, CheckCircle2, XCircle, PauseCircle,
  Package, MessageSquare, Info, Clock, ChevronRight, Wrench,
} from 'lucide-react';
import {
  fetchTicket, updateTicketStatus, closeTicket, addTicketComment, generateWorkOrder,
} from '../../api/maintenance';
import type { MaintenanceTicket, TicketComment, TicketStatus, PartUsed } from '../../types';
import Spinner from '../../components/ui/Spinner';
import { useAuthStore } from '../../store/authStore';

type Tab = 'details' | 'comments' | 'parts' | 'workorder';

const STATUS_BADGE: Record<TicketStatus, string> = {
  open:          'bg-blue-500/15 text-blue-400 border-blue-500/25',
  in_progress:   'bg-amber-500/15 text-amber-400 border-amber-500/25',
  on_hold_parts: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
  on_hold_ext:   'bg-pink-500/15 text-pink-400 border-pink-500/25',
  completed:     'bg-green-500/15 text-green-400 border-green-500/25',
  cancelled:     'bg-gray-500/15 text-gray-400 border-gray-500/25',
};

const PRIORITY_BADGE: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-400 border-red-500/25',
  high:     'bg-orange-500/15 text-orange-400 border-orange-500/25',
  medium:   'bg-sky-500/15 text-sky-400 border-sky-500/25',
  low:      'bg-gray-500/15 text-gray-400 border-gray-500/25',
};

const fmt = (d?: string | null) => {
  if (!d) return '—';
  return new Date(d).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};

export default function TicketDetail() {
  const { t }    = useTranslation();
  const { id }   = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user     = useAuthStore((s) => s.user);

  const [ticket, setTicket]     = useState<MaintenanceTicket | null>(null);
  const [loading, setLoading]   = useState(true);
  const [tab, setTab]           = useState<Tab>('details');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  // Close form state
  const [showClose, setShowClose]   = useState(false);
  const [diagnosis, setDiagnosis]   = useState('');
  const [corrective, setCorrective] = useState('');
  const [intMins, setIntMins]       = useState('');
  const [downMins, setDownMins]     = useState('');

  // Comment state
  const [commentText, setCommentText]     = useState('');
  const [commentAuthor, setCommentAuthor] = useState(user?.name ?? '');
  const [postingComment, setPostingComment] = useState(false);

  // Parts state
  const [newPartName, setNewPartName] = useState('');
  const [newPartQty, setNewPartQty]   = useState('1');
  const [newPartUnit, setNewPartUnit] = useState('');
  const [newPartNo, setNewPartNo]     = useState('');

  // WO generation state
  const [generatingWO, setGeneratingWO] = useState(false);
  const [woError, setWoError]           = useState('');

  useEffect(() => {
    if (!id) return;
    fetchTicket(id).then((t) => {
      setTicket(t);
      setDiagnosis(t.diagnosis ?? '');
      setCorrective(t.corrective_action ?? '');
      setIntMins(String(t.total_intervention_minutes ?? ''));
      setDownMins(String(t.estimated_downtime_minutes ?? ''));
    }).finally(() => setLoading(false));
  }, [id]);

  const doStatus = async (status: TicketStatus) => {
    if (!ticket || !id) return;
    setSaving(true);
    try {
      const updated = await updateTicketStatus(id, { status });
      setTicket(updated);
    } finally {
      setSaving(false);
    }
  };

  const doSaveDiagnosis = async () => {
    if (!id) return;
    setSaving(true);
    try {
      const updated = await updateTicketStatus(id, {
        diagnosis,
        corrective_action: corrective,
        total_intervention_minutes: intMins ? parseInt(intMins) : undefined,
        estimated_downtime_minutes: downMins ? parseInt(downMins) : undefined,
      });
      setTicket(updated);
    } finally {
      setSaving(false);
    }
  };

  const doClose = async () => {
    if (!id || !diagnosis || !corrective || !intMins) {
      setError(t('tickets.closeRequiredFields'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const updated = await closeTicket(id, {
        diagnosis,
        corrective_action: corrective,
        total_intervention_minutes: parseInt(intMins),
        estimated_downtime_minutes: downMins ? parseInt(downMins) : undefined,
        parts_used: ticket?.parts_used ?? [],
      });
      setTicket(updated);
      setShowClose(false);
    } finally {
      setSaving(false);
    }
  };

  const doAddComment = async () => {
    if (!id || !commentText || !commentAuthor) return;
    setPostingComment(true);
    try {
      const comment = await addTicketComment(id, { author: commentAuthor, comment: commentText });
      setTicket((prev) => prev ? {
        ...prev,
        comments: [...(prev.comments ?? []), comment],
      } : prev);
      setCommentText('');
    } finally {
      setPostingComment(false);
    }
  };

  const doAddPart = async () => {
    if (!id || !newPartName) return;
    const part: PartUsed = {
      name: newPartName,
      qty: parseFloat(newPartQty) || 1,
      unit: newPartUnit || undefined,
      part_no: newPartNo || undefined,
    };
    const currentParts = ticket?.parts_used ?? [];
    const updated = await updateTicketStatus(id, { parts_used: [...currentParts, part] });
    setTicket(updated);
    setNewPartName(''); setNewPartQty('1'); setNewPartUnit(''); setNewPartNo('');
  };

  const doGenerateWO = async () => {
    if (!id) return;
    setGeneratingWO(true);
    setWoError('');
    try {
      const result = await generateWorkOrder(id);
      setTicket(result.ticket);
    } catch (e: unknown) {
      setWoError(e instanceof Error ? e.message : 'Failed to generate work order');
    } finally {
      setGeneratingWO(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!ticket) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <p className="text-gray-400">{t('tickets.notFound')}</p>
        <button onClick={() => navigate('/tickets')} className="btn-secondary">
          <ArrowLeft size={14} /> {t('common.back')}
        </button>
      </div>
    );
  }

  const isActive = ticket.status !== 'completed' && ticket.status !== 'cancelled';

  return (
    <div className="p-6 space-y-4 animate-fade-in max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start gap-3 flex-wrap">
        <button onClick={() => navigate('/tickets')} className="btn-secondary py-1.5 px-3 mt-0.5">
          <ArrowLeft size={15} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <h1 className="text-2xl font-bold text-white font-mono">{ticket.ticket_number}</h1>
            <span className={`inline-flex items-center px-2 py-0.5 text-xs font-mono font-medium border rounded ${PRIORITY_BADGE[ticket.priority]}`}>
              {t(`priority.${ticket.priority}`)}
            </span>
            <span className={`inline-flex items-center px-2 py-0.5 text-xs font-mono font-medium border rounded ${STATUS_BADGE[ticket.status]}`}>
              {t(`ticketStatus.${ticket.status}`, ticket.status)}
            </span>
            {ticket.current_escalation_level > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 text-xs font-mono font-medium border rounded bg-red-500/15 text-red-400 border-red-500/25">
                ESC L{ticket.current_escalation_level}
              </span>
            )}
          </div>
          <p className="text-gray-400 text-sm">{ticket.machine_name ?? '—'}</p>
        </div>

        {/* Action buttons */}
        {isActive && (
          <div className="flex gap-2 flex-wrap">
            {ticket.status === 'open' && (
              <button onClick={() => doStatus('in_progress')} disabled={saving} className="btn-success">
                <Play size={14} /> {t('tickets.start')}
              </button>
            )}
            {(ticket.status === 'on_hold_parts' || ticket.status === 'on_hold_ext') && (
              <button onClick={() => doStatus('in_progress')} disabled={saving} className="btn-success">
                <Play size={14} /> {t('tickets.resume')}
              </button>
            )}
            {ticket.status === 'in_progress' && (
              <>
                <button onClick={() => doStatus('on_hold_parts')} disabled={saving} className="btn-warning">
                  <Package size={14} /> {t('tickets.holdParts')}
                </button>
                <button onClick={() => doStatus('on_hold_ext')} disabled={saving} className="btn-warning">
                  <PauseCircle size={14} /> {t('tickets.holdExt')}
                </button>
              </>
            )}
            <button onClick={() => setShowClose(true)} disabled={saving} className="btn-success">
              <CheckCircle2 size={14} /> {t('tickets.close')}
            </button>
            <button onClick={() => doStatus('cancelled')} disabled={saving} className="btn-danger">
              <XCircle size={14} /> {t('tickets.cancel')}
            </button>
          </div>
        )}
      </div>

      {/* Close form */}
      {showClose && (
        <div className="glass-card p-5 border border-green-500/20 space-y-4">
          <h3 className="text-white font-semibold flex items-center gap-2">
            <CheckCircle2 size={16} className="text-green-400" />
            {t('tickets.closeTicket')}
          </h3>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <div>
            <label className="label">{t('tickets.diagnosis')} *</label>
            <textarea value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} rows={2} className="input-field resize-none" />
          </div>
          <div>
            <label className="label">{t('tickets.correctiveAction')} *</label>
            <textarea value={corrective} onChange={(e) => setCorrective(e.target.value)} rows={2} className="input-field resize-none" />
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">{t('tickets.interventionMinutes')} *</label>
              <input type="number" value={intMins} onChange={(e) => setIntMins(e.target.value)} className="input-field" min="0" />
            </div>
            <div>
              <label className="label">{t('tickets.downtimeMinutes')}</label>
              <input type="number" value={downMins} onChange={(e) => setDownMins(e.target.value)} className="input-field" min="0" />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowClose(false)} className="btn-secondary">{t('common.cancel')}</button>
            <button onClick={doClose} disabled={saving} className="btn-success">
              <CheckCircle2 size={14} /> {t('tickets.confirmClose')}
            </button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-white/[0.06]">
        {([
          { id: 'details',   icon: Info,           label: 'tickets.tabDetails' },
          { id: 'comments',  icon: MessageSquare,  label: 'tickets.tabComments' },
          { id: 'parts',     icon: Package,        label: 'tickets.tabParts' },
          { id: 'workorder', icon: Wrench,         label: 'supervisor.tabWorkOrder' },
        ] as const).map(({ id: tid, icon: Icon, label }) => (
          <button
            key={tid}
            onClick={() => setTab(tid)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === tid
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            <Icon size={14} />
            {t(label)}
          </button>
        ))}
      </div>

      {/* Tab: Details */}
      {tab === 'details' && (
        <div className="space-y-4">
          {/* Info grid */}
          <div className="glass-card p-5 grid sm:grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">{t('tickets.openedAt')}</p>
              <p className="text-gray-200 text-sm">{fmt(ticket.opened_at)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">{t('tickets.startedAt')}</p>
              <p className="text-gray-200 text-sm">{fmt(ticket.started_at)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">{t('tickets.completedAt')}</p>
              <p className="text-gray-200 text-sm">{fmt(ticket.completed_at)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">{t('tickets.assignedTo')}</p>
              <p className="text-gray-200 text-sm">{ticket.assigned_to_name ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">{t('tickets.downtimeMinutes')}</p>
              <p className="text-gray-200 text-sm font-mono">{ticket.estimated_downtime_minutes ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">{t('tickets.interventionMinutes')}</p>
              <p className="text-gray-200 text-sm font-mono">{ticket.total_intervention_minutes ?? '—'}</p>
            </div>
          </div>

          {/* Diagnosis / Corrective fields */}
          {isActive && (
            <div className="glass-card p-5 space-y-4">
              <h3 className="text-white text-sm font-semibold">{t('tickets.diagnosis')}</h3>
              <div>
                <label className="label">{t('tickets.diagnosis')}</label>
                <textarea value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} rows={3} className="input-field resize-none" placeholder={t('tickets.diagnosisPlaceholder')} />
              </div>
              <div>
                <label className="label">{t('tickets.correctiveAction')}</label>
                <textarea value={corrective} onChange={(e) => setCorrective(e.target.value)} rows={3} className="input-field resize-none" placeholder={t('tickets.correctivePlaceholder')} />
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="label">{t('tickets.interventionMinutes')}</label>
                  <input type="number" value={intMins} onChange={(e) => setIntMins(e.target.value)} className="input-field" min="0" />
                </div>
                <div>
                  <label className="label">{t('tickets.downtimeMinutes')}</label>
                  <input type="number" value={downMins} onChange={(e) => setDownMins(e.target.value)} className="input-field" min="0" />
                </div>
              </div>
              <button onClick={doSaveDiagnosis} disabled={saving} className="btn-primary">
                {saving ? t('tickets.saving') : t('common.save')}
              </button>
            </div>
          )}

          {/* Read-only if completed */}
          {!isActive && (diagnosis || corrective) && (
            <div className="glass-card p-5 space-y-3">
              {diagnosis && (
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">{t('tickets.diagnosis')}</p>
                  <p className="text-gray-300 text-sm whitespace-pre-wrap">{diagnosis}</p>
                </div>
              )}
              {corrective && (
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">{t('tickets.correctiveAction')}</p>
                  <p className="text-gray-300 text-sm whitespace-pre-wrap">{corrective}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Tab: Comments */}
      {tab === 'comments' && (
        <div className="space-y-3">
          {(ticket.comments ?? []).length === 0 && (
            <div className="glass-card p-8 text-center text-gray-600 text-sm">{t('tickets.noComments')}</div>
          )}
          {(ticket.comments ?? []).map((c: TicketComment) => (
            <div key={c.id} className="glass-card p-4">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-sm font-medium text-gray-200">{c.author}</span>
                <span className="text-xs text-gray-600 font-mono">{fmt(c.created_at)}</span>
              </div>
              <p className="text-gray-400 text-sm whitespace-pre-wrap">{c.comment}</p>
            </div>
          ))}
          <div className="glass-card p-4 space-y-3">
            <div>
              <label className="label">{t('tickets.yourName')}</label>
              <input value={commentAuthor} onChange={(e) => setCommentAuthor(e.target.value)} className="input-field" placeholder={t('tickets.namePlaceholder')} />
            </div>
            <div>
              <label className="label">{t('tickets.addComment')}</label>
              <textarea value={commentText} onChange={(e) => setCommentText(e.target.value)} rows={3} className="input-field resize-none" placeholder={t('tickets.commentPlaceholder')} />
            </div>
            <button
              onClick={doAddComment}
              disabled={postingComment || !commentText || !commentAuthor}
              className="btn-primary"
            >
              {postingComment ? t('common.posting') : t('common.post')}
            </button>
          </div>
        </div>
      )}

      {/* Tab: Parts */}
      {tab === 'parts' && (
        <div className="space-y-3">
          {(ticket.parts_used ?? []).length === 0 ? (
            <div className="glass-card p-8 text-center text-gray-600 text-sm">{t('tickets.noParts')}</div>
          ) : (
            <div className="glass-card overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/[0.04]">
                    <th className="table-header-cell">{t('workOrders.partName')}</th>
                    <th className="table-header-cell">{t('workOrders.partNumber')}</th>
                    <th className="table-header-cell">{t('workOrders.quantity')}</th>
                    <th className="table-header-cell">{t('workOrders.unit')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(ticket.parts_used ?? []).map((p, i) => (
                    <tr key={i} className="table-row">
                      <td className="table-cell">{p.name}</td>
                      <td className="table-cell text-gray-500 font-mono text-xs">{p.part_no ?? '—'}</td>
                      <td className="table-cell font-mono">{p.qty}</td>
                      <td className="table-cell text-gray-500">{p.unit ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {isActive && (
            <div className="glass-card p-4 space-y-3">
              <h3 className="text-sm font-semibold text-gray-300">{t('tickets.addPart')}</h3>
              <div className="grid sm:grid-cols-4 gap-3">
                <div className="sm:col-span-2">
                  <label className="label">{t('workOrders.partName')} *</label>
                  <input value={newPartName} onChange={(e) => setNewPartName(e.target.value)} className="input-field" />
                </div>
                <div>
                  <label className="label">{t('workOrders.partNumber')}</label>
                  <input value={newPartNo} onChange={(e) => setNewPartNo(e.target.value)} className="input-field" />
                </div>
                <div>
                  <label className="label">{t('workOrders.quantity')}</label>
                  <input type="number" value={newPartQty} onChange={(e) => setNewPartQty(e.target.value)} className="input-field" min="0.01" step="0.01" />
                </div>
                <div>
                  <label className="label">{t('workOrders.unit')}</label>
                  <input value={newPartUnit} onChange={(e) => setNewPartUnit(e.target.value)} className="input-field" placeholder="un" />
                </div>
              </div>
              <button onClick={doAddPart} disabled={!newPartName} className="btn-primary">
                <Package size={14} /> {t('tickets.addPart')}
              </button>
            </div>
          )}
        </div>
      )}
      {/* Tab: Work Order */}
      {tab === 'workorder' && (
        <div className="space-y-3">
          {!ticket.work_order_id ? (
            <div className="glass-card p-8 flex flex-col items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-blue-600/20 flex items-center justify-center">
                <Wrench size={24} className="text-blue-400" />
              </div>
              <p className="text-gray-400 text-sm">{t('supervisor.noWorkOrder')}</p>
              {woError && <p className="text-red-400 text-xs">{woError}</p>}
              {isActive && (
                <button
                  onClick={doGenerateWO}
                  disabled={generatingWO}
                  className="btn-primary"
                >
                  <Wrench size={14} />
                  {generatingWO ? t('supervisor.generating') : t('supervisor.generateButton')}
                </button>
              )}
            </div>
          ) : (
            <div className="glass-card p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-white font-semibold flex items-center gap-2">
                  <Wrench size={15} className="text-blue-400" />
                  {t('supervisor.woLinked')}
                </h3>
                <button
                  onClick={() => navigate(`/work-orders/${ticket.work_order_id}`)}
                  className="btn-secondary py-1.5 px-3 text-xs"
                >
                  <ChevronRight size={13} /> {t('supervisor.viewWO')}
                </button>
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">WO Number</p>
                  <p className="text-gray-200 text-sm font-mono">{ticket.work_order_number ?? '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">{t('common.status')}</p>
                  <p className="text-gray-200 text-sm">{ticket.work_order_status ?? '—'}</p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
