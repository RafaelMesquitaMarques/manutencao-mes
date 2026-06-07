import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Bell, Plus, RefreshCw, AlertTriangle, Clock,
  UserPlus, ArrowRightCircle, Filter, Eye,
} from 'lucide-react';
import { fetchAlerts, fetchMachines, assignAlert, convertAlertToTicket } from '../../api/maintenance';
import type { MaintenanceAlert, Machine, AlertPriority, AlertStatus } from '../../types';
import Spinner from '../../components/ui/Spinner';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';

const SLA_MINUTES: Record<AlertPriority, number> = {
  critical: 10, high: 30, medium: 120, low: 480,
};

const PRIORITY_ROW: Record<AlertPriority, string> = {
  critical: 'bg-red-500/[0.07] border-l-2 border-l-red-500',
  high:     'border-l-2 border-l-orange-500',
  medium:   '',
  low:      '',
};

const PRIORITY_BADGE: Record<AlertPriority, string> = {
  critical: 'bg-red-500/15 text-red-400 border-red-500/25',
  high:     'bg-orange-500/15 text-orange-400 border-orange-500/25',
  medium:   'bg-sky-500/15 text-sky-400 border-sky-500/25',
  low:      'bg-gray-500/15 text-gray-400 border-gray-500/25',
};

const STATUS_BADGE: Record<AlertStatus, string> = {
  new_alert:   'bg-blue-500/15 text-blue-400 border-blue-500/25',
  assigned:    'bg-amber-500/15 text-amber-400 border-amber-500/25',
  in_progress: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
  resolved:    'bg-green-500/15 text-green-400 border-green-500/25',
  cancelled:   'bg-gray-500/15 text-gray-400 border-gray-500/25',
};

