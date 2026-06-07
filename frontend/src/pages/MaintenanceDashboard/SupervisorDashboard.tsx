import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Ticket, Wrench, CalendarDays, ChevronRight,
  AlertTriangle, CheckCircle2, Clock, ArrowRight,
  RefreshCw,
} from 'lucide-react';
import { fetchSupervisorOverview, generateWorkOrder } from '../../api/maintenance';
import { assignWorkOrder, scheduleWorkOrder, fetchTechniciansFull } from '../../api/workOrders';
import type { SupervisorOverview, TicketSummary, WOSummary, TechnicianFull } from '../../types';
import Spinner from '../../components/ui/Spinner';

const PRIORITY_DOT: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-amber-500',
  low: 'bg-green-500',
};

const fmt = (d?: string | null) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

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

function PendingTicketRow({ ticket, techs, onGenerated }: {
  ticket: TicketSummary;
  techs: TechnicianFull[];
  onGenerated: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const doGenerate = async () => {
    setBusy(true);
    try {
      await generateWorkOrder(ticket.id);
      onGenerated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-3 border-b border-white/[0.04] last:border-0">
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${PRIORITY_DOT[ticket.priority] ?? 'bg-gray-500'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-gray-400">{ticket.ticket_number}</span>
            {ticket.is_overdue && <span className="text-[10px] text-red-400 flex items-center gap-0.5"><AlertTriangle size={10} /> Overdue</span>}
            {ticket.current_escalation_level > 0 && (
              <span className="text-[10px] text-orange-400">ESC L{ticket.current_escalation_level}</span>
            )}
          </div>
          <p className="text-xs text-gray-500 truncate">{ticket.machine_name ?? '—'} · {ticket.problem_type.replace(/_/g, ' ')}</p>
          <p className="text-[10px] text-gray-700 mt-0.5">{fmt(ticket.opened_at)}</p>
        </div>
        <div className="flex gap-1.5 flex-shrink-0">
          <button
            onClick={() => navigate(`/tickets/${ticket.id}`)}
            className="p-1.5 text-gray-600 hover:text-gray-300 transition-colors"
            title="View ticket"
          >
            <ChevronRight size={14} />
          </button>
          <button
            onClick={doGenerate}
            disabled={busy}
            className="px-2 py-1 text-[11px] font-medium bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-500/30 rounded transition-colors disabled:opacity-50"
          >
            {busy ? t('supervisor.generating') : t('supervisor.generateWO')}
          </button>
        </div>
      </div>
    </div>
  );
}

function UnassignedWORow({ wo, techs, onAssigned }: {
  wo: WOSummary;
  techs: TechnicianFull[];
  onAssigned: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [showForm, setShowForm] = useState(false);
  const [selectedTech, setSelectedTech] = useState('');
  const [busy, setBusy] = useState(false);

  const doAssign = async () => {
    if (!selectedTech) return;
    setBusy(true);
    try {
      await assignWorkOrder(wo.id, selectedTech);
      onAssigned();
    } finally {
      setBusy(false);
      setShowForm(false);
    }
  };

  return (
    <div className="p-3 border-b border-white/[0.04] last:border-0">
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${PRIORITY_DOT[wo.priority] ?? 'bg-gray-500'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-gray-400">{wo.wo_number}</span>
            {wo.ticket_number && (
              <span className="text-[10px] text-purple-400 bg-purple-500/10 border border-purple-500/20 px-1.5 py-0.5 rounded font-mono">
                {wo.ticket_number}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 truncate">{wo.machine_name ?? '—'}</p>
        </div>
        <div className="flex gap-1.5 flex-shrink-0">
          <button
            onClick={() => navigate(`/work-orders/${wo.id}`)}
            className="p-1.5 text-gray-600 hover:text-gray-300 transition-colors"
            title="View WO"
          >
            <ChevronRight size={14} />
          </button>
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-2 py-1 text-[11px] font-medium bg-amber-600/20 hover:bg-amber-600/30 text-amber-400 border border-amber-500/30 rounded transition-colors"
          >
            {t('supervisor.assign')}
          </button>
        </div>
      </div>
      {showForm && (
        <div className="mt-2 flex gap-2 ml-4">
          <select
            value={selectedTech}
            onChange={(e) => setSelectedTech(e.target.value)}
            className="input-field text-xs flex-1 py-1"
          >
            <option value="">{t('supervisor.selectTechnician')}</option>
            {techs.map((t) => (
              <option key={t.id} value={t.id}>{t.full_name ?? t.email}</option>
            ))}
          </select>
          <button
            onClick={doAssign}
            disabled={busy || !selectedTech}
            className="px-2 py-1 text-[11px] font-medium bg-amber-600/30 text-amber-300 rounded disabled:opacity-50"
          >
            {busy ? t('supervisor.assigning') : t('common.confirm')}
          </button>
        </div>
      )}
    </div>
  );
}

function UnscheduledWORow({ wo, techs, onScheduled }: {
  wo: WOSummary;
  techs: TechnicianFull[];
  onScheduled: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [showForm, setShowForm] = useState(false);
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [selectedTech, setSelectedTech] = useState(wo.executor_id ?? '');
  const [busy, setBusy] = useState(false);

  const doSchedule = async () => {
    if (!date || !selectedTech) return;
    setBusy(true);
    try {
      await scheduleWorkOrder(wo.id, {
        executor_id: selectedTech,
        scheduled_date: date,
        scheduled_start_time: startTime || undefined,
        scheduled_end_time: endTime || undefined,
      });
      onScheduled();
    } finally {
      setBusy(false);
      setShowForm(false);
    }
  };

  return (
    <div className="p-3 border-b border-white/[0.04] last:border-0">
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${PRIORITY_DOT[wo.priority] ?? 'bg-gray-500'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-gray-400">{wo.wo_number}</span>
            {wo.ticket_number && (
              <span className="text-[10px] text-purple-400 bg-purple-500/10 border border-purple-500/20 px-1.5 py-0.5 rounded font-mono">
                {wo.ticket_number}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 truncate">
            {wo.machine_name ?? '—'}
            {wo.executor_name && <span className="text-gray-600"> · {wo.executor_name}</span>}
          </p>
        </div>
        <div className="flex gap-1.5 flex-shrink-0">
          <button
            onClick={() => navigate(`/work-orders/${wo.id}`)}
            className="p-1.5 text-gray-600 hover:text-gray-300 transition-colors"
            title="View WO"
          >
            <ChevronRight size={14} />
          </button>
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-2 py-1 text-[11px] font-medium bg-green-600/20 hover:bg-green-600/30 text-green-400 border border-green-500/30 rounded transition-colors"
          >
            {t('supervisor.schedule')}
          </button>
        </div>
      </div>
      {showForm && (
        <div className="mt-2 ml-4 space-y-2">
          <div className="flex gap-2">
            <select
              value={selectedTech}
              onChange={(e) => setSelectedTech(e.target.value)}
              className="input-field text-xs flex-1 py-1"
            >
              <option value="">{t('supervisor.selectTechnician')}</option>
              {techs.map((t) => (
                <option key={t.id} value={t.id}>{t.full_name ?? t.email}</option>
              ))}
            </select>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="input-field text-xs py-1 w-36"
            />
          </div>
          <div className="flex gap-2">
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              placeholder={t('supervisor.startTime')}
              className="input-field text-xs py-1 flex-1"
            />
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              placeholder={t('supervisor.endTime')}
              className="input-field text-xs py-1 flex-1"
            />
            <button
              onClick={doSchedule}
              disabled={busy || !date || !selectedTech}
              className="px-2 py-1 text-[11px] font-medium bg-green-600/30 text-green-300 rounded disabled:opacity-50"
            >
              {busy ? t('supervisor.scheduling') : t('common.confirm')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SupervisorDashboard() {
  const { t } = useTranslation();
  const [overview, setOverview] = useState<SupervisorOverview | null>(null);
  const [techs, setTechs] = useState<TechnicianFull[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    Promise.allSettled([fetchSupervisorOverview(), fetchTechniciansFull()]).then(([ov, te]) => {
      if (ov.status === 'fulfilled') setOverview(ov.value);
      if (te.status === 'fulfilled') setTechs(te.value);
      setLoading(false);
    });
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('supervisor.title')}</h1>
          <p className="text-gray-500 text-sm mt-0.5">{t('supervisor.subtitle')}</p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="btn-secondary py-1.5 px-3 flex items-center gap-1.5"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Flow indicator */}
      <div className="glass-card p-3 flex items-center gap-2 flex-wrap text-xs text-gray-500">
        <div className="flex items-center gap-1.5">
          <Ticket size={13} className="text-blue-400" />
          <span className="text-blue-400 font-medium">Ticket</span>
        </div>
        <ArrowRight size={12} className="text-gray-700" />
        <div className="flex items-center gap-1.5">
          <Wrench size={13} className="text-amber-400" />
          <span className="text-amber-400 font-medium">Generate WO</span>
        </div>
        <ArrowRight size={12} className="text-gray-700" />
        <div className="flex items-center gap-1.5">
          <CheckCircle2 size={13} className="text-green-400" />
          <span className="text-green-400 font-medium">Assign</span>
        </div>
        <ArrowRight size={12} className="text-gray-700" />
        <div className="flex items-center gap-1.5">
          <CalendarDays size={13} className="text-purple-400" />
          <span className="text-purple-400 font-medium">Schedule</span>
        </div>
        <ArrowRight size={12} className="text-gray-700" />
        <div className="flex items-center gap-1.5">
          <Clock size={13} className="text-gray-400" />
          <span className="text-gray-400 font-medium">Execute</span>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48">
          <Spinner size="lg" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Panel 1: Pending tickets (no WO) */}
          <div className="glass-card overflow-hidden flex flex-col">
            <PanelHeader
              icon={Ticket}
              title={t('supervisor.pendingTickets')}
              count={overview?.pending_tickets.length ?? 0}
              color="bg-blue-600/30"
            />
            <div className="flex-1 overflow-y-auto max-h-[480px]">
              {(overview?.pending_tickets.length ?? 0) === 0 ? (
                <div className="p-6 text-center text-gray-600 text-xs">{t('supervisor.noPendingTickets')}</div>
              ) : (
                overview!.pending_tickets.map((ticket) => (
                  <PendingTicketRow
                    key={ticket.id}
                    ticket={ticket}
                    techs={techs}
                    onGenerated={load}
                  />
                ))
              )}
            </div>
          </div>

          {/* Panel 2: Unassigned WOs */}
          <div className="glass-card overflow-hidden flex flex-col">
            <PanelHeader
              icon={Wrench}
              title={t('supervisor.unassignedWOs')}
              count={overview?.unassigned_wos.length ?? 0}
              color="bg-amber-600/30"
            />
            <div className="flex-1 overflow-y-auto max-h-[480px]">
              {(overview?.unassigned_wos.length ?? 0) === 0 ? (
                <div className="p-6 text-center text-gray-600 text-xs">{t('supervisor.noUnassignedWOs')}</div>
              ) : (
                overview!.unassigned_wos.map((wo) => (
                  <UnassignedWORow
                    key={wo.id}
                    wo={wo}
                    techs={techs}
                    onAssigned={load}
                  />
                ))
              )}
            </div>
          </div>

          {/* Panel 3: Assigned but not scheduled */}
          <div className="glass-card overflow-hidden flex flex-col">
            <PanelHeader
              icon={CalendarDays}
              title={t('supervisor.unscheduledWOs')}
              count={overview?.unscheduled_wos.length ?? 0}
              color="bg-green-600/30"
            />
            <div className="flex-1 overflow-y-auto max-h-[480px]">
              {(overview?.unscheduled_wos.length ?? 0) === 0 ? (
                <div className="p-6 text-center text-gray-600 text-xs">{t('supervisor.noUnscheduledWOs')}</div>
              ) : (
                overview!.unscheduled_wos.map((wo) => (
                  <UnscheduledWORow
                    key={wo.id}
                    wo={wo}
                    techs={techs}
                    onScheduled={load}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
