import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { EventInput, EventClickArg } from '@fullcalendar/core';
import { useNavigate } from 'react-router-dom';
import { fetchMaintenancePlans, fetchWorkOrders } from '../../api/workOrders';
import type { MaintenancePlan, WorkOrder } from '../../types';

// FullCalendar dark theme overrides injected once
const FC_DARK_CSS = `
  .fc { --fc-border-color: rgba(255,255,255,0.06); --fc-page-bg-color: transparent; --fc-neutral-bg-color: transparent; --fc-list-event-hover-bg-color: rgba(255,255,255,0.04); }
  .fc .fc-toolbar-title { color: #f1f5f9; font-size: 1rem; font-weight: 600; }
  .fc .fc-button { background: #0d1421 !important; border-color: rgba(255,255,255,0.08) !important; color: #94a3b8 !important; font-size: 0.75rem !important; }
  .fc .fc-button:hover { background: #1e293b !important; color: #e2e8f0 !important; }
  .fc .fc-button-primary:not(.fc-button-active):focus { box-shadow: none !important; }
  .fc .fc-button-active { background: #2563eb !important; color: #fff !important; border-color: #2563eb !important; }
  .fc th { color: #64748b; font-size: 0.7rem; font-weight: 500; text-transform: uppercase; }
  .fc td, .fc th { border-color: rgba(255,255,255,0.06) !important; }
  .fc .fc-daygrid-day-number { color: #94a3b8; font-size: 0.75rem; }
  .fc .fc-daygrid-day.fc-day-today { background: rgba(37,99,235,0.06) !important; }
  .fc .fc-event { border: none; cursor: pointer; font-size: 0.7rem; }
  .fc .fc-daygrid-event-dot { display: none; }
  .fc .fc-h-event .fc-event-title { padding: 1px 4px; }
`;

const STATUS_EVENT_COLORS: Record<string, string> = {
  open: '#3b82f6',
  in_progress: '#f59e0b',
  completed: '#22c55e',
  on_hold: '#64748b',
  cancelled: '#ef4444',
};

export default function PMCalendar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [plans, setPlans] = useState<MaintenancePlan[]>([]);
  const [wos, setWOs] = useState<WorkOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const styleInjected = useRef(false);

  useEffect(() => {
    if (!styleInjected.current) {
      const style = document.createElement('style');
      style.textContent = FC_DARK_CSS;
      document.head.appendChild(style);
      styleInjected.current = true;
    }
  }, []);

  useEffect(() => {
    Promise.allSettled([
      fetchMaintenancePlans(),
      fetchWorkOrders({ type: 'preventive', limit: '200' }),
    ]).then(([p, w]) => {
      if (p.status === 'fulfilled') setPlans(p.value);
      if (w.status === 'fulfilled') setWOs(w.value);
      setLoading(false);
    });
  }, []);

  const planEvents: EventInput[] = plans
    .filter((p) => p.next_execution_at)
    .map((p) => ({
      id: `plan-${p.id}`,
      title: `📋 ${p.name}`,
      start: p.next_execution_at!,
      backgroundColor: '#1d4ed8',
      borderColor: '#1d4ed8',
      extendedProps: { type: 'plan', plan: p },
    }));

  const woEvents: EventInput[] = wos
    .filter((w) => w.due_date || w.opened_at)
    .map((w) => ({
      id: `wo-${w.id}`,
      title: `🔧 ${w.wo_number} · ${w.title}`,
      start: w.due_date ?? w.opened_at,
      backgroundColor: STATUS_EVENT_COLORS[w.status] ?? '#64748b',
      borderColor: STATUS_EVENT_COLORS[w.status] ?? '#64748b',
      extendedProps: { type: 'wo', wo: w },
    }));

  const handleEventClick = (info: EventClickArg) => {
    const { type, wo } = info.event.extendedProps as { type: string; wo?: WorkOrder };
    if (type === 'wo' && wo) {
      navigate(`/work-orders/${wo.id}`);
    }
  };

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">{t('pmCalendar.title')}</h1>
        <p className="text-gray-500 text-sm mt-0.5">{t('pmCalendar.subtitle')}</p>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 flex-wrap">
        <LegendItem color="#1d4ed8" label={t('pmCalendar.plannedPM')} />
        <LegendItem color="#3b82f6" label={t('status.open')} />
        <LegendItem color="#f59e0b" label={t('status.in_progress')} />
        <LegendItem color="#22c55e" label={t('status.completed')} />
        <LegendItem color="#ef4444" label={t('status.cancelled')} />
      </div>

      {/* Calendar */}
      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
        {loading ? (
          <div className="flex items-center justify-center h-64 text-gray-500 text-sm">
            {t('common.loading')}
          </div>
        ) : (
          <FullCalendar
            plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
            initialView="dayGridMonth"
            headerToolbar={{
              left: 'prev,next today',
              center: 'title',
              right: 'dayGridMonth,timeGridWeek',
            }}
            events={[...planEvents, ...woEvents]}
            eventClick={handleEventClick}
            height="auto"
            dayMaxEvents={4}
            moreLinkText={(n) => `+${n} more`}
            eventDisplay="block"
          />
        )}
      </div>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: color }} />
      <span className="text-xs text-gray-500">{label}</span>
    </div>
  );
}