function timeOpen(createdAt: string): string {
  const mins = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000);
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${Math.floor(mins / 1440)}d`;
}

function slaColor(priority: AlertPriority, createdAt: string): string {
  const sla     = SLA_MINUTES[priority];
  const elapsed = (Date.now() - new Date(createdAt).getTime()) / 60_000;
  if (elapsed >= sla) return 'text-red-400';
  if (elapsed >= sla * 0.75) return 'text-amber-400';
  return 'text-green-400';
}

const isResolved = (a: MaintenanceAlert) =>
  a.status === 'resolved' || a.status === 'cancelled';

export default function AlertList() {
  const { t }    = useTranslation();
  const navigate = useNavigate();

  const [alerts, setAlerts]         = useState<MaintenanceAlert[]>([]);
  const [machines, setMachines]     = useState<Machine[]>([]);
  const [total, setTotal]           = useState(0);
  const [loading, setLoading]       = useState(true);
  const [actionId, setActionId]     = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  // Filters
  const [fMachine, setFMachine]   = useState('');
  const [fPriority, setFPriority] = useState('');
  const [fStatus, setFStatus]     = useState('');
  const [fOverdue, setFOverdue]   = useState(false);

  const load = useCallback(async () => {
    const params: Record<string, string | boolean> = {};
    if (fMachine)      params.machine_id      = fMachine;
    if (fPriority)     params.priority        = fPriority;
    if (fStatus)       params.status          = fStatus;
    if (fOverdue)      params.overdue_only    = true;
    if (showResolved)  params.include_resolved = true;

    const { total: tot, items } = await fetchAlerts(params);
    setAlerts(items);
    setTotal(tot);
    setLoading(false);
  }, [fMachine, fPriority, fStatus, fOverdue, showResolved]);

  useEffect(() => {
    setLoading(true);
    load();
    fetchMachines().then(setMachines);
  }, [fMachine, fPriority, fStatus, fOverdue, showResolved]);

  const { lastUpdatedAt, isRefreshing, hasError, manualRefresh } = useAutoRefresh(load);

  const handleAssign = async (id: string) => {
    setActionId(id);
    try {
      const updated = await assignAlert(id);
      setAlerts((prev) => prev.map((a) => (a.id === id ? updated : a)));
    } finally {
      setActionId(null);
    }
  };

  const handleConvert = async (id: string) => {
    setActionId(id);
    try {
      await convertAlertToTicket(id);
      await load(); // refresh list — alert now has ticket_id
    } finally {
      setActionId(null);
    }
  };

  // Sort: non-resolved first, resolved/cancelled at bottom
  const sorted = showResolved
    ? [...alerts].sort((a, b) => {
        const aR = isResolved(a) ? 1 : 0;
        const bR = isResolved(b) ? 1 : 0;
        return aR - bR;
      })
    : alerts;

  return (
    <div className="p-6 space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Bell size={22} className="text-amber-400" />
            {t('alerts.title')}
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">{t('alerts.subtitle')}</p>
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
          <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none border border-white/10 rounded px-2 py-1.5 hover:border-white/20 transition-colors">
            <Eye size={13} />
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => setShowResolved(e.target.checked)}
              className="rounded border-white/20 bg-transparent"
            />
            {t('alerts.showResolved', 'Resolved')}
          </label>
          <Link to="/alerts/new" className="btn-primary">
            <Plus size={15} />
            {t('alerts.newAlert')}
          </Link>
        </div>
      </div>

      {/* Filters */}
      <div className="glass-card p-3 flex flex-wrap items-center gap-3">
        <Filter size={14} className="text-gray-500 flex-shrink-0" />

        <select
          value={fMachine}
          onChange={(e) => setFMachine(e.target.value)}
          className="select-field w-auto text-xs py-1.5"
        >
          <option value="">{t('alerts.allMachines')}</option>
          {machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>

        <select
          value={fPriority}
          onChange={(e) => setFPriority(e.target.value)}
          className="select-field w-auto text-xs py-1.5"
        >
          <option value="">{t('alerts.allPriorities')}</option>
          {(['critical','high','medium','low'] as AlertPriority[]).map((p) => (
            <option key={p} value={p}>{t(`priority.${p}`)}</option>
          ))}
        </select>

        <select
          value={fStatus}
          onChange={(e) => setFStatus(e.target.value)}
          className="select-field w-auto text-xs py-1.5"
        >
          <option value="">{t('alerts.allStatuses')}</option>
          {(['new_alert','assigned','in_progress','resolved','cancelled'] as AlertStatus[]).map((s) => (
            <option key={s} value={s}>{t(`alertStatus.${s}`, s)}</option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={fOverdue}
            onChange={(e) => setFOverdue(e.target.checked)}
            className="rounded border-white/20 bg-transparent"
          />
          {t('alerts.overdueOnly')}
        </label>

        <span className="ml-auto text-xs text-gray-600">{total} {t('alerts.totalAlerts')}</span>
      </div>

      {/* Table */}
      <div className="glass-card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <Spinner size="lg" />
          </div>
        ) : sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-3">
            <Bell size={36} className="text-gray-700" />
            <p className="text-gray-500 text-sm">{t('alerts.noAlerts')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.04]">
                  <th className="table-header-cell">{t('alerts.alertNumber')}</th>
                  <th className="table-header-cell">{t('alerts.machine')}</th>
                  <th className="table-header-cell hidden md:table-cell">{t('alerts.department')}</th>
                  <th className="table-header-cell hidden lg:table-cell">{t('alerts.problemType')}</th>
                  <th className="table-header-cell">{t('common.priority')}</th>
                  <th className="table-header-cell">{t('common.status')}</th>
                  <th className="table-header-cell hidden xl:table-cell">{t('alerts.timeOpen')}</th>
                  <th className="table-header-cell hidden xl:table-cell">{t('alerts.escalation')}</th>
                  <th className="table-header-cell">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((alert) => {
                  const resolved = isResolved(alert);
                  return (
                    <tr
                      key={alert.id}
                      className={`table-row ${resolved ? 'opacity-50' : PRIORITY_ROW[alert.priority] ?? ''} ${!resolved && alert.is_overdue ? 'outline outline-1 outline-amber-500/20' : ''}`}
                    >
                      <td className="table-cell">
                        <Link to={`/alerts/${alert.id}`} className="font-mono text-amber-400 text-xs hover:text-amber-300 hover:underline underline-offset-2">
                          {alert.alert_number}
                        </Link>
                      </td>
                      <td className="table-cell font-medium text-gray-200">
                        {alert.machine_name ?? '—'}
                      </td>
                      <td className="table-cell hidden md:table-cell text-gray-400 text-xs">
                        {alert.department ?? '—'}
                      </td>
                      <td className="table-cell hidden lg:table-cell">
                        <span className="text-xs text-gray-400">
                          {t(`problemType.${alert.problem_type}`, alert.problem_type)}
                        </span>
                      </td>
                      <td className="table-cell">
                        <span className={`inline-flex items-center px-2 py-0.5 text-xs font-mono font-medium border rounded ${PRIORITY_BADGE[alert.priority]}`}>
                          {t(`priority.${alert.priority}`)}
                        </span>
                      </td>
                      <td className="table-cell">
                        <span className={`inline-flex items-center px-2 py-0.5 text-xs font-mono font-medium border rounded ${STATUS_BADGE[alert.status]}`}>
                          {t(`alertStatus.${alert.status}`, alert.status)}
                        </span>
                      </td>
                      <td className="table-cell hidden xl:table-cell">
                        <span className={`font-mono text-xs ${slaColor(alert.priority, alert.created_at)}`}>
                          {timeOpen(alert.created_at)}
                        </span>
                        {!resolved && alert.is_overdue && (
                          <AlertTriangle size={11} className="inline ml-1 text-amber-400" />
                        )}
                      </td>
                      <td className="table-cell hidden xl:table-cell">
                        {alert.escalation_level > 0 ? (
                          <span className="text-xs text-red-400 font-mono">L{alert.escalation_level}</span>
                        ) : (
                          <span className="text-xs text-gray-700">—</span>
                        )}
                      </td>
                      <td className="table-cell">
                        {resolved ? (
                          <span className="text-xs text-gray-600 font-mono">
                            {alert.status === 'resolved' ? '✓ Resolved' : 'Cancelled'}
                          </span>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            {alert.status === 'new_alert' && !alert.ticket_id && (
                              <button
                                onClick={() => handleAssign(alert.id)}
                                disabled={actionId === alert.id}
                                title={t('alerts.assignToMe')}
                                className="btn-secondary py-1 px-2 text-xs gap-1"
                              >
                                <UserPlus size={12} />
                                <span className="hidden sm:inline">{t('alerts.assignToMe')}</span>
                              </button>
                            )}
                            {alert.ticket_id ? (
                              <button
                                onClick={() => navigate(`/tickets/${alert.ticket_id}`)}
                                className="btn-secondary py-1 px-2 text-xs gap-1"
                              >
                                <Clock size={12} />
                                <span className="hidden sm:inline">{t('alerts.viewTicket')}</span>
                              </button>
                            ) : (
                              <button
                                onClick={() => handleConvert(alert.id)}
                                disabled={actionId === alert.id}
                                title={t('alerts.convertToTicket')}
                                className="btn-warning py-1 px-2 text-xs gap-1"
                              >
                                <ArrowRightCircle size={12} />
                                <span className="hidden sm:inline">{t('alerts.convertToTicket')}</span>
                              </button>
                            )}
                          </div>
                        )}
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
