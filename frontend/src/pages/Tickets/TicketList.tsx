import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Ticket, RefreshCw, Play, PauseCircle, CheckCircle2,
  XCircle, MessageSquare, Package, ChevronRight, Plus, Trash2,
} from 'lucide-react';
import { fetchTickets, updateTicketStatus, deleteTicket } from '../../api/maintenance';
import type { MaintenanceTicket, AlertPriority, TicketStatus } from '../../types';
import Spinner from '../../components/ui/Spinner';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';

const SLA_MINUTES: Record<AlertPriority, number> = {
  critical: 10, high: 30, medium: 120, low: 480,
};

const PRIORITY_BADGE: Record<AlertPriority, string> = {
  critical: 'bg-red-500/15 text-red-400 border-red-500/25',
  high:     'bg-orange-500/15 text-orange-400 border-orange-500/25',
  medium:   'bg-sky-500/15 text-sky-400 border-sky-500/25',
  low:      'bg-gray-500/15 text-gray-400 border-gray-500/25',
};

const STATUS_BADGE: Record<TicketStatus, string> = {
  open:          'bg-blue-500/15 text-blue-400 border-blue-500/25',
  in_progress:   'bg-amber-500/15 text-amber-400 border-amber-500/25',
  on_hold_parts: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
  on_hold_ext:   'bg-pink-500/15 text-pink-400 border-pink-500/25',
  completed:     'bg-green-500/15 text-green-400 border-green-500/25',
  cancelled:     'bg-gray-500/15 text-gray-400 border-gray-500/25',
};

function timeOpen(openedAt: string): string {
  const mins = Math.floor((Date.now() - new Date(openedAt).getTime()) / 60_000);
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
}

function slaDisplay(priority: AlertPriority, openedAt: string, status: TicketStatus) {
  if (status === 'completed' || status === 'cancelled') return null;
  const sla     = SLA_MINUTES[priority];
  const elapsed = (Date.now() - new Date(openedAt).getTime()) / 60_000;
  const remain  = sla - elapsed;
  if (remain < 0) return { label: 'Overdue', color: 'text-red-400' };
  if (remain < sla * 0.25) {
    const m = Math.round(remain);
    return { label: m < 60 ? `${m}m left` : `${Math.floor(m/60)}h left`, color: 'text-amber-400' };
  }
  const m = Math.round(remain);
  return { label: m < 60 ? `${m}m left` : `${Math.floor(m/60)}h left`, color: 'text-green-400' };
}

