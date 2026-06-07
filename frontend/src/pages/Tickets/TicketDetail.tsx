import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Info, Wrench, Package, History, MessageSquare,
  CheckCircle2, Clock, User, UserCheck, AlertTriangle, ChevronRight,
} from 'lucide-react';
import {
  fetchTicket, updateTicketStatus, closeTicket, addTicketComment,
  assignTicket, fetchTicketWorkOrder,
} from '../../api/maintenance';
import type { MaintenanceTicket, TicketStatus, WorkOrder, MachineHistoryEntry } from '../../types';
import { fetchTechniciansFull } from '../../api/workOrders';
import type { TechnicianFull } from '../../types';
import api from '../../api/axios';
import Spinner from '../../components/ui/Spinner';

type Tab = 'details' | 'workorder' | 'parts' | 'history';

const PRIORITY_BADGE: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-400 border-red-500/30',
  high:     'bg-orange-500/15 text-orange-400 border-orange-500/30',
  medium:   'bg-sky-500/15 text-sky-400 border-sky-500/30',
  low:      'bg-gray-500/15 text-gray-400 border-gray-500/30',
};

const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open', in_progress: 'In Progress', on_hold_parts: 'On Hold (Parts)',
  on_hold_ext: 'On Hold (External)', completed: 'Completed', cancelled: 'Cancelled',
};

const fmtDt = (d?: string | null) =>
  d ? new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

