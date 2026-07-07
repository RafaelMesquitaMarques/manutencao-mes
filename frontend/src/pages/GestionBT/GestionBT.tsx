import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bell, ClipboardList } from 'lucide-react';
import AlertList from '../Alerts/AlertList';
import SupervisorDashboard from '../MaintenanceDashboard/SupervisorDashboard';
import { useAuthStore } from '../../store/authStore';
import { useLiveBadges } from '../../hooks/useLiveBadges';

type Tab = 'alerts' | 'bt';

/** Gestion BT — the merged maintenance control center: the old Alerts page and
 *  the old Supervisor View (open tickets + open work orders) live here as tabs. */
export default function GestionBT() {
  const { t } = useTranslation();
  const { can } = useAuthStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const badges = useLiveBadges();

  // The tickets & WOs tab keeps the old supervisor_view permission semantics.
  const canBT = can('supervisor_view', 'view');
  const [tab, setTab] = useState<Tab>(
    searchParams.get('tab') === 'bt' && canBT ? 'bt' : 'alerts',
  );

  const switchTab = (next: Tab) => {
    setTab(next);
    setSearchParams(next === 'bt' ? { tab: 'bt' } : {}, { replace: true });
  };

  const TABS: { id: Tab; label: string; Icon: typeof Bell; badge?: number; show: boolean }[] = [
    { id: 'alerts', label: t('gestionBT.tabAlerts'), Icon: Bell, badge: badges.alertCount, show: true },
    { id: 'bt', label: t('gestionBT.tabBT'), Icon: ClipboardList, show: canBT },
  ];

  return (
    <div className="p-6 space-y-4 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-white">{t('gestionBT.title')}</h1>
        <p className="text-gray-500 text-sm mt-0.5">{t('gestionBT.subtitle')}</p>
      </div>

      <div className="flex gap-1 bg-[#0d1421] border border-white/[0.06] rounded-lg p-1 w-fit">
        {TABS.filter((tb) => tb.show).map(({ id, label, Icon, badge }) => (
          <button
            key={id}
            onClick={() => switchTab(id)}
            className={`flex items-center gap-2 px-4 py-2 rounded text-sm font-medium transition-colors ${
              tab === id ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <Icon size={15} />
            {label}
            {badge != null && badge > 0 && (
              <span className={`text-[10px] font-mono min-w-[18px] text-center px-1.5 py-0.5 rounded-full ${
                tab === id ? 'bg-white/20 text-white' : 'bg-red-500/20 text-red-400'
              }`}>
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === 'alerts' ? <AlertList embedded /> : <SupervisorDashboard embedded />}
    </div>
  );
}
