import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard,
  ClipboardList,
  Wrench,
  Users,
  BarChart3,
  Settings,
  Factory,
  CalendarDays,
  CalendarCheck,
  Bell,
  Ticket,
  Activity,
  X,
} from 'lucide-react';

const navGroups = [
  {
    label: 'Core',
    items: [
      { to: '/dashboard',   icon: LayoutDashboard, key: 'dashboard' },
      { to: '/work-orders', icon: ClipboardList,   key: 'workOrders' },
      { to: '/technicians', icon: Users,            key: 'technicians' },
      { to: '/equipment',   icon: Wrench,           key: 'equipment' },
    ],
  },
  {
    label: 'Maintenance',
    items: [
      { to: '/alerts',                icon: Bell,     key: 'alerts' },
      { to: '/tickets',               icon: Ticket,   key: 'tickets' },
      { to: '/maintenance/dashboard', icon: Activity, key: 'maintenanceDashboard' },
    ],
  },
  {
    label: 'Planning',
    items: [
      { to: '/schedule',    icon: CalendarDays,  key: 'schedule' },
      { to: '/pm-calendar', icon: CalendarCheck, key: 'pmCalendar' },
    ],
  },
  {
    label: 'Analytics',
    items: [
      { to: '/kpis',     icon: BarChart3, key: 'kpis' },
      { to: '/settings', icon: Settings,  key: 'settings', disabled: true },
    ],
  },
];

interface SidebarProps {
  onClose?: () => void;
}

const Sidebar = ({ onClose }: SidebarProps) => {
  const { t } = useTranslation();

  return (
    <aside className="flex flex-col h-full w-64 bg-[#0d1421] border-r border-white/[0.06]">
      {/* Logo */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-white/[0.06]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center flex-shrink-0 shadow-lg shadow-blue-600/20">
            <Factory className="w-4.5 h-4.5 text-white" size={18} />
          </div>
          <div>
            <p className="text-white font-semibold text-sm leading-none">Foliot MES</p>
            <p className="text-gray-600 text-[10px] mt-0.5 leading-none">Furniture Manufacturing</p>
          </div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="lg:hidden text-gray-500 hover:text-gray-300 transition-colors p-1 rounded"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 p-3 space-y-4 overflow-y-auto">
        {navGroups.map((group) => (
          <div key={group.label}>
            <p className="text-[10px] text-gray-700 font-semibold uppercase tracking-widest px-3 mb-1">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.items.map(({ to, icon: Icon, key, disabled }) =>
                disabled ? (
                  <div
                    key={to}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-600 cursor-not-allowed select-none"
                  >
                    <Icon size={18} className="flex-shrink-0" />
                    <span>{t(`nav.${key}`)}</span>
                    <span className="ml-auto text-[10px] text-gray-700 font-mono border border-gray-800 px-1.5 py-0.5 rounded">
                      soon
                    </span>
                  </div>
                ) : (
                  <NavLink
                    key={to}
                    to={to}
                    className={({ isActive }) =>
                      isActive ? 'nav-link-active' : 'nav-link'
                    }
                  >
                    <Icon size={18} className="flex-shrink-0" />
                    <span>{t(`nav.${key}`)}</span>
                  </NavLink>
                )
              )}
            </div>
          </div>
        ))}
      </nav>

      {/* Bottom version */}
      <div className="px-4 py-3 border-t border-white/[0.06]">
        <p className="text-gray-700 text-[10px] font-mono">v0.3.0 · 2026</p>
      </div>
    </aside>
  );
};

export default Sidebar;
