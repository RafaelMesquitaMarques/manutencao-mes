import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LayoutDashboard, Plus, Trash2, Tv } from 'lucide-react';
import { fetchDashboards, createDashboard, deleteDashboard, type Dashboard } from '../../api/dashboards';
import { useRole } from '../../hooks/usePermission';

export default function DashboardList() {
  const { t } = useTranslation();
  const [list, setList] = useState<Dashboard[]>([]);
  const [loading, setLoading] = useState(true);
  const canEdit = useRole('supervisor', 'plant_manager', 'director', 'admin');
  const nav = useNavigate();

  const load = () => fetchDashboards().then(setList).catch(() => setList([])).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const create = async () => {
    const name = window.prompt(t('dashboards.namePrompt', 'Dashboard name?'));
    if (!name) return;
    const d = await createDashboard({ name });
    nav(`/dashboards/${d.slug}?edit=1`);
  };
  const remove = async (d: Dashboard) => {
    if (!window.confirm(t('dashboards.confirmDelete', 'Delete "{{name}}"?', { name: d.name }))) return;
    await deleteDashboard(d.slug);
    load();
  };

  return (
    <div className="h-full bg-gray-950 text-gray-100 p-6 overflow-auto">
      <div className="flex items-center gap-3 mb-6">
        <LayoutDashboard className="text-indigo-400" />
        <h1 className="text-xl font-semibold text-white">{t('dashboards.title', 'Dashboards')}</h1>
        {canEdit && (
          <button onClick={create} className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 rounded-lg">
            <Plus size={15} /> {t('dashboards.new', 'New')}
          </button>
        )}
      </div>
      {loading ? (
        <p className="text-gray-500">…</p>
      ) : list.length === 0 ? (
        <p className="text-gray-500">{t('dashboards.empty', 'No dashboard yet.')}</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {list.map((d) => (
            <div key={d.id} className="border border-gray-800 rounded-xl p-4 bg-gray-900 hover:border-indigo-500/50 transition-colors">
              <div className="flex items-start justify-between gap-2">
                <Link to={`/dashboards/${d.slug}`} className="font-semibold text-white hover:text-indigo-300 truncate">{d.name}</Link>
                {canEdit && <button onClick={() => remove(d)} className="text-gray-600 hover:text-red-400 shrink-0"><Trash2 size={15} /></button>}
              </div>
              <p className="text-xs text-gray-500 mt-1">{d.tiles?.length ?? 0} {t('dashboards.cards', 'cards')}</p>
              <div className="flex gap-3 mt-3">
                <Link to={`/dashboards/${d.slug}`} className="flex items-center gap-1 text-xs text-gray-300 hover:text-white"><Tv size={13} /> {t('dashboards.open', 'Open')}</Link>
                {canEdit && <Link to={`/dashboards/${d.slug}?edit=1`} className="text-xs text-gray-400 hover:text-white">{t('dashboards.edit', 'Edit')}</Link>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
