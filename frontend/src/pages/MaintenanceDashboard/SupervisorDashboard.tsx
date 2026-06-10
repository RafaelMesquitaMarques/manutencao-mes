import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, Link } from 'react-router-dom';
import {
  Ticket, Wrench, ChevronRight, AlertTriangle,
  CheckCircle2, Clock, RefreshCw, UserCheck, Play, Package,
} from 'lucide-react';
import { fetchTickets, assignTicket } from '../../api/maintenance';
import { fetchWorkOrders } from '../../api/workOrders';
import { fetchTechniciansFull } from '../../api/workOrders';
import type { MaintenanceTicket, WorkOrder, TechnicianFull } from '../../types';
import Spinner from '../../components/ui/Spinner';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';

const PRIORITY_DOT: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-amber-500',
  low: 'bg-green-500',
};

const PRIORITY_LABEL: Record<string, string> = {
  critical: 'text-red-400',
  high: 'text-orange-400',
  medium: 'text-amber-400',
  low: 'text-green-400',
};

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  open:         { text: 'Open',        cls: 'text-blue-400 bg-blue-500/10' },
  in_progress:  { text: 'In Progress', cls: 'text-amber-400 bg-amber-500/10' },
  on_hold:      { text: 'On Hold',     cls: 'text-gray-400 bg-gray-500/10' },
  completed:    { text: 'Done',        cls: 'text-green-400 bg-green-500/10' },
  cancelled:    { text: 'Cancelled',   cls: 'text-gray-600 bg-gray-700/10' },
};

const fmt = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';

function PanelHeader({ icon: Icon, title, count, color }: {
  icon: React.ElementType; title: string; count: number; color: string;
}) {
  return (
    <div className="flex items-center gap-3 p-4 border-b border-white/[0.06]">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${color}`}>
        <Icon size={16} className="text-white" />
      </div>
      <div>
        <p className="text-sm font-semibold text-gray-200">{title}</p>
        <p className="text-xs text-gray-600">{count} item{count !== 1 ? 's' : ''}</p>
      </div>
    </div>
  );
}

function TicketRow({ ticket, techs, onRefresh }: {
  ticket: MaintenanceTicket;
  techs: TechnicianFull[];
  onRefresh: () => void;
}) {
  const navigate = useNavigate();
  const [showAssign, setShowAssign] = useState(false);
  const [techId, setTechId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const doAssign = async () => {
    if (!techId) return;
    setBusy(true);
    setErr('');
    try {
      await assignTicket(ticket.id, techId);
      setShowAssign(false);
      onRefresh();
    } catch (e: unknown) {
      setErr((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-3 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] transition-colors">
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${PRIORITY_DOT[ticket.priority] ?? 'bg-gray-500'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => navigate(`/tickets/${ticket.id}`)}
              className="text-xs font-mono text-blue-400 hover:text-blue-300"
            >
              {ticket.ticket_number}
            </button>
            <span className={`text-[10px] font-medium ${PRIORITY_LABEL[ticket.priority]}`}>
              {ticket.priority.toUpperCase()}
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-0.5 truncate">
            {ticket.machine_name ?? '—'}
            {ticket.problem_type && (
              <span className="text-gray-600"> · {ticket.problem_type.replace(/_/g, ' ')}</span>
            )}
          </p>
          {ticket.description && (
            <p className="text-[11px] text-gray-600 mt-0.5 truncate">{ticket.description}</p>
          )}
          <p className="text-[10px] text-gray-700 mt-0.5">{fmt(ticket.opened_at)}</p>
          {ticket.work_order_number && (
            <p className="text-[10px] text-green-500 mt-0.5">WO: {ticket.work_order_number}</p>
          )}
        </div>
        <div className="flex gap-1 flex-shrink-0 items-start">
          <button
            onClick={() => navigate(`/tickets/${ticket.id}`)}
            className="p-1.5 text-gray-600 hover:text-gray-300 transition-colors"
          >
            <ChevronRight size={14} />
          </button>
          {!ticket.work_order_id && (
            <button
              onClick={() => setShowAssign(!showAssign)}
              className="px-2 py-1 text-[11px] font-medium bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-500/30 rounded transition-colors flex items-center gap-1"
            >
              <UserCheck size={11} />
              Assign
            </button>
          )}
          {ticket.work_order_id && (
            <span className="px-2 py-1 text-[11px] text-green-400 bg-green-500/10 rounded flex items-center gap-1">
              <CheckCircle2 size={10} />
              WO Created
            </span>
          )}
        </div>
      </div>
      {showAssign && !ticket.work_order_id && (
        <div className="mt-2 ml-4 flex gap-2">
          <select
            value={techId}
            onChange={(e) => setTechId(e.target.value)}
            className="input-field text-xs flex-1 py-1"
          >
            <option value="">Select technician…</option>
            {techs.map((t) => (
              <option key={t.id} value={t.id}>{t.full_name ?? t.email}</option>
            ))}
          </select>
          <button
            onClick={doAssign}
            disabled={busy || !techId}
            className="px-3 py-1 text-[11px] font-medium bg-blue-600/30 text-blue-300 rounded disabled:opacity-50 flex items-center gap-1"
          >
            {busy ? <Spinner size="sm" /> : <Play size={10} />}
            {busy ? 'Creating WO…' : 'Assign + Create WO'}
          </button>
        </div>
      )}
      {err && <p className="text-[10px] text-red-400 ml-4 mt-1">{err}</p>}
    </div>
  );
}

function WORow({ wo }: { wo: WorkOrder }) {
  const navigate = useNavigate();
  const s = STATUS_LABEL[wo.status] ?? STATUS_LABEL.open;

  return (
    <div
      className="p-3 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] transition-colors cursor-pointer"
      onClick={() => navigate(`/work-orders/${wo.id}`)}
    >
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${PRIORITY_DOT[wo.priority] ?? 'bg-gray-500'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-gray-300">{wo.wo_number}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${s.cls}`}>{s.text}</span>
          </div>
          <p className="text-xs text-gray-500 truncate">{wo.title}</p>
          {wo.executor_name && (
            <p className="text-[10px] text-gray-600">{wo.executor_name}</p>
          )}
        </div>
        <ChevronRight size={14} className="text-gray-600 flex-shrink-0 mt-1" />
      </div>
    </div>
  );
}

