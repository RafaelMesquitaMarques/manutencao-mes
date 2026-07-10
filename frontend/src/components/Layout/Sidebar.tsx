import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard, LayoutGrid, ClipboardList, Wrench, Users, BarChart3,
  Settings, Factory, CalendarDays, CalendarCheck, CalendarClock, Bell, Ticket,
  Activity, Briefcase, X, UserCog, Package, Building2, ShoppingCart,
  ChevronsLeft, ChevronsRight, Brain, Map as MapIcon, ClipboardCheck, ListChecks,
  DollarSign, Cpu, Clock, type LucideIcon,
} from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import type { UserRole } from '../../types';
import { useLiveBadges } from '../../hooks/useLiveBadges';

type NavRole = UserRole | 'all';

interface NavItem {
  to: string;
  icon: LucideIcon;
  /** Optional image used instead of the lucide icon (e.g. the Ask Ninja logomark). */
  img?: string;
  key: string;
  disabled?: boolean;
  roles?: NavRole[];
}

interface NavGroup {
  label: string;
  items: NavItem[];
  roles?: NavRole[];
}

const SUPERVISOR_UP: NavRole[] = ['supervisor', 'maintenance_director', 'plant_manager', 'director', 'admin'];
const TECH_UP: NavRole[] = ['technician', 'supervisor', 'maintenance_director', 'plant_manager', 'director', 'admin'];

const CORE_GROUPS: NavGroup[] = [
  {
    label: 'WorkOrders',
    items: [
      { to: '/dashboard',               icon: LayoutDashboard, key: 'woReports' },
      { to: '/maintenance/wo-approval', icon: ClipboardCheck,  key: 'woApproval',  roles: SUPERVISOR_UP },
      { to: '/work-orders',             icon: ClipboardList,   key: 'workOrders' },
      { to: '/gestion-bt',              icon: ListChecks,      key: 'gestionBT' },
    ],
  },
  {
    label: 'Core',
    items: [
      { to: '/equipment',   icon: Wrench,           key: 'equipment',   roles: TECH_UP },
      { to: '/factory-map', icon: MapIcon,          key: 'factoryMap',  roles: SUPERVISOR_UP },
      { to: '/my-work',     icon: Briefcase,        key: 'myWork' },
    ],
  },
  {
    label: 'Maintenance',
    items: [
      { to: '/tickets',                 icon: Ticket,       key: 'tickets',              roles: TECH_UP },
      { to: '/maintenance/dashboard',      icon: Activity,     key: 'maintenanceDashboard', roles: TECH_UP },
      { to: '/dashboards',                 icon: LayoutGrid,   key: 'dashboards',           roles: SUPERVISOR_UP },
      { to: '/schedule',                icon: CalendarDays, key: 'schedule',             roles: TECH_UP },
      { to: '/pm-calendar',             icon: CalendarCheck, key: 'pmCalendar',          roles: TECH_UP },
      { to: '/maintenance/plans',       icon: CalendarClock, key: 'maintenancePlans',    roles: TECH_UP },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { to: '/inventory',        icon: Package,       key: 'inventory',       roles: TECH_UP },
      { to: '/suppliers',        icon: Building2,     key: 'suppliers',       roles: SUPERVISOR_UP },
      { to: '/supplier-orders',  icon: ShoppingCart,  key: 'purchaseOrders',  roles: SUPERVISOR_UP },
    ],
  },
  {
    label: 'Analytics',
    items: [
      { to: '/kpis', icon: BarChart3, key: 'kpis', roles: SUPERVISOR_UP },
      { to: '/costs', icon: DollarSign, key: 'costs', roles: SUPERVISOR_UP },
      { to: '/kpis/machines', icon: Factory, key: 'machineReports', roles: SUPERVISOR_UP },
      { to: '/intelligence', icon: Brain, img: '/mirai-icon.png', key: 'intelligence', roles: TECH_UP },
    ],
  },
];

interface SidebarProps {
  onClose?: () => void;
}

const BADGE_NAV_KEYS: Record<string, 'alertCount' | 'ticketCount' | 'myWorkCount'> = {
  gestionBT: 'alertCount',
  tickets:   'ticketCount',
  myWork:    'myWorkCount',
};

// Maps a nav item key → the permission resource that gates its visibility (view).
// Items not listed here are gated by role only (their `roles` array).
const NAV_PERM: Record<string, string> = {
  woReports: 'dashboard', workOrders: 'work_orders', technicians: 'technicians',
  equipment: 'equipment', myWork: 'my_work', tickets: 'tickets',
  maintenanceDashboard: 'maintenance',
  schedule: 'schedule', pmCalendar: 'pm_calendar', maintenancePlans: 'maintenance_plans',
  kpis: 'kpis', costs: 'costs', machineReports: 'machine_reports', factoryMap: 'factory_map', dashboards: 'dashboards',
  woApproval: 'wo_approval', inventory: 'inventory', suppliers: 'suppliers',
  purchaseOrders: 'purchase_orders', intelligence: 'intelligence',
  escalationSettings: 'settings_escalation', gestionBT: 'alerts',
  factoryCalendar: 'calendar', deviceSettings: 'settings_devices',
  shiftSettings: 'technicians',
};