export default function TicketDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [ticket, setTicket]   = useState<MaintenanceTicket | null>(null);
  const [wo, setWo]           = useState<WorkOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab]         = useState<Tab>('details');

  const load = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const t = await fetchTicket(id);
      setTicket(t);
      if (t.work_order_id) {
        try { setWo(await fetchTicketWorkOrder(id)); } catch { /* no WO yet */ }
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  if (loading) return <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>;
  if (!ticket) return <div className="p-6 text-gray-400">Ticket not found.</div>;

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="text-gray-500 hover:text-gray-200 transition-colors">
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-blue-400 font-semibold">{ticket.ticket_number}</span>
            <span className={`text-xs border px-2 py-0.5 rounded ${PRIORITY_BADGE[ticket.priority]}`}>
              {ticket.priority}
            </span>
            <span className="text-xs text-gray-500">{STATUS_LABEL[ticket.status]}</span>
          </div>
          <p className="text-white font-medium mt-0.5 text-sm">
            {ticket.machine_name ?? 'Unknown Machine'}
            {ticket.problem_type && (
              <span className="text-gray-500"> · {ticket.problem_type.replace(/_/g, ' ')}</span>
            )}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-white/[0.08] gap-1">
        {([
          { key: 'details',   icon: Info,       label: 'Details' },
          { key: 'workorder', icon: Wrench,      label: `Work Order${wo ? ' ✓' : ''}` },
          { key: 'parts',     icon: Package,     label: 'Parts' },
          { key: 'history',   icon: History,     label: 'Machine History' },
        ] as { key: Tab; icon: React.ElementType; label: string }[]).map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-3 py-2.5 text-sm flex items-center gap-1.5 border-b-2 transition-colors ${
              tab === key
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            <Icon size={14} />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      {tab === 'details'   && <DetailsTab ticket={ticket} wo={wo} onRefresh={load} />}
      {tab === 'workorder' && <WorkOrderTab ticket={ticket} wo={wo} />}
      {tab === 'parts'     && <PartsTab wo={wo} />}
      {tab === 'history'   && <MachineHistoryTab machineId={ticket.machine_id} />}
    </div>
  );
}

// ── Details Tab ───────────────────────────────────────────────────────────────

function DetailsTab({ ticket, wo: _wo, onRefresh }: { ticket: MaintenanceTicket; wo: WorkOrder | null; onRefresh: () => void }) {
  const [techs, setTechs]         = useState<TechnicianFull[]>([]);
  const [techId, setTechId]       = useState('');
  const [assigning, setAssigning] = useState(false);
  const [showClose, setShowClose] = useState(false);
  const [closing, setClosing]     = useState(false);
  const [commentText, setCommentText]     = useState('');
  const [commentAuthor, setCommentAuthor] = useState('');
  const [postingComment, setPostingComment] = useState(false);
  const [closeForm, setCloseForm] = useState({ diagnosis: '', corrective_action: '', total_intervention_minutes: '' });
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!ticket.work_order_id) fetchTechniciansFull().then(setTechs).catch(() => {});
  }, [ticket.work_order_id]);

  const doAssign = async () => {
    if (!techId) return;
    setAssigning(true); setErr('');
    try {
      await assignTicket(ticket.id, techId);
      onRefresh();
    } catch (e: unknown) {
      setErr((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Error');
    } finally { setAssigning(false); }
  };

  const doClose = async () => {
    if (!closeForm.diagnosis.trim() || !closeForm.corrective_action.trim()) return;
    setClosing(true);
    try {
      await closeTicket(ticket.id, {
        diagnosis: closeForm.diagnosis,
        corrective_action: closeForm.corrective_action,
        total_intervention_minutes: parseInt(closeForm.total_intervention_minutes) || 0,
      });
      onRefresh(); setShowClose(false);
    } finally { setClosing(false); }
  };

  const doComment = async () => {
    if (!commentText.trim()) return;
    setPostingComment(true);
    try {
      await addTicketComment(ticket.id, { author: commentAuthor || 'User', comment: commentText });
      setCommentText(''); onRefresh();
    } finally { setPostingComment(false); }
  };

  // Ticket is not actually used in status updates here — kept simple
  const _updateStatus = updateTicketStatus;

  return (
    <div className="space-y-4">
      <div className="glass-card p-4 grid grid-cols-2 gap-4 text-sm">
        <Field label="Machine" value={ticket.machine_name ?? '—'} />
        <Field label="Problem Type" value={ticket.problem_type?.replace(/_/g, ' ') ?? '—'} />
        <Field label="Priority" value={ticket.priority} />
        <Field label="Status" value={ticket.status.replace(/_/g, ' ')} />
        <Field label="Opened" value={fmtDt(ticket.opened_at)} />
        <Field label="Assigned To" value={ticket.assigned_to_name ?? 'Unassigned'} />
        {ticket.started_at && <Field label="Started" value={fmtDt(ticket.started_at)} />}
        {ticket.completed_at && <Field label="Completed" value={fmtDt(ticket.completed_at)} />}
        {ticket.estimated_downtime_minutes != null && (
          <Field label="Est. Downtime" value={`${ticket.estimated_downtime_minutes} min`} />
        )}
        {ticket.total_intervention_minutes != null && (
          <Field label="Intervention Time" value={`${ticket.total_intervention_minutes} min`} />
        )}
      </div>

      {ticket.description && (
        <div className="glass-card p-4">
          <p className="text-xs text-gray-600 uppercase tracking-wider mb-1">Description</p>
          <p className="text-sm text-gray-300">{ticket.description}</p>
        </div>
      )}

      {!ticket.work_order_id && ticket.status !== 'completed' && ticket.status !== 'cancelled' && (
        <div className="glass-card p-4 space-y-3">
          <p className="text-sm font-semibold text-gray-300 flex items-center gap-2">
            <UserCheck size={15} className="text-blue-400" />
            Assign Technician — Work Order Created Automatically
          </p>
          <div className="flex gap-2">
            <select value={techId} onChange={(e) => setTechId(e.target.value)} className="input-field flex-1 text-sm">
              <option value="">Select technician…</option>
              {techs.map((t) => (
                <option key={t.id} value={t.id}>{t.full_name ?? t.email}</option>
              ))}
            </select>
            <button onClick={doAssign} disabled={assigning || !techId}
              className="btn-primary px-4 py-2 text-sm flex items-center gap-1.5">
              {assigning ? <Spinner size="sm" /> : <UserCheck size={14} />}
              {assigning ? 'Creating WO…' : 'Assign + WO'}
            </button>
          </div>
          {err && <p className="text-red-400 text-xs">{err}</p>}
        </div>
      )}

      {ticket.status === 'in_progress' && !showClose && (
        <button onClick={() => setShowClose(true)} className="btn-success w-full py-3 flex items-center justify-center gap-2">
          <CheckCircle2 size={16} /> Mark Ticket Complete
        </button>
      )}
      {showClose && (
        <div className="glass-card p-4 space-y-3">
          <p className="text-sm font-semibold text-gray-200">Close Ticket</p>
          <div>
            <label className="label">Diagnosis *</label>
            <textarea className="input-field w-full h-20 resize-none" value={closeForm.diagnosis}
              onChange={(e) => setCloseForm((f) => ({ ...f, diagnosis: e.target.value }))} />
          </div>
          <div>
            <label className="label">Corrective Action *</label>
            <textarea className="input-field w-full h-20 resize-none" value={closeForm.corrective_action}
              onChange={(e) => setCloseForm((f) => ({ ...f, corrective_action: e.target.value }))} />
          </div>
          <div>
            <label className="label">Intervention Time (minutes)</label>
            <input type="number" className="input-field w-full" value={closeForm.total_intervention_minutes}
              onChange={(e) => setCloseForm((f) => ({ ...f, total_intervention_minutes: e.target.value }))} />
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowClose(false)} className="btn-secondary flex-1 py-2">Cancel</button>
            <button onClick={doClose} disabled={closing} className="btn-success flex-1 py-2 font-semibold">
              {closing ? 'Saving…' : 'Close Ticket'}
            </button>
          </div>
        </div>
      )}

      <div className="glass-card p-4 space-y-3">
        <p className="text-xs text-gray-600 uppercase tracking-wider flex items-center gap-2">
          <MessageSquare size={12} /> Comments ({ticket.comments?.length ?? 0})
        </p>
        {ticket.comments?.map((c) => (
          <div key={c.id} className="border-l-2 border-white/10 pl-3 py-1">
            <p className="text-xs text-gray-500">{c.author} · {fmtDt(c.created_at)}</p>
            <p className="text-sm text-gray-300 mt-0.5">{c.comment}</p>
          </div>
        ))}
        <div className="space-y-2 pt-1">
          <input placeholder="Your name" value={commentAuthor}
            onChange={(e) => setCommentAuthor(e.target.value)} className="input-field w-full text-sm" />
          <div className="flex gap-2">
            <textarea placeholder="Add a comment…" value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              className="input-field flex-1 h-16 resize-none text-sm" />
            <button onClick={doComment} disabled={postingComment || !commentText.trim()}
              className="btn-primary px-3 self-end py-2 text-sm">
              {postingComment ? '…' : 'Post'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Work Order Tab ────────────────────────────────────────────────────────────

function WorkOrderTab({ ticket, wo }: { ticket: MaintenanceTicket; wo: WorkOrder | null }) {
  const navigate = useNavigate();

  if (!wo && !ticket.work_order_id) {
    return (
      <div className="glass-card p-8 text-center space-y-3">
        <Wrench size={36} className="text-gray-700 mx-auto" />
        <p className="text-gray-400 font-medium">No work order yet</p>
        <p className="text-gray-600 text-sm">Assign a technician from the Details tab to auto-create a work order.</p>
      </div>
    );
  }
  if (!wo) return <div className="flex items-center justify-center h-24"><Spinner size="lg" /></div>;

  const statusCls: Record<string, string> = {
    open: 'text-blue-400', in_progress: 'text-amber-400',
    on_hold: 'text-purple-400', completed: 'text-green-400', cancelled: 'text-gray-500',
  };

  return (
    <div className="space-y-3">
      <div className="glass-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="font-mono text-blue-400 font-semibold text-lg">{wo.wo_number}</span>
          <span className={`text-sm font-medium ${statusCls[wo.status] ?? 'text-gray-400'}`}>
            {wo.status.replace(/_/g, ' ')}
          </span>
        </div>
        <p className="text-white font-medium">{wo.title}</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Field label="Priority" value={wo.priority} />
          <Field label="Assigned To" value={wo.executor_name ?? wo.assigned_to_name ?? 'Unassigned'} />
          {wo.started_at && <Field label="Started" value={fmtDt(wo.started_at)} />}
          {wo.completed_at && <Field label="Completed" value={fmtDt(wo.completed_at)} />}
          {wo.repair_hours != null && <Field label="Repair Hours" value={`${wo.repair_hours}h`} />}
          {wo.downtime_hours != null && <Field label="Downtime Hours" value={`${wo.downtime_hours}h`} />}
        </div>
        {wo.root_cause && (
          <div>
            <p className="text-xs text-gray-600 uppercase tracking-wider mb-1">Diagnosis</p>
            <p className="text-sm text-gray-300">{wo.root_cause}</p>
          </div>
        )}
        {wo.solution_applied && (
          <div>
            <p className="text-xs text-gray-600 uppercase tracking-wider mb-1">Corrective Action</p>
            <p className="text-sm text-gray-300">{wo.solution_applied}</p>
          </div>
        )}
        <button onClick={() => navigate(`/work-orders/${wo.id}`)}
          className="btn-secondary w-full py-2 text-sm flex items-center justify-center gap-2">
          Open Full WO Detail <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

// ── Parts Tab ─────────────────────────────────────────────────────────────────

function PartsTab({ wo }: { wo: WorkOrder | null }) {
  const [parts, setParts] = useState<{
    id: string; description: string; quantity: number; unit: string;
    part_number?: string; total_cost?: number;
  }[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!wo) return;
    setLoading(true);
    api.get(`/api/wo/${wo.id}/parts`)
      .then((r) => setParts(r.data.items ?? r.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [wo?.id]);

  if (!wo) return (
    <div className="glass-card p-8 text-center text-gray-600 text-sm">
      No work order — assign a technician to create one first.
    </div>
  );

  return (
    <div className="space-y-3">
      {loading ? (
        <div className="flex items-center justify-center h-24"><Spinner size="lg" /></div>
      ) : parts.length === 0 ? (
        <div className="glass-card p-8 text-center">
          <Package size={32} className="text-gray-700 mx-auto mb-2 opacity-50" />
          <p className="text-gray-500 text-sm">No parts recorded yet</p>
          <p className="text-gray-600 text-xs mt-1">Parts are added from the Work Order detail page.</p>
        </div>
      ) : (
        <div className="glass-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="text-left p-3 text-xs text-gray-600 uppercase tracking-wider">Part</th>
                <th className="text-right p-3 text-xs text-gray-600 uppercase tracking-wider">Qty</th>
                <th className="text-right p-3 text-xs text-gray-600 uppercase tracking-wider">Cost</th>
              </tr>
            </thead>
            <tbody>
              {parts.map((p) => (
                <tr key={p.id} className="border-b border-white/[0.04] last:border-0">
                  <td className="p-3">
                    <p className="text-gray-300">{p.description}</p>
                    {p.part_number && <p className="text-xs text-gray-600">{p.part_number}</p>}
                  </td>
                  <td className="p-3 text-right text-gray-400">{p.quantity} {p.unit}</td>
                  <td className="p-3 text-right text-gray-400">
                    {p.total_cost != null ? `$${p.total_cost.toFixed(2)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Machine History Tab ───────────────────────────────────────────────────────

function MachineHistoryTab({ machineId }: { machineId: string }) {
  const [history, setHistory] = useState<MachineHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/api/machines/${machineId}/history`)
      .then((r) => setHistory(r.data.items ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [machineId]);

  const eventTypeColors: Record<string, string> = {
    corrective:  'text-red-400 bg-red-500/10',
    preventive:  'text-blue-400 bg-blue-500/10',
    inspection:  'text-purple-400 bg-purple-500/10',
    improvement: 'text-green-400 bg-green-500/10',
  };

  return (
    <div className="space-y-3">
      {loading ? (
        <div className="flex items-center justify-center h-24"><Spinner size="lg" /></div>
      ) : history.length === 0 ? (
        <div className="glass-card p-8 text-center">
          <History size={32} className="text-gray-700 mx-auto mb-2 opacity-50" />
          <p className="text-gray-500 text-sm">No maintenance history recorded yet</p>
        </div>
      ) : (
        history.map((h) => (
          <div key={h.id} className="glass-card p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className={`text-xs px-2 py-0.5 rounded font-medium ${eventTypeColors[h.event_type] ?? 'text-gray-400 bg-gray-500/10'}`}>
                {h.event_type}
              </span>
              <span className="text-xs text-gray-600">{fmtDt(h.occurred_at)}</span>
            </div>
            {h.problem_type && <p className="text-xs text-gray-500">{h.problem_type.replace(/_/g, ' ')}</p>}
            {h.description && <p className="text-sm text-gray-400">{h.description}</p>}
            {h.diagnosis && (
              <div>
                <p className="text-xs text-gray-600">Diagnosis</p>
                <p className="text-sm text-gray-300">{h.diagnosis}</p>
              </div>
            )}
            {h.corrective_action && (
              <div>
                <p className="text-xs text-gray-600">Corrective Action</p>
                <p className="text-sm text-gray-300">{h.corrective_action}</p>
              </div>
            )}
            <div className="flex flex-wrap gap-3 text-xs text-gray-600">
              {h.technician_name && <span className="flex items-center gap-1"><User size={10} />{h.technician_name}</span>}
              {h.downtime_minutes != null && <span className="flex items-center gap-1"><AlertTriangle size={10} />{h.downtime_minutes} min downtime</span>}
              {h.total_minutes != null && <span className="flex items-center gap-1"><Clock size={10} />{h.total_minutes} min repair</span>}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-gray-600">{label}</p>
      <p className="text-sm text-gray-300 font-medium">{value}</p>
    </div>
  );
}
