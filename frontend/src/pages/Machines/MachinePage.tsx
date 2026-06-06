import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import {
  AlertTriangle, CheckCircle2, Settings, Circle,
  Play, StopCircle, Wrench, X, ChevronRight,
  Clock, User, RefreshCw, Ticket,
} from 'lucide-react';
import { fetchMachinePage, updateMachineStatus, fetchMESData, requestMaintenance } from '../../api/machines';
import { openTicketField, closeTicket } from '../../api/maintenance';
import type { MachinePageData, MachineStatus, MESData, TicketForMachine } from '../../types';

const STATUS_CONFIG: Record<MachineStatus, { label: string; color: string; dot: string; icon: React.ElementType }> = {
  running:     { label: 'RUNNING',     color: 'text-green-400 bg-green-500/10 border-green-500/30',  dot: 'bg-green-400',  icon: Play },
  stopped:     { label: 'STOPPED',     color: 'text-red-400 bg-red-500/10 border-red-500/30',        dot: 'bg-red-400',    icon: StopCircle },
  maintenance: { label: 'MAINTENANCE', color: 'text-amber-400 bg-amber-500/10 border-amber-500/30',  dot: 'bg-amber-400',  icon: Wrench },
  idle:        { label: 'IDLE',        color: 'text-gray-400 bg-gray-500/10 border-gray-500/30',     dot: 'bg-gray-400',   icon: Circle },
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'text-red-400 bg-red-500/10 border-red-500/30',
  high:     'text-orange-400 bg-orange-500/10 border-orange-500/30',
  medium:   'text-sky-400 bg-sky-500/10 border-sky-500/30',
  low:      'text-gray-400 bg-gray-500/10 border-gray-500/30',
};

const PROBLEM_TYPE_LABELS: Record<string, string> = {
  mechanical: 'Mechanical', electrical: 'Electrical', pneumatic: 'Pneumatic',
  sensor: 'Sensor', safety_risk: 'Safety Risk', quality_impact: 'Quality Impact',
  machine_stop: 'Machine Stop', preventive_request: 'Preventive Request', other: 'Other',
};

const SHIFTS = ['morning', 'afternoon', 'night'];
const PROBLEM_TYPES = Object.keys(PROBLEM_TYPE_LABELS);
const PRIORITIES = ['low', 'medium', 'high', 'critical'];

