import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchMachinePage, fetchTodayStops, fetchProductionHourly, type HourlyPoint } from '../../api/machines';
import type { MachinePageData, MachineStopOut } from '../../types';
import { statusColor, STATUS_LABEL } from '../../utils/statusColors';
import { StopTimeline, ProductionChart, buildShiftWindows, type Lang, type ShiftWindow } from '../Machines/MachinePage';
import { useMachineLive } from '../../hooks/useLiveEvents';

// Current UI language as a Lang (drives the shared kiosk components + status labels).
function useLang(): Lang {
  const { i18n } = useTranslation();
  const l = (i18n.language || 'en').slice(0, 2);
  return (l === 'fr' || l === 'es' ? l : 'en') as Lang;
}

// Current shift window for a machine (no nav — dashboards always show "now").
function currentWin(shiftsConfig: MachinePageData['shifts_config']): ShiftWindow | null {
  const wins = buildShiftWindows(shiftsConfig, new Date());
  const now = Date.now();
  let idx = wins.findIndex((w) => now >= w.start.getTime() && now < w.end.getTime());
  if (idx < 0) for (let i = wins.length - 1; i >= 0; i--) { if (wins[i].start.getTime() <= now) { idx = i; break; } }
  return wins[idx] ?? wins[0] ?? null;
}

function WidgetShell({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="h-full bg-[#0d1421] rounded-xl border border-white/[0.06] p-3 overflow-hidden flex flex-col">
      {title && <p className="text-[11px] text-gray-600 uppercase tracking-widest mb-2 font-semibold text-center">{title}</p>}
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

// Machine data + a live tick: bumps on a WS event for this machine so dependent
// fetches re-run instantly; the interval is only a fallback for a dropped socket.
function useMachine(machineId: string | null) {
  const [m, setM] = useState<MachinePageData | null>(null);
  const [liveTick, setLiveTick] = useState(0);
  useMachineLive([machineId, m?.code, m?.page_slug], () => setLiveTick((n) => n + 1));
  useEffect(() => {
    if (!machineId) return;
    let on = true;
    const load = () => fetchMachinePage(machineId).then((d) => { if (on) setM(d); }).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => { on = false; clearInterval(id); };
  }, [machineId, liveTick]);
  return { m, liveTick };
}

export function StatusWidget({ machineId }: { machineId: string }) {
  const lang = useLang();
  const { m } = useMachine(machineId);
  if (!m) return <WidgetShell><span className="text-gray-600 text-sm m-auto">…</span></WidgetShell>;
  const color = statusColor(m.current_status);
  const label = (STATUS_LABEL[m.current_status as string] || {})[lang] ?? String(m.current_status ?? '');
  return (
    <div className="h-full rounded-xl border p-4 flex flex-col justify-between overflow-hidden"
      style={{ background: `${color}22`, borderColor: `${color}66` }}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-bold text-white truncate">{m.display_name || m.name}</span>
        <span style={{ background: color }} className="w-3 h-3 rounded-full shrink-0" />
      </div>
      <div className="min-w-0">
        <p className="text-2xl font-black uppercase tracking-wide truncate" style={{ color }}>{label}</p>
        <p className="text-xs text-gray-300 truncate mt-1">{m.current_operator || '—'}</p>
      </div>
    </div>
  );
}

export function StopsWidget({ machineId }: { machineId: string }) {
  const { t } = useTranslation();
  const lang = useLang();
  const { m, liveTick } = useMachine(machineId);
  const [stops, setStops] = useState<MachineStopOut[]>([]);
  const win = currentWin(m?.shifts_config ?? null);
  const winStart = win?.start.toISOString();
  const winEnd = win?.end.toISOString();
  useEffect(() => {
    if (!machineId || !winStart || !winEnd) return;
    let on = true;
    const load = () => fetchTodayStops(machineId, { start: winStart, end: winEnd })
      .then((s) => { if (on) setStops(s); }).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => { on = false; clearInterval(id); };
  }, [machineId, winStart, winEnd, liveTick]);
  return (
    <WidgetShell title={t('dashboards.stopsTitle', 'Machine stops')}>
      <StopTimeline win={win} stops={stops} nowMs={Date.now()} lang={lang}
        canNavigate={false} atCurrent canGoBack={false} onPrev={() => {}} onNext={() => {}} />
    </WidgetShell>
  );
}

export function ProductionWidget({ machineId }: { machineId: string }) {
  const lang = useLang();
  const { m, liveTick } = useMachine(machineId);
  const [hours, setHours] = useState<HourlyPoint[]>([]);
  const win = currentWin(m?.shifts_config ?? null);
  const winStart = win?.start.toISOString();
  const winEnd = win?.end.toISOString();
  useEffect(() => {
    if (!machineId || !winStart || !winEnd) return;
    let on = true;
    const load = () => fetchProductionHourly(machineId, { start: winStart, end: winEnd })
      .then((r) => { if (on) setHours(r.hours); }).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => { on = false; clearInterval(id); };
  }, [machineId, winStart, winEnd, liveTick]);
  return (
    <WidgetShell>
      <ProductionChart win={win} hours={hours} nowMs={Date.now()} lang={lang}
        title={m ? (m.display_name || m.name) : ''}
        canNavigate={false} atCurrent canGoBack={false} onPrev={() => {}} onNext={() => {}} />
    </WidgetShell>
  );
}

export function Widget({ widget, machineId }: { widget: string; machineId: string | null }) {
  if (!machineId) return <WidgetShell><span className="text-gray-600 text-sm m-auto">—</span></WidgetShell>;
  if (widget === 'status') return <StatusWidget machineId={machineId} />;
  if (widget === 'stops') return <StopsWidget machineId={machineId} />;
  if (widget === 'production') return <ProductionWidget machineId={machineId} />;
  return <WidgetShell><span className="text-gray-600 m-auto">?</span></WidgetShell>;
}
