import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ClipboardList, Play, AlertTriangle, CheckCircle2, Gauge, Activity,
  Factory, Ticket, Bell, Briefcase, ArrowRight, Plus, RefreshCw,
  TrendingDown, XCircle, HelpCircle, PowerOff, Timer, Hourglass,
  CalendarClock, Wrench, Package,
  type LucideIcon,
} from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { usePlantStore } from '../../store/plantStore';
import { useLiveBadges } from '../../hooks/useLiveBadges';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';
import {
  fetchDashboardStats, fetchWorkOrders, fetchKPISummary, fetchEquipment,
} from '../../api/workOrders';
import { fetchHomeInsights, type HomeInsight, type InsightSeverity } from '../../api/insights';
import type { DashboardStats, WorkOrder, KPISummary, Equipment, UserRole } from '../../types';
import Badge from '../../components/ui/Badge';
import FactoryPreview from './FactoryPreview';
import NeuralHud, { type HudNode, type HudTone } from './NeuralHud';
import HeroWorldMap from './HeroWorldMap';

// ─── Metric accents (kept on StatDef so the HUD node source stays typed) ────────
type Accent = 'blue' | 'amber' | 'red' | 'green' | 'indigo' | 'cyan' | 'emerald' | 'purple' | 'orange';

interface StatDef {
  key: string;
  label: string;
  value: number | string;
  sub?: string;
  icon: LucideIcon;
  accent: Accent;
  tone?: HudTone;
  to?: string;
}

// Traffic-light verdicts for HUD values. Count thresholds are pragmatic
// defaults; the OEE/availability bands follow the usual TPM benchmarks.
const fewerIsBetter = (v: number, greenMax: number, amberMax: number): HudTone =>
  v <= greenMax ? 'good' : v <= amberMax ? 'warn' : 'bad';
const higherIsBetter = (v: number, greenMin: number, amberMin: number): HudTone =>
  v >= greenMin ? 'good' : v >= amberMin ? 'warn' : 'bad';

// ─── Live insights (right rail) ─────────────────────────────────────────────────
const INSIGHT_ICONS: Record<string, LucideIcon> = {
  production_rate_drop: TrendingDown,
  reject_rate_high: XCircle,
  unjustified_stops: HelpCircle,
  stops_all_justified: CheckCircle2,
  ongoing_stop: PowerOff,
  downtime_spike: Timer,
  slow_response: Hourglass,
  stale_tickets: Ticket,
  alert_backlog: Bell,
  overdue_wos: CalendarClock,
  pm_compliance_low: Wrench,
  low_stock: Package,
  oee_strong_week: Gauge,
  oee_low_week: Gauge,
};

