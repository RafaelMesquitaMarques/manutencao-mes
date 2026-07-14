import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ClipboardList, Play, AlertTriangle, CheckCircle2, Gauge, Activity,
  Factory, Ticket, Bell, Briefcase, ArrowRight, ArrowUpRight, Plus,
  Map as MapIcon, BarChart3, Wrench, ListChecks, RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { usePlantStore } from '../../store/plantStore';
import { useLiveBadges } from '../../hooks/useLiveBadges';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';
import {
  fetchDashboardStats, fetchWorkOrders, fetchKPISummary, fetchEquipment,
} from '../../api/workOrders';
import type { DashboardStats, WorkOrder, KPISummary, Equipment, UserRole } from '../../types';
import Badge from '../../components/ui/Badge';
import FactoryPreview from './FactoryPreview';
import NeuralHud, { type HudNode } from './NeuralHud';

// ─── Metric accents (kept on StatDef so the HUD node source stays typed) ────────
type Accent = 'blue' | 'amber' | 'red' | 'green' | 'indigo' | 'cyan' | 'emerald' | 'purple' | 'orange';

interface StatDef {
  key: string;
  label: string;
  value: number | string;
  sub?: string;
  icon: LucideIcon;
  accent: Accent;
  to?: string;
}

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

  // Only hit endpoints the user is allowed to read — keeps the page 403-free and
  // tailors the cards to each role (an operator sees far less than a manager).
  const showWO = can('work_orders');
  const showKpi = can('kpis');
  const showEquip = can('equipment');
  const mapPlantId = activePlant?.plant_id ?? activePlantId;
  const showMap = can('factory_map') && !!mapPlantId;

  const load = useCallback(async () => {
    const [s, w, k, e] = await Promise.allSettled([
      showWO ? fetchDashboardStats() : Promise.reject(),
      showWO ? fetchWorkOrders({ limit: '6' }) : Promise.reject(),
      showKpi ? fetchKPISummary(30) : Promise.reject(),
      // Whole production catalog, not the first page — the default limit (50)
      // returns mostly auxiliary assets alphabetically, skewing the roll-up.
      showEquip ? fetchEquipment({ asset_type: 'production', limit: '2000' }) : Promise.reject(),
    ]);
    if (s.status === 'fulfilled') setStats(s.value as DashboardStats);
    if (w.status === 'fulfilled') setRecentWOs(w.value as WorkOrder[]);
    if (k.status === 'fulfilled') setKpi(k.value as KPISummary);
    if (e.status === 'fulfilled') setEquip(e.value as Equipment[]);
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
      { key: 'open',      label: t('dashboard.openWOs'),        value: stats.total_open,     icon: ClipboardList, accent: 'blue',  to: linkIf('work_orders', '/work-orders') },
      { key: 'progress',  label: t('dashboard.inProgress'),     value: stats.in_progress,    icon: Play,          accent: 'amber', to: linkIf('work_orders', '/work-orders') },
      { key: 'critical',  label: t('dashboard.critical'),       value: stats.critical,       icon: AlertTriangle, accent: 'red',   to: linkIf('work_orders', '/work-orders') },
      { key: 'done',      label: t('dashboard.completedToday'), value: stats.completed_today, icon: CheckCircle2,  accent: 'green', to: linkIf('work_orders', '/work-orders') },
    );
  }
  if (kpi) {
    cards.push(
      { key: 'oee',   label: t('kpis.oee'),          value: pct(kpi.oee_pct),          sub: t('kpis.oeeSub'),          icon: Gauge,    accent: 'indigo', to: linkIf('kpis', '/kpis') },
      { key: 'avail', label: t('kpis.availability'), value: pct(kpi.availability_pct), sub: t('kpis.availabilitySub'), icon: Activity, accent: 'cyan',   to: linkIf('kpis', '/kpis') },
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
      to: linkIf('equipment', '/equipment'),
    });
  }
  cards.push({ key: 'mywork', label: t('home.myWork'), value: badges.myWorkCount, icon: Briefcase, accent: 'blue', to: '/my-work' });
  if (can('alerts')) cards.push({ key: 'alerts',  label: t('home.openAlerts'),  value: badges.alertCount,  icon: Bell,   accent: 'orange', to: '/gestion-bt' });
  if (can('tickets')) cards.push({ key: 'tickets', label: t('home.openTickets'), value: badges.ticketCount, icon: Ticket, accent: 'purple', to: '/tickets' });

  // ── Neural HUD beside the greeting — the key metrics orbit the cognitive core.
  // Index 0 sits at 12 o'clock, the rest are laid out clockwise.
  const hudNodes: HudNode[] = cards.map((c) => ({
    to: c.to,
    label: c.label,
    value: String(c.value),
    icon: c.icon,
  }));

  // ── Quick access (module shortcuts filtered by permission) ───────────────────
  const shortcuts: { to: string; icon: LucideIcon; img?: string; label: string; show: boolean }[] = [
    { to: '/work-orders/new', icon: Plus,      label: t('workOrders.newWO'),    show: can('work_orders', 'create') },
    { to: '/my-work',         icon: Briefcase, label: t('nav.myWork'),          show: true },
    { to: '/gestion-bt',      icon: ListChecks, label: t('nav.gestionBT'),      show: can('alerts') },
    { to: '/factory-map',     icon: MapIcon,   label: t('nav.factoryMap'),      show: can('factory_map') },
    { to: '/kpis',            icon: BarChart3, label: t('nav.kpis'),            show: can('kpis') },
    { to: '/equipment',       icon: Wrench,    label: t('nav.equipment'),       show: can('equipment') },
    { to: '/intelligence',    icon: BarChart3, img: '/mirai-icon.png', label: t('nav.intelligence'), show: can('intelligence') },
  ];
  const visibleShortcuts = shortcuts.filter((sc) => sc.show);

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
        <div className="hidden xl:flex absolute inset-y-0 left-[24%] right-0 z-10 items-center justify-center pointer-events-none">
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

        {/* Quick access — right rail beside the 3D view + recent WOs stack */}
        <div className={`glass-card p-5 ${
          showMap && showWO ? 'lg:col-start-3 lg:row-start-1 lg:row-span-2'
          : !showMap && !showWO ? 'lg:col-span-3' : ''
        }`}>
          <h2 className="text-white font-semibold text-sm mb-4">{t('home.quickAccess')}</h2>
          <div className={showWO ? 'space-y-1.5' : 'grid sm:grid-cols-2 gap-1.5'}>
            {visibleShortcuts.map((sc) => (
              <Link
                key={sc.to}
                to={sc.to}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-white/[0.05] transition-colors group"
              >
                <span className="w-8 h-8 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center flex-shrink-0 group-hover:bg-blue-500/10 group-hover:border-blue-500/20 transition-colors">
                  {sc.img
                    ? <img src={sc.img} alt="" className="w-[18px] h-[18px] object-contain" />
                    : <sc.icon size={16} className="text-blue-400" />}
                </span>
                <span className="flex-1 truncate">{sc.label}</span>
                <ArrowUpRight size={14} className="text-gray-600 group-hover:text-blue-400 transition-colors" />
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default HomePage;