export default function SupervisorDashboard() {
  const { t } = useTranslation();
  const [tickets, setTickets] = useState<MaintenanceTicket[]>([]);
  const [wos, setWos] = useState<WorkOrder[]>([]);
  const [techs, setTechs] = useState<TechnicianFull[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [ticketRes, woRes, techRes] = await Promise.allSettled([
        fetchTickets({ status: 'open' }),
        fetchWorkOrders({ status_not: 'completed,cancelled' }),
        fetchTechniciansFull(),
      ]);
      if (ticketRes.status === 'fulfilled') setTickets(ticketRes.value.items);
      if (woRes.status === 'fulfilled') setWos(woRes.value);
      if (techRes.status === 'fulfilled') setTechs(techRes.value);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const { lastUpdatedAt, isRefreshing, hasError, manualRefresh } = useAutoRefresh(
    () => load(true),
  );

  const unassignedTickets = tickets.filter((t) => !t.work_order_id);
  const assignedTickets = tickets.filter((t) => t.work_order_id);
  const activeWOs = wos.filter((w) => w.status === 'in_progress');
  const openWOs = wos.filter((w) => w.status === 'open');

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('supervisor.title', 'Supervisor Dashboard')}</h1>
          <p className="text-gray-500 text-sm mt-0.5">Assign technicians to tickets — work orders are created automatically</p>
        </div>
        <div className="flex items-center gap-2">
          {hasError && <span className="text-xs text-amber-500 hidden sm:inline">⚠ Last update failed</span>}
          {lastUpdatedAt && !hasError && (
            <span className="text-xs text-gray-600 font-mono hidden sm:inline">
              {lastUpdatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          <Link to="/maintenance/parts-approval"
            className="btn-secondary py-1.5 px-3 flex items-center gap-1.5 text-sm">
            <Package size={14} />
            Parts Approval
          </Link>
          <button onClick={manualRefresh} disabled={loading || isRefreshing} className="btn-secondary py-1.5 px-3 flex items-center gap-1.5">
            <RefreshCw size={14} className={(loading || isRefreshing) ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48"><Spinner size="lg" /></div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* LEFT: Tickets needing assignment */}
          <div className="glass-card overflow-hidden flex flex-col">
            <PanelHeader
              icon={Ticket}
              title="Tickets"
              count={tickets.length}
              color="bg-blue-600/30"
            />
            <div className="flex-1 overflow-y-auto max-h-[600px]">
              {unassignedTickets.length === 0 && assignedTickets.length === 0 ? (
                <div className="p-8 text-center">
                  <CheckCircle2 size={32} className="text-green-500 mx-auto mb-2 opacity-50" />
                  <p className="text-gray-600 text-sm">No open tickets</p>
                </div>
              ) : (
                <>
                  {unassignedTickets.length > 0 && (
                    <div className="px-3 pt-2 pb-1">
                      <p className="text-[10px] text-gray-600 uppercase tracking-wider">Needs Assignment ({unassignedTickets.length})</p>
                    </div>
                  )}
                  {unassignedTickets.map((t) => (
                    <TicketRow key={t.id} ticket={t} techs={techs} onRefresh={load} />
                  ))}
                  {assignedTickets.length > 0 && (
                    <div className="px-3 pt-2 pb-1 border-t border-white/[0.04]">
                      <p className="text-[10px] text-gray-600 uppercase tracking-wider">WO Created ({assignedTickets.length})</p>
                    </div>
                  )}
                  {assignedTickets.map((t) => (
                    <TicketRow key={t.id} ticket={t} techs={techs} onRefresh={load} />
                  ))}
                </>
              )}
            </div>
          </div>

          {/* RIGHT: Active & Open WOs */}
          <div className="glass-card overflow-hidden flex flex-col">
            <PanelHeader
              icon={Wrench}
              title="Work Orders"
              count={wos.length}
              color="bg-amber-600/30"
            />
            <div className="flex-1 overflow-y-auto max-h-[600px]">
              {wos.length === 0 ? (
                <div className="p-8 text-center">
                  <Clock size={32} className="text-gray-600 mx-auto mb-2 opacity-50" />
                  <p className="text-gray-600 text-sm">No active work orders</p>
                </div>
              ) : (
                <>
                  {activeWOs.length > 0 && (
                    <div className="px-3 pt-2 pb-1">
                      <p className="text-[10px] text-gray-600 uppercase tracking-wider flex items-center gap-1">
                        <span className="w-1.5 h-1.5 bg-amber-500 rounded-full" />
                        In Progress ({activeWOs.length})
                      </p>
                    </div>
                  )}
                  {activeWOs.map((wo) => <WORow key={wo.id} wo={wo} />)}
                  {openWOs.length > 0 && (
                    <div className="px-3 pt-3 pb-1 border-t border-white/[0.04]">
                      <p className="text-[10px] text-gray-600 uppercase tracking-wider flex items-center gap-1">
                        <span className="w-1.5 h-1.5 bg-blue-500 rounded-full" />
                        Open ({openWOs.length})
                      </p>
                    </div>
                  )}
                  {openWOs.map((wo) => <WORow key={wo.id} wo={wo} />)}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