const INSIGHT_SEV: Record<InsightSeverity, { chip: string; text: string }> = {
  critical: { chip: 'bg-red-500/10 border-red-500/25 text-red-400', text: 'text-red-300' },
  warn: { chip: 'bg-amber-500/10 border-amber-500/25 text-amber-400', text: 'text-amber-200/90' },
  info: { chip: 'bg-blue-500/10 border-blue-500/25 text-blue-400', text: 'text-gray-300' },
  good: { chip: 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400', text: 'text-emerald-200/90' },
};

// "1 h 45 min" — unit symbols, so it reads the same in en/fr/es.
const fmtDuration = (mins: number) => {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
};

const HomePage = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const can = useAuthStore((s) => s.can);
  const memberships = usePlantStore((s) => s.memberships);
  const activePlantId = usePlantStore((s) => s.activePlantId);
  const activePlant = memberships.find((m) => m.plant_id === activePlantId) ?? memberships[0];
  const badges = useLiveBadges();

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [kpi, setKpi] = useState<KPISummary | null>(null);
  const [equip, setEquip] = useState<Equipment[] | null>(null);
  const [recentWOs, setRecentWOs] = useState<WorkOrder[]>([]);
  const [insights, setInsights] = useState<HomeInsight[] | null>(null);

  // Only hit endpoints the user is allowed to read — keeps the page 403-free and
  // tailors the cards to each role (an operator sees far less than a manager).
  const showWO = can('work_orders');
  const showKpi = can('kpis');
  const showEquip = can('equipment');
  const mapPlantId = activePlant?.plant_id ?? activePlantId;
  const showMap = can('factory_map') && !!mapPlantId;

  const load = useCallback(async () => {
    const [s, w, k, e, ins] = await Promise.allSettled([
      showWO ? fetchDashboardStats() : Promise.reject(),
      showWO ? fetchWorkOrders({ limit: '6' }) : Promise.reject(),
      showKpi ? fetchKPISummary(30) : Promise.reject(),
      // Whole production catalog, not the first page — the default limit (50)
      // returns mostly auxiliary assets alphabetically, skewing the roll-up.
      showEquip ? fetchEquipment({ asset_type: 'production', limit: '2000' }) : Promise.reject(),
      // The backend filters detectors by the caller's permissions, so this one
      // is safe (and meaningful) for every role.
      fetchHomeInsights(),
    ]);
    if (s.status === 'fulfilled') setStats(s.value as DashboardStats);
    if (w.status === 'fulfilled') setRecentWOs(w.value as WorkOrder[]);
    if (k.status === 'fulfilled') setKpi(k.value as KPISummary);
    if (e.status === 'fulfilled') setEquip(e.value as Equipment[]);
    if (ins.status === 'fulfilled') setInsights(ins.value.insights);
  }, [showWO, showKpi, showEquip]);

  useEffect(() => { load(); }, [load]);

  const { lastUpdatedAt, isRefreshing, manualRefresh } = useAutoRefresh(() => load());

  // ── Greeting ──────────────────────────────────────────────────────────────
  const role = (user?.role ?? 'operator') as UserRole;
  const firstName = (user?.name ?? '').trim().split(/\s+/)[0] || user?.email || '';
  // The ninja greets by the nickname chosen in User Management, when there is one.
  const greetName = (user?.nickname ?? '').trim() || firstName;
  const hour = new Date().getHours();
  const greetKey = hour < 12 ? 'goodMorning' : hour < 18 ? 'goodAfternoon' : 'goodEvening';
  const dateStr = new Date().toLocaleDateString(i18n.language, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  // ── Machine status roll-up (production assets only) ─────────────────────────
  const eff = (e: Equipment) => e.live_status ?? e.status;
  const machineList = (equip ?? []).filter(
    (e) => e.asset_type !== 'auxiliary' && eff(e) !== 'scrapped',
  );
  const running = machineList.filter((e) => eff(e) === 'running').length;
  const down = machineList.filter((e) => eff(e) === 'stopped' || eff(e) === 'in_maintenance').length;

  const pct = (v?: number | null) => (v == null ? '—' : `${Math.round(v)}%`);
  const linkIf = (resource: string, path: string) => (can(resource) ? path : undefined);

  // ── Cards (only those with data / permission) ───────────────────────────────
  const cards: StatDef[] = [];
  if (stats) {
    cards.push(
      { key: 'open',      label: t('dashboard.openWOs'),        value: stats.total_open,     icon: ClipboardList, accent: 'blue',  tone: fewerIsBetter(stats.total_open, 20, 60), to: linkIf('work_orders', '/work-orders') },
      { key: 'progress',  label: t('dashboard.inProgress'),     value: stats.in_progress,    icon: Play,          accent: 'amber', tone: fewerIsBetter(stats.in_progress, 10, 30), to: linkIf('work_orders', '/work-orders') },
      { key: 'critical',  label: t('dashboard.critical'),       value: stats.critical,       icon: AlertTriangle, accent: 'red',   tone: stats.critical === 0 ? 'good' : 'bad', to: linkIf('work_orders', '/work-orders') },
      // 0 completed reads as "attention", never as failure — mornings start at 0.
      { key: 'done',      label: t('dashboard.completedToday'), value: stats.completed_today, icon: CheckCircle2,  accent: 'green', tone: stats.completed_today > 0 ? 'good' : 'warn', to: linkIf('work_orders', '/work-orders') },
    );
  }
  if (kpi) {
    cards.push(
      { key: 'oee',   label: t('kpis.oee'),          value: pct(kpi.oee_pct),          sub: t('kpis.oeeSub'),          icon: Gauge,    accent: 'indigo', tone: kpi.oee_pct == null ? undefined : higherIsBetter(kpi.oee_pct, 85, 60), to: linkIf('kpis', '/kpis') },
      { key: 'avail', label: t('kpis.availability'), value: pct(kpi.availability_pct), sub: t('kpis.availabilitySub'), icon: Activity, accent: 'cyan',   tone: kpi.availability_pct == null ? undefined : higherIsBetter(kpi.availability_pct, 90, 75), to: linkIf('kpis', '/kpis') },
    );
  }
  if (equip && machineList.length > 0) {
    cards.push({
      key: 'machines',
      label: t('home.machinesRunning'),
      value: `${running}/${machineList.length}`,
      sub: down > 0 ? t('home.machinesDown', { count: down }) : undefined,
      icon: Factory,
      accent: 'emerald',
      tone: down === 0 ? 'good' : running / machineList.length >= 0.8 ? 'warn' : 'bad',
      to: linkIf('equipment', '/equipment'),
    });
  }
  cards.push({ key: 'mywork', label: t('home.myWork'), value: badges.myWorkCount, icon: Briefcase, accent: 'blue', tone: fewerIsBetter(badges.myWorkCount, 0, 5), to: '/my-work' });
  if (can('alerts')) cards.push({ key: 'alerts',  label: t('home.openAlerts'),  value: badges.alertCount,  icon: Bell,   accent: 'orange', tone: fewerIsBetter(badges.alertCount, 0, 3), to: '/gestion-bt' });
  if (can('tickets')) cards.push({ key: 'tickets', label: t('home.openTickets'), value: badges.ticketCount, icon: Ticket, accent: 'purple', tone: fewerIsBetter(badges.ticketCount, 0, 5), to: '/tickets' });

  // ── Neural HUD beside the greeting — the key metrics orbit the cognitive core.
  // Index 0 sits at 12 o'clock, the rest are laid out clockwise.
  const hudNodes: HudNode[] = cards.map((c) => ({
    to: c.to,
    label: c.label,
    value: String(c.value),
    tone: c.tone,
    icon: c.icon,
  }));

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Hero / greeting — the neural HUD floats over the card edges like a hologram.
          The xl top margin reserves headroom inside the scroll container so the
          overflowing rings are not clipped by the sticky header. */}
      <div className="glass-card relative z-30 p-5 md:p-6 xl:mt-14">
        <div className="absolute inset-0 overflow-hidden rounded-[inherit] pointer-events-none">
          <div className="absolute -top-16 -right-10 w-72 h-72 bg-blue-600/10 rounded-full blur-3xl" />
          <div className="absolute -bottom-24 left-1/4 w-72 h-72 bg-indigo-600/10 rounded-full blur-3xl" />
        </div>
        {/* Holographic world map — layered between the card background and the
            neural HUD (banner < map < radar). Not clipped: it bleeds past the
            banner edges like the hologram does. */}
        <div className="hidden xl:block absolute inset-0 pointer-events-none z-[5]">
          <HeroWorldMap
            activePlantId={activePlant?.plant_id ?? null}
            className="absolute right-[-1%] top-1/2 -translate-y-1/2 w-[48%]"
          />
        </div>
        <div className="relative flex items-start justify-between gap-4">
          <div className="min-w-0 xl:max-w-lg">
            <p className="text-blue-400 text-[11px] font-semibold uppercase tracking-widest mb-1.5 first-letter:uppercase">
              {dateStr}
            </p>
            <h1 className="text-2xl md:text-3xl font-bold text-white truncate">
              {t(`home.${greetKey}`, { name: greetName })}
            </h1>
            <div className="text-gray-400 text-sm mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{t(`roles.${role}`)}</span>
              {activePlant && (
                <>
                  <span className="text-gray-600">·</span>
                  <span className="inline-flex items-center gap-1.5">
                    <Factory size={13} className="text-blue-400" />
                    {activePlant.name}
                  </span>
                </>
              )}
            </div>
            <p className="text-gray-500 text-sm mt-2 max-w-lg">{t('home.tagline')}</p>
          </div>
          <div className="hidden sm:flex flex-col items-end gap-1 flex-shrink-0 relative z-20">
            {lastUpdatedAt && (
              <span className="text-[11px] text-gray-600 font-mono">
                {lastUpdatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            <button
              onClick={manualRefresh}
              disabled={isRefreshing}
              className="btn-secondary py-1.5 px-3"
            >
              <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
        <div className="hidden xl:flex absolute inset-y-0 left-[20%] right-[24%] z-10 items-center justify-center pointer-events-none">
          <div className="w-[460px]">
            <NeuralHud
              nodes={hudNodes}
              coreTo={can('intelligence') ? '/intelligence' : undefined}
              coreHint={t('hud.askNinja')}
            />
          </div>
        </div>
      </div>

      {/* Factory overview + recent work orders + quick access.
          The xl top padding clears the hologram overflowing the hero above. */}
      <div className="grid lg:grid-cols-3 gap-4 xl:pt-20">
        {/* Live 3D view of the whole plant — the "walking in from above" window */}
        {showMap && (
          <div className="lg:col-span-2">
            <FactoryPreview key={mapPlantId} plantId={mapPlantId as string} />
          </div>
        )}

        {/* Recent WOs */}
        {showWO && (
          <div className="glass-card overflow-hidden lg:col-span-2">
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
              <h2 className="text-white font-semibold text-sm">{t('home.recentWork')}</h2>
              <Link
                to="/work-orders"
                className="flex items-center gap-1.5 text-blue-400 hover:text-blue-300 text-xs font-medium transition-colors"
              >
                {t('dashboard.viewAll')} <ArrowRight size={12} />
              </Link>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/[0.04]">
                    <th className="table-header-cell">{t('workOrders.woNumber')}</th>
                    <th className="table-header-cell">{t('workOrders.titleField')}</th>
                    <th className="table-header-cell hidden md:table-cell">{t('common.priority')}</th>
                    <th className="table-header-cell">{t('common.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {recentWOs.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-12 text-center">
                        <ClipboardList size={32} className="mx-auto text-gray-700 mb-3" />
                        <p className="text-gray-500 text-sm mb-4">{t('workOrders.noResults')}</p>
                        {can('work_orders', 'create') && (
                          <Link to="/work-orders/new" className="btn-primary inline-flex gap-1.5 py-2 px-4 text-sm">
                            <Plus size={15} />
                            {t('workOrders.createFirst')}
                          </Link>
                        )}
                      </td>
                    </tr>
                  ) : recentWOs.map((wo) => (
                    <tr
                      key={wo.id}
                      className="table-row cursor-pointer"
                      onClick={() => navigate(`/work-orders/${wo.id}`)}
                    >
                      <td className="table-cell">
                        <span className="font-mono text-blue-400 text-xs">{wo.wo_number}</span>
                      </td>
                      <td className="table-cell max-w-[240px]">
                        <span className="truncate block text-gray-200">{wo.title}</span>
                      </td>
                      <td className="table-cell hidden md:table-cell">
                        <Badge value={wo.priority} variant="priority" />
                      </td>
                      <td className="table-cell">
                        <Badge value={wo.status} variant="status" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Live insights — right rail beside the 3D view + recent WOs stack.
            The backend flags what is off-normal right now (rate drops, missing
            stop reasons, slow response…); each row deep-links to its module. */}
        <div className={`glass-card p-5 ${
          showMap && showWO ? 'lg:col-start-3 lg:row-start-1 lg:row-span-2'
          : !showMap && !showWO ? 'lg:col-span-3' : ''
        }`}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-white font-semibold text-sm">{t('home.liveInsights')}</h2>
            <span className="relative flex h-2 w-2" title={t('home.liveInsightsHint')}>
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-50" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
            </span>
          </div>
          {insights === null ? (
            <div className="space-y-1.5">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-2.5 animate-pulse">
                  <span className="w-8 h-8 rounded-lg bg-white/[0.05] flex-shrink-0" />
                  <span className="h-3 rounded bg-white/[0.05] flex-1" />
                </div>
              ))}
            </div>
          ) : insights.length === 0 ? (
            <div className="py-10 text-center">
              <CheckCircle2 size={30} className="mx-auto text-emerald-400/80 mb-3" />
              <p className="text-gray-400 text-sm">{t('insights.allClear')}</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {insights.map((ins, idx) => {
                const Icon = INSIGHT_ICONS[ins.kind] ?? Activity;
                const sev = INSIGHT_SEV[ins.severity] ?? INSIGHT_SEV.info;
                const params: Record<string, string | number> = { ...ins.params };
                if (typeof params.minutes === 'number') {
                  params.duration = fmtDuration(params.minutes);
                }
                const text = t(`insights.${ins.kind}`, { ...params, defaultValue: ins.kind });
                const inner = (
                  <>
                    <span className={`w-8 h-8 rounded-lg border flex items-center justify-center flex-shrink-0 ${sev.chip}`}>
                      <Icon size={16} />
                    </span>
                    <span className={`flex-1 text-[13px] leading-snug ${sev.text}`}>{text}</span>
                  </>
                );
                const rowClass = 'flex items-start gap-3 px-3 py-2.5 rounded-lg transition-colors';
                return ins.link ? (
                  <Link
                    key={`${ins.kind}-${ins.machine_id ?? idx}`}
                    to={ins.link}
                    className={`${rowClass} hover:bg-white/[0.05]`}
                  >
                    {inner}
                  </Link>
                ) : (
                  <div key={`${ins.kind}-${ins.machine_id ?? idx}`} className={rowClass}>
                    {inner}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default HomePage;
