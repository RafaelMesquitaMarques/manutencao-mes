import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { EventInput, EventClickArg } from '@fullcalendar/core';
import { useNavigate } from 'react-router-dom';
import { fetchPmCalendar } from '../../api/maintenancePlans';
import type { PlanCalendarItem } from '../../types';

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
  .fc .fc-event.pm-cancelled { opacity: 0.45; text-decoration: line-through; }
  .fc .fc-event.pm-overridden { border-left: 3px solid #fbbf24 !important; }
  .fc .fc-daygrid-event-dot { display: none; }
  .fc .fc-h-event .fc-event-title { padding: 1px 4px; }
`;

const STATUS_EVENT_COLORS: Record<string, string> = {
  scheduled: '#3b82f6',
  in_progress: '#f59e0b',
  completed: '#22c55e',
  skipped: '#64748b',
  cancelled: '#64748b',
};

const OVERDUE_COLOR = '#ef4444';

export default function PMCalendar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const styleInjected = useRef(false);

  if (!styleInjected.current) {
    const style = document.createElement('style');
    style.textContent = FC_DARK_CSS;
    document.head.appendChild(style);
    styleInjected.current = true;
  }

  const today = new Date().toISOString().slice(0, 10);

  const loadEvents = async (info: { startStr: string; endStr: string }): Promise<EventInput[]> => {
    try {
      const items = await fetchPmCalendar(info.startStr.slice(0, 10), info.endStr.slice(0, 10));
      return items.map((item: PlanCalendarItem) => {
        const overdue = !item.is_cancelled && item.status === 'scheduled' && item.date < today;
        const color = overdue ? OVERDUE_COLOR : (STATUS_EVENT_COLORS[item.status] ?? '#64748b');
        const classNames: string[] = [];
        if (item.is_cancelled) classNames.push('pm-cancelled');
        if (item.is_overridden) classNames.push('pm-overridden');
        return {
          id: item.id,
          title: `📋 ${item.plan_name}${item.equipment_name ? ` · ${item.equipment_name}` : ''}`,
          start: item.date,
          backgroundColor: color,
          borderColor: color,
          classNames,
          extendedProps: { item },
        };
      });
    } catch {
      return [];
    }
  };

  const handleEventClick = (info: EventClickArg) => {
    const { item } = info.event.extendedProps as { item: PlanCalendarItem };
    if (item?.plan_id) {
      navigate(`/maintenance/plans/${item.plan_id}`);
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
        <LegendItem color={STATUS_EVENT_COLORS.scheduled} label={t('pm.occurrenceStatus.scheduled')} />
        <LegendItem color={STATUS_EVENT_COLORS.in_progress} label={t('pm.occurrenceStatus.in_progress')} />
        <LegendItem color={STATUS_EVENT_COLORS.completed} label={t('pm.occurrenceStatus.completed')} />
        <LegendItem color={STATUS_EVENT_COLORS.skipped} label={t('pm.occurrenceStatus.skipped')} />
        <LegendItem color={OVERDUE_COLOR} label={t('pmCalendar.overdue')} />
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-gray-600 border-l-[3px] border-amber-400" />
          <span className="text-xs text-gray-500">{t('pmCalendar.overridden')}</span>
        </div>
      </div>

      {/* Calendar */}
      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek',
          }}
          events={loadEvents}
          eventClick={handleEventClick}
          height="auto"
          dayMaxEvents={4}
          moreLinkText={(n) => `+${n} more`}
          eventDisplay="block"
        />
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