function fmt(d?: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function timeOpen(openedAt: string): string {
  const mins = Math.floor((Date.now() - new Date(openedAt).getTime()) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

export default function MachinePage() {
  const { slug } = useParams<{ slug: string }>();

  const [machine, setMachine]   = useState<MachinePageData | null>(null);
  const [mesData, setMesData]   = useState<MESData | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');

  // Maintenance request modal
  const [showRequest, setShowRequest] = useState(false);
  const [problemType, setProblemType] = useState('mechanical');
  const [priority, setPriority]       = useState('high');
  const [description, setDescription] = useState('');
  const [operatorName, setOperatorName] = useState('');
  const [shift, setShift]             = useState('morning');
  const [submitting, setSubmitting]   = useState(false);
  const [confirmedTicket, setConfirmedTicket] = useState<string | null>(null);

  // Technician close form
  const [closingTicketId, setClosingTicketId] = useState<string | null>(null);
  const [diagnosis, setDiagnosis]             = useState('');
  const [corrective, setCorrective]           = useState('');
  const [intMins, setIntMins]                 = useState('');
  const [techActionBusy, setTechActionBusy]   = useState(false);

  const load = () => {
    if (!slug) return;
    setLoading(true);
    setError('');
    Promise.allSettled([
      fetchMachinePage(slug),
      fetchMESData(slug),
    ]).then(([mp, md]) => {
      if (mp.status === 'fulfilled') {
        setMachine(mp.value);
        setOperatorName(mp.value.current_operator ?? '');
        setShift(mp.value.current_shift ?? 'morning');
      } else {
        setError('Machine not found');
      }
      if (md.status === 'fulfilled') setMesData(md.value);
      setLoading(false);
    });
  };

  useEffect(load, [slug]);

  const doRequest = async () => {
    if (!slug || !operatorName) return;
    setSubmitting(true);
    try {
      const r = await requestMaintenance(slug, {
        problem_type: problemType,
        priority,
        description: description || undefined,
        operator_name: operatorName,
        shift,
      });
      setConfirmedTicket(r.ticket_number);
      setShowRequest(false);
      load(); // refresh machine data
    } finally {
      setSubmitting(false);
    }
  };

  const doOpenField = async (ticketId: string) => {
    setTechActionBusy(true);
    try {
      await openTicketField(ticketId);
      load();
    } finally {
      setTechActionBusy(false);
    }
  };

  const doCloseField = async (ticketId: string) => {
    if (!diagnosis || !corrective || !intMins) return;
    setTechActionBusy(true);
    try {
      await closeTicket(ticketId, {
        diagnosis,
        corrective_action: corrective,
        total_intervention_minutes: parseInt(intMins),
      });
      setClosingTicketId(null);
      setDiagnosis(''); setCorrective(''); setIntMins('');
      load();
    } finally {
      setTechActionBusy(false);
    }
  };

  const doUpdateStatus = async (status: MachineStatus) => {
    if (!slug) return;
    await updateMachineStatus(slug, { status, current_operator: operatorName || undefined, current_shift: shift });
    load();
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="w-16 h-16 border-4 border-blue-500/30 border-t-blue-500 rounded-full animate-spin mx-auto" />
          <p className="text-gray-400 text-lg">Loading machine...</p>
        </div>
      </div>
    );
  }

  if (error || !machine) {
    return (
      <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center">
        <div className="text-center space-y-4">
          <AlertTriangle size={48} className="text-red-400 mx-auto" />
          <p className="text-white text-2xl font-bold">Machine Not Found</p>
          <p className="text-gray-400">{slug}</p>
        </div>
      </div>
    );
  }

  const statusCfg = STATUS_CONFIG[machine.current_status as MachineStatus] ?? STATUS_CONFIG.running;
  const StatusIcon = statusCfg.icon;
  const openTickets = machine.open_tickets ?? [];

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white">
      {/* ── Header ── */}
      <header className="bg-[#0d1421] border-b border-white/[0.06] px-6 py-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold text-white">{machine.name}</h1>
              {machine.code && (
                <span className="text-sm font-mono text-gray-500 bg-white/[0.04] border border-white/10 px-2 py-0.5 rounded">
                  {machine.code}
                </span>
              )}
            </div>
            {(machine.department || machine.location) && (
              <p className="text-gray-400 mt-1 text-base">
                {[machine.department, machine.location].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>

          <div className="flex items-center gap-3">
            {/* Status badge */}
            <span className={`flex items-center gap-2 px-4 py-2 rounded-xl border text-lg font-bold ${statusCfg.color}`}>
              <span className={`w-3 h-3 rounded-full animate-pulse ${statusCfg.dot}`} />
              {statusCfg.label}
            </span>

            <button onClick={load} className="p-2 text-gray-500 hover:text-gray-300 transition-colors">
              <RefreshCw size={18} />
            </button>
          </div>
        </div>

        {/* Operator & shift row */}
        <div className="flex items-center gap-6 mt-4 flex-wrap">
          <div className="flex items-center gap-2">
            <User size={16} className="text-gray-500" />
            <span className="text-gray-400 text-sm">Operator:</span>
            <input
              value={operatorName}
              onChange={(e) => setOperatorName(e.target.value)}
              onBlur={() => slug && operatorName && updateMachineStatus(slug, { status: machine.current_status as MachineStatus, current_operator: operatorName })}
              placeholder="Enter name..."
              className="bg-transparent border-b border-white/20 text-white text-sm px-1 py-0.5 focus:outline-none focus:border-blue-500 min-w-[140px]"
            />
          </div>
          <div className="flex items-center gap-2">
            <Clock size={16} className="text-gray-500" />
            <span className="text-gray-400 text-sm">Shift:</span>
            <select
              value={shift}
              onChange={(e) => {
                setShift(e.target.value);
                if (slug) updateMachineStatus(slug, { status: machine.current_status as MachineStatus, current_shift: e.target.value as 'morning' | 'afternoon' | 'night' });
              }}
              className="bg-transparent border-b border-white/20 text-white text-sm px-1 py-0.5 focus:outline-none focus:border-blue-500 capitalize cursor-pointer"
            >
              {SHIFTS.map((s) => <option key={s} value={s} className="bg-[#0d1421]">{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
            </select>
          </div>
          {machine.last_maintenance_at && (
            <div className="flex items-center gap-1.5 text-gray-600 text-sm">
              <Wrench size={14} />
              <span>Last maintenance: {fmt(machine.last_maintenance_at)}</span>
            </div>
          )}
        </div>
      </header>

      {/* ── Confirmed ticket banner ── */}
      {confirmedTicket && (
        <div className="bg-green-500/10 border-b border-green-500/30 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CheckCircle2 size={24} className="text-green-400" />
            <div>
              <p className="text-green-300 font-bold text-lg">Maintenance Team Notified</p>
              <p className="text-green-500 text-sm">Ticket created: <span className="font-mono font-bold">{confirmedTicket}</span></p>
            </div>
          </div>
          <button onClick={() => setConfirmedTicket(null)} className="text-green-600 hover:text-green-300">
            <X size={20} />
          </button>
        </div>
      )}

      <div className="p-6 space-y-6">
        {/* ── MES placeholder cards ── */}
        <div>
          <h2 className="text-lg font-semibold text-gray-300 mb-3 flex items-center gap-2">
            <Settings size={18} className="text-gray-500" />
            Production Data
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Production Count', value: mesData?.is_placeholder ? '—' : String(mesData?.production_count ?? 0) },
              { label: 'Target',           value: mesData?.is_placeholder ? '—' : String(mesData?.target ?? 0) },
              { label: 'OEE %',            value: mesData?.is_placeholder ? '—' : `${mesData?.oee_pct ?? 0}%` },
              { label: 'Downtime Today',   value: mesData?.is_placeholder ? '—' : `${mesData?.downtime_today_minutes ?? 0} min` },
            ].map(({ label, value }) => (
              <div
                key={label}
                className="bg-[#0d1421] rounded-xl border border-dashed border-white/[0.08] p-5 relative"
              >
                <p className="text-gray-500 text-sm font-medium">{label}</p>
                <p className="text-3xl font-bold text-gray-600 mt-2">{value}</p>
                {mesData?.is_placeholder && (
                  <span className="absolute top-2 right-2 text-[10px] text-gray-700 font-mono border border-gray-800 px-1.5 py-0.5 rounded">
                    MES Coming Soon
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ── Active tickets ── */}
        {openTickets.length > 0 && (
          <div>
            <h2 className="text-lg font-semibold text-gray-300 mb-3 flex items-center gap-2">
              <Ticket size={18} className="text-amber-400" />
              Active Maintenance ({openTickets.length})
            </h2>
            <div className="space-y-3">
              {openTickets.map((ticket: TicketForMachine) => (
                <div
                  key={ticket.id}
                  className="bg-[#0d1421] rounded-xl border border-amber-500/20 p-5 space-y-3"
                >
                  <div className="flex items-start justify-between flex-wrap gap-3">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-amber-400 font-mono font-bold text-lg">{ticket.ticket_number}</span>
                        <span className={`text-xs font-mono border rounded px-2 py-0.5 ${PRIORITY_COLORS[ticket.priority] ?? ''}`}>
                          {ticket.priority.toUpperCase()}
                        </span>
                        <span className="text-xs text-gray-500 bg-white/[0.04] border border-white/10 px-2 py-0.5 rounded font-mono">
                          {ticket.status.replace(/_/g, ' ').toUpperCase()}
                        </span>
                      </div>
                      {ticket.problem_type && (
                        <p className="text-gray-300 text-base font-medium">
                          {PROBLEM_TYPE_LABELS[ticket.problem_type] ?? ticket.problem_type}
                        </p>
                      )}
                      {ticket.description && (
                        <p className="text-gray-500 text-sm mt-1">{ticket.description}</p>
                      )}
                    </div>
                    <div className="text-right text-sm text-gray-500">
                      <p className="text-xs">{timeOpen(ticket.opened_at)}</p>
                      {ticket.assigned_to_name && (
                        <p className="flex items-center gap-1 mt-1">
                          <User size={12} />
                          {ticket.assigned_to_name}
                        </p>
                      )}
                      {ticket.work_order_number && (
                        <p className="font-mono text-blue-400 text-xs mt-1">{ticket.work_order_number}</p>
                      )}
                    </div>
                  </div>

                  {/* Technician actions */}
                  {ticket.status !== 'completed' && ticket.status !== 'cancelled' && (
                    <div className="border-t border-white/[0.06] pt-3 flex flex-wrap gap-2">
                      {!ticket.opened_by_technician_at && (
                        <button
                          onClick={() => doOpenField(ticket.id)}
                          disabled={techActionBusy}
                          className="flex items-center gap-2 bg-green-600/20 hover:bg-green-600/30 text-green-400 border border-green-500/30 rounded-lg px-4 py-2.5 text-sm font-bold transition-colors disabled:opacity-50"
                        >
                          <Play size={16} /> START WORK
                        </button>
                      )}
                      {ticket.status === 'in_progress' && (
                        <button
                          onClick={() => setClosingTicketId(ticket.id)}
                          className="flex items-center gap-2 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-500/30 rounded-lg px-4 py-2.5 text-sm font-bold transition-colors"
                        >
                          <CheckCircle2 size={16} /> COMPLETE WORK
                        </button>
                      )}
                    </div>
                  )}

                  {/* Close form */}
                  {closingTicketId === ticket.id && (
                    <div className="border-t border-white/[0.06] pt-4 space-y-3 bg-[#0b1120] rounded-lg p-4">
                      <div>
                        <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1.5">Diagnosis *</label>
                        <textarea
                          value={diagnosis}
                          onChange={(e) => setDiagnosis(e.target.value)}
                          rows={2}
                          placeholder="Describe what was found..."
                          className="w-full bg-[#0d1421] border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1.5">Corrective Action *</label>
                        <textarea
                          value={corrective}
                          onChange={(e) => setCorrective(e.target.value)}
                          rows={2}
                          placeholder="Describe what was done..."
                          className="w-full bg-[#0d1421] border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1.5">Intervention Time (min) *</label>
                        <input
                          type="number"
                          value={intMins}
                          onChange={(e) => setIntMins(e.target.value)}
                          min="0"
                          className="w-32 bg-[#0d1421] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                        />
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => doCloseField(ticket.id)}
                          disabled={techActionBusy || !diagnosis || !corrective || !intMins}
                          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-bold px-4 py-2.5 rounded-lg text-sm disabled:opacity-50 transition-colors"
                        >
                          <CheckCircle2 size={16} /> Confirm Completion
                        </button>
                        <button
                          onClick={() => setClosingTicketId(null)}
                          className="px-4 py-2.5 text-gray-400 hover:text-gray-200 text-sm rounded-lg border border-white/10 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Request Maintenance button ── */}
        {!showRequest && (
          <div className="pt-4">
            <button
              onClick={() => setShowRequest(true)}
              className="w-full py-6 rounded-2xl font-black text-2xl tracking-wide flex items-center justify-center gap-4 bg-red-600/20 hover:bg-red-600/30 text-red-400 border-2 border-red-500/40 hover:border-red-500/60 transition-all active:scale-95"
            >
              <AlertTriangle size={32} />
              REQUEST MAINTENANCE
            </button>
          </div>
        )}

        {/* ── Request form ── */}
        {showRequest && (
          <div className="bg-[#0d1421] rounded-2xl border border-red-500/20 p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-bold text-white flex items-center gap-2">
                <AlertTriangle size={20} className="text-red-400" />
                Request Maintenance
              </h3>
              <button onClick={() => setShowRequest(false)} className="text-gray-500 hover:text-gray-300">
                <X size={20} />
              </button>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-400 uppercase tracking-wide mb-2 font-medium">Problem Type *</label>
                <select
                  value={problemType}
                  onChange={(e) => setProblemType(e.target.value)}
                  className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-4 py-3 text-white text-base focus:outline-none focus:border-red-500 cursor-pointer"
                >
                  {PROBLEM_TYPES.map((p) => (
                    <option key={p} value={p} className="bg-[#0d1421]">{PROBLEM_TYPE_LABELS[p]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-400 uppercase tracking-wide mb-2 font-medium">Priority *</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-4 py-3 text-white text-base focus:outline-none focus:border-red-500 cursor-pointer"
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p} className="bg-[#0d1421]">{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm text-gray-400 uppercase tracking-wide mb-2 font-medium">Description (optional)</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="Describe the problem in detail..."
                className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-4 py-3 text-white text-base placeholder-gray-600 focus:outline-none focus:border-red-500 resize-none"
              />
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-400 uppercase tracking-wide mb-2 font-medium">Operator Name *</label>
                <input
                  value={operatorName}
                  onChange={(e) => setOperatorName(e.target.value)}
                  placeholder="Your full name"
                  className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-4 py-3 text-white text-base placeholder-gray-600 focus:outline-none focus:border-red-500"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 uppercase tracking-wide mb-2 font-medium">Shift</label>
                <select
                  value={shift}
                  onChange={(e) => setShift(e.target.value)}
                  className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-4 py-3 text-white text-base focus:outline-none focus:border-red-500 cursor-pointer"
                >
                  {SHIFTS.map((s) => <option key={s} value={s} className="bg-[#0d1421]">{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                </select>
              </div>
            </div>

            <button
              onClick={doRequest}
              disabled={submitting || !operatorName}
              className="w-full py-4 rounded-xl font-black text-xl bg-red-600 hover:bg-red-500 text-white flex items-center justify-center gap-3 disabled:opacity-50 transition-colors"
            >
              <AlertTriangle size={22} />
              {submitting ? 'Notifying Maintenance Team...' : 'CONFIRM — NOTIFY MAINTENANCE TEAM'}
            </button>
          </div>
        )}

        {/* ── Quick status change ── */}
        <div className="border-t border-white/[0.06] pt-4">
          <p className="text-xs text-gray-700 uppercase tracking-widest mb-3 font-semibold">Machine Status</p>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(STATUS_CONFIG) as MachineStatus[]).map((s) => {
              const cfg = STATUS_CONFIG[s];
              const isActive = machine.current_status === s;
              return (
                <button
                  key={s}
                  onClick={() => doUpdateStatus(s)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-all ${
                    isActive ? cfg.color + ' ring-1 ring-current' : 'border-white/10 text-gray-500 hover:text-gray-300 hover:border-white/20'
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full ${isActive ? cfg.dot : 'bg-gray-700'}`} />
                  {cfg.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