export default function TicketList() {
  const { t }    = useTranslation();
  const navigate = useNavigate();

  const [tickets, setTickets]   = useState<MaintenanceTicket[]>([]);
  const [total, setTotal]       = useState(0);
  const [loading, setLoading]   = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [fStatus, setFStatus]   = useState('');

  const load = useCallback(async () => {
    const params: Record<string, string> = {};
    if (fStatus) params.status = fStatus;
    const { total: tot, items } = await fetchTickets(params);
    setTickets(items);
    setTotal(tot);
    setLoading(false);
  }, [fStatus]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [fStatus, load]);

  const { lastUpdatedAt, isRefreshing, hasError, manualRefresh } = useAutoRefresh(load);

  const quickAction = async (id: string, status: TicketStatus) => {
    setActionId(id);
    try {
      const updated = await updateTicketStatus(id, { status });
      setTickets((prev) => prev.map((t) => (t.id === id ? updated : t)));
    } finally {
      setActionId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this ticket permanently?')) return;
    setDeletingId(id);
    try {
      await deleteTicket(id);
      setTickets((prev) => prev.filter((t) => t.id !== id));
      setTotal((prev) => prev - 1);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="p-6 space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Ticket size={22} className="text-blue-400" />
            {t('tickets.title')}
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">{t('tickets.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {hasError && (
            <span className="text-xs text-amber-500 hidden sm:inline">⚠ Last update failed</span>
          )}
          {lastUpdatedAt && !hasError && (
            <span className="text-xs text-gray-600 font-mono hidden sm:inline">
              {lastUpdatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          <button onClick={manualRefresh} disabled={isRefreshing} className="btn-secondary py-1.5 px-3">
            <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
          </button>
          <Link to="/tickets/new" className="btn-primary py-1.5 px-3 flex items-center gap-1.5 text-sm">
            <Plus size={14} /> New Ticket
          </Link>
        </div>
      </div>

      {/* Status filter */}
      <div className="flex items-center gap-2 flex-wrap">
        {(['', 'open', 'in_progress', 'on_hold_parts', 'on_hold_ext', 'completed'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFStatus(s)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              fStatus === s
                ? 'bg-blue-500/15 text-blue-400 border-blue-500/30'
                : 'border-white/10 text-gray-500 hover:border-white/20 hover:text-gray-300'
            }`}
          >
            {s === '' ? t('common.all') : t(`ticketStatus.${s}`, s)}
          </button>
        ))}
        <span className="ml-auto text-xs text-gray-600">{total} {t('tickets.total')}</span>
      </div>

      {/* Table */}
      <div className="glass-card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <Spinner size="lg" />
          </div>
        ) : tickets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-3">
            <Ticket size={36} className="text-gray-700" />
            <p className="text-gray-500 text-sm">{t('tickets.noTickets')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.04]">
                  <th className="table-header-cell">{t('tickets.ticketNumber')}</th>
                  <th className="table-header-cell">{t('alerts.machine')}</th>
                  <th className="table-header-cell">{t('common.priority')}</th>
                  <th className="table-header-cell">{t('common.status')}</th>
                  <th className="table-header-cell hidden md:table-cell">{t('tickets.assignedTo')}</th>
                  <th className="table-header-cell hidden lg:table-cell">{t('tickets.timeOpen')}</th>
                  <th className="table-header-cell hidden xl:table-cell">SLA</th>
                  <th className="table-header-cell hidden xl:table-cell">{t('alerts.escalation')}</th>
                  <th className="table-header-cell">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((ticket) => {
                  const sla = slaDisplay(ticket.priority, ticket.opened_at, ticket.status);
                  return (
                    <tr key={ticket.id} className="table-row">
                      <td className="table-cell">
                        <div className="flex flex-col gap-1">
                          <span className="font-mono text-blue-400 text-xs">{ticket.ticket_number}</span>
                          {ticket.machine_page_source && (
                            <span className="text-[10px] font-medium bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 px-1.5 py-0.5 rounded w-fit">
                              Machine Page
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="table-cell font-medium text-gray-200">
                        {ticket.machine_name ?? '—'}
                      </td>
                      <td className="table-cell">
                        <span className={`inline-flex items-center px-2 py-0.5 text-xs font-mono font-medium border rounded ${PRIORITY_BADGE[ticket.priority]}`}>
                          {t(`priority.${ticket.priority}`)}
                        </span>
                      </td>
                      <td className="table-cell">
                        <span className={`inline-flex items-center px-2 py-0.5 text-xs font-mono font-medium border rounded ${STATUS_BADGE[ticket.status]}`}>
                          {t(`ticketStatus.${ticket.status}`, ticket.status)}
                        </span>
                      </td>
                      <td className="table-cell hidden md:table-cell text-gray-400 text-xs">
                        {ticket.assigned_to_name ?? '—'}
                      </td>
                      <td className="table-cell hidden lg:table-cell font-mono text-xs text-gray-400">
                        {timeOpen(ticket.opened_at)}
                      </td>
                      <td className="table-cell hidden xl:table-cell">
                        {sla ? (
                          <span className={`text-xs font-mono ${sla.color}`}>{sla.label}</span>
                        ) : (
                          <span className="text-xs text-gray-700">—</span>
                        )}
                      </td>
                      <td className="table-cell hidden xl:table-cell">
                        {ticket.current_escalation_level > 0 ? (
                          <span className="text-xs text-red-400 font-mono">L{ticket.current_escalation_level}</span>
                        ) : (
                          <span className="text-xs text-gray-700">—</span>
                        )}
                      </td>
                      <td className="table-cell">
                        <div className="flex items-center gap-1">
                          {ticket.status === 'open' && (
                            <button
                              onClick={() => quickAction(ticket.id, 'in_progress')}
                              disabled={actionId === ticket.id}
                              title={t('tickets.start')}
                              className="btn-success py-1 px-2 text-xs"
                            >
                              <Play size={11} />
                            </button>
                          )}
                          {ticket.status === 'in_progress' && (
                            <>
                              <button
                                onClick={() => quickAction(ticket.id, 'on_hold_parts')}
                                disabled={actionId === ticket.id}
                                title={t('tickets.holdParts')}
                                className="btn-warning py-1 px-2 text-xs"
                              >
                                <Package size={11} />
                              </button>
                              <button
                                onClick={() => quickAction(ticket.id, 'on_hold_ext')}
                                disabled={actionId === ticket.id}
                                title={t('tickets.holdExt')}
                                className="btn-warning py-1 px-2 text-xs"
                              >
                                <PauseCircle size={11} />
                              </button>
                            </>
                          )}
                          {(ticket.status === 'on_hold_parts' || ticket.status === 'on_hold_ext') && (
                            <button
                              onClick={() => quickAction(ticket.id, 'in_progress')}
                              disabled={actionId === ticket.id}
                              title={t('tickets.resume')}
                              className="btn-success py-1 px-2 text-xs"
                            >
                              <Play size={11} />
                            </button>
                          )}
                          {ticket.status !== 'completed' && ticket.status !== 'cancelled' && (
                            <button
                              onClick={() => quickAction(ticket.id, 'cancelled')}
                              disabled={actionId === ticket.id}
                              title={t('tickets.cancel')}
                              className="btn-danger py-1 px-2 text-xs"
                            >
                              <XCircle size={11} />
                            </button>
                          )}
                          {(ticket.status === 'completed' || ticket.status === 'cancelled') && (
                            <button
                              onClick={() => handleDelete(ticket.id)}
                              disabled={deletingId === ticket.id}
                              title="Delete ticket"
                              className="btn-danger py-1 px-2 text-xs"
                            >
                              <Trash2 size={11} />
                            </button>
                          )}
                          <button
                            onClick={() => navigate(`/tickets/${ticket.id}`)}
                            className="btn-secondary py-1 px-2 text-xs"
                            title={t('common.view')}
                          >
                            <ChevronRight size={11} />
                          </button>
                        </div>
                      </td>
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
}