const Sidebar = ({ onClose }: SidebarProps) => {
  const { t } = useTranslation();
  const { user, isAdmin, can } = useAuthStore();
  const role = (user?.role ?? 'operator') as UserRole;
  const badges = useLiveBadges();

  // Collapsible only on the persistent (desktop) sidebar; the mobile drawer is always full
  const isDrawer = Boolean(onClose);
  const [collapsed, setCollapsed] = useState(
    () => !isDrawer && localStorage.getItem('sidebar_collapsed') === '1',
  );
  const toggleCollapsed = () =>
    setCollapsed(c => {
      localStorage.setItem('sidebar_collapsed', c ? '0' : '1');
      return !c;
    });

  const canView = (roles?: NavRole[]): boolean => {
    if (!roles || roles.length === 0) return true;
    return roles.includes(role as NavRole);
  };

  const settingsItems: NavItem[] = [
    { to: '/technicians', icon: Users, key: 'technicians', roles: SUPERVISOR_UP },
    { to: '/settings/escalation', icon: Bell, key: 'escalationSettings', roles: SUPERVISOR_UP },
    { to: '/settings/calendar', icon: CalendarDays, key: 'factoryCalendar', roles: SUPERVISOR_UP },
    { to: '/settings/shifts', icon: Clock, key: 'shiftSettings', roles: SUPERVISOR_UP },
    { to: '/settings/devices', icon: Cpu, key: 'deviceSettings', roles: SUPERVISOR_UP },
    ...(isAdmin() ? [{ to: '/settings/users', icon: UserCog, key: 'userManagement' }] : []),
  ];

  const navGroups: NavGroup[] = [
    ...CORE_GROUPS,
    { label: 'Settings', items: settingsItems },
  ];

  return (
    <aside
      className={`flex flex-col h-full ${collapsed ? 'w-[72px]' : 'w-64'} bg-[#0d1421] border-r border-white/[0.06] transition-[width] duration-200`}
    >
      {/* Logo + collapse toggle */}
      <div
        className={`flex items-center border-b border-white/[0.06] py-4 ${
          collapsed ? 'flex-col gap-2 px-2' : 'justify-between px-4'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <img
            src="/mirai-icon.png"
            alt=""
            className={`object-contain ${collapsed ? 'h-9 w-auto' : 'h-11 w-auto'}`}
          />
        </div>
        {isDrawer ? (
          <button
            onClick={onClose}
            className="lg:hidden text-gray-500 hover:text-gray-300 transition-colors p-1 rounded"
          >
            <X size={16} />
          </button>
        ) : (
          <button
            onClick={toggleCollapsed}
            title={collapsed ? t('nav.expandMenu', 'Expand menu') : t('nav.collapseMenu', 'Collapse menu')}
            className="text-gray-500 hover:text-gray-300 hover:bg-white/[0.05] transition-colors p-1.5 rounded-lg"
          >
            {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className={`flex-1 py-3 space-y-4 overflow-y-auto overflow-x-hidden ${collapsed ? 'px-2' : 'px-3'}`}>
        {navGroups.map((group, gi) => (
          <div key={group.label}>
            {collapsed ? (
              gi > 0 && <div className="border-t border-white/[0.06] mx-2 mb-2" />
            ) : (
              <p className="text-[10px] text-gray-700 font-semibold uppercase tracking-widest px-3 mb-1">
                {t(`navGroups.${group.label.toLowerCase()}`, group.label)}
              </p>
            )}
            <div className="space-y-0.5">
              {group.items.filter((item) => canView(item.roles) && (!NAV_PERM[item.key] || can(NAV_PERM[item.key], 'view'))).map(({ to, icon: Icon, img, key, disabled }) => {
                const badgeKey = BADGE_NAV_KEYS[key];
                const count = badgeKey ? badges[badgeKey] : 0;
                const red = badges.hasCritical;
                if (disabled) {
                  return (
                    <div
                      key={to}
                      title={collapsed ? t(`nav.${key}`) : undefined}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-600 cursor-not-allowed select-none ${collapsed ? 'justify-center !px-0' : ''}`}
                    >
                      {img
                        ? <img src={img} alt="" className="w-[18px] h-[18px] object-contain flex-shrink-0" />
                        : <Icon size={18} className="flex-shrink-0" />}
                      {!collapsed && (
                        <>
                          <span>{t(`nav.${key}`)}</span>
                          <span className="ml-auto text-[10px] text-gray-700 font-mono border border-gray-800 px-1.5 py-0.5 rounded">
                            soon
                          </span>
                        </>
                      )}
                    </div>
                  );
                }
                return (
                  <NavLink
                    key={to}
                    to={to}
                    title={collapsed ? t(`nav.${key}`) : undefined}
                    className={({ isActive }) =>
                      `${isActive ? 'nav-link-active' : 'nav-link'}${collapsed ? ' justify-center !px-0' : ''}`
                    }
                  >
                    <span className="relative flex-shrink-0">
                      {img
                        ? <img src={img} alt="" className="w-[18px] h-[18px] object-contain" />
                        : <Icon size={18} />}
                      {collapsed && count > 0 && (
                        <span
                          className={`absolute -top-1 -right-1 w-2 h-2 rounded-full ${red ? 'bg-red-400' : 'bg-blue-400'}`}
                        />
                      )}
                    </span>
                    {!collapsed && (
                      <>
                        <span>{t(`nav.${key}`)}</span>
                        {count > 0 && (
                          <span className={`ml-auto text-[10px] font-mono min-w-[18px] text-center px-1.5 py-0.5 rounded-full ${red ? 'bg-red-500/20 text-red-400' : 'bg-blue-500/20 text-blue-400'}`}>
                            {count > 99 ? '99+' : count}
                          </span>
                        )}
                      </>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Bottom version */}
      <div className={`py-3 border-t border-white/[0.06] ${collapsed ? 'px-0 text-center' : 'px-4'}`}>
        <p className="text-gray-700 text-[10px] font-mono">{collapsed ? 'v0.5' : 'v0.5.0 · 2026'}</p>
      </div>
    </aside>
  );
};

export default Sidebar;
