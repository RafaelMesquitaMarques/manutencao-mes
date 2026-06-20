import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, Users, RefreshCw, CheckCircle2 } from 'lucide-react';
import { fetchTechniciansFull } from '../../api/workOrders';
import type { TechnicianFull } from '../../types';
import Spinner from '../../components/ui/Spinner';
import { usePermission } from '../../hooks/usePermission';

const TechnicianList = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canCreate = usePermission('technicians', 'create');

  const [technicians, setTechnicians] = useState<TechnicianFull[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchTechniciansFull();
      setTechnicians(data);
    } catch {
      setError(t('common.error'));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('technicians.title')}</h1>
          <p className="text-gray-500 text-sm mt-1">{t('technicians.subtitle')}</p>
        </div>
        {canCreate && (
          <button onClick={() => navigate('/technicians/new')} className="btn-primary flex-shrink-0">
            <Plus size={16} />
            {t('technicians.newTech')}
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Spinner size="lg" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center h-48 gap-4">
          <p className="text-red-400 text-sm">{error}</p>
          <button onClick={load} className="btn-secondary flex items-center gap-2">
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      ) : technicians.length === 0 ? (
        <div className="glass-card p-12 flex flex-col items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-white/[0.04] flex items-center justify-center">
            <Users size={28} className="text-gray-600" />
          </div>
          <div className="text-center">
            <p className="text-gray-400 font-medium">{t('technicians.noTechs')}</p>
          </div>
          <button onClick={() => navigate('/technicians/new')} className="btn-primary">
            <Plus size={16} />
            {t('technicians.createFirst')}
          </button>
        </div>
      ) : (
        <div className="glass-card overflow-hidden">
          <div className="overflow-auto max-h-[calc(100vh-210px)]">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="table-header-cell sticky top-0 z-10 bg-gray-900 border-b border-white/[0.06]">{t('common.actions')}</th>
                  <th className="table-header-cell sticky top-0 z-10 bg-gray-900 border-b border-white/[0.06]">{t('technicians.employeeNumber')}</th>
                  <th className="table-header-cell sticky top-0 z-10 bg-gray-900 border-b border-white/[0.06]">{t('technicians.specialty')}</th>
                  <th className="table-header-cell sticky top-0 z-10 bg-gray-900 border-b border-white/[0.06]">{t('technicians.shift')}</th>
                  <th className="table-header-cell sticky top-0 z-10 bg-gray-900 border-b border-white/[0.06] text-right">{t('technicians.hourlyRate')}</th>
                  <th className="table-header-cell sticky top-0 z-10 bg-gray-900 border-b border-white/[0.06]">{t('technicians.active')}</th>
                </tr>
              </thead>
              <tbody>
                {technicians.map((tech) => (
                  <tr key={tech.id} className="table-row">
                    <td className="table-cell">
                      <Link to={`/technicians/${tech.id}`} className="group">
                        <p className="text-gray-200 font-medium group-hover:text-blue-400 transition-colors">{tech.full_name ?? '—'}</p>
                        <p className="text-gray-500 text-xs">{tech.email ?? ''}</p>
                      </Link>
                    </td>
                    <td className="table-cell font-mono text-gray-400 text-xs">
                      {tech.employee_number ?? '—'}
                    </td>
                    <td className="table-cell">
                      {tech.specialty ? (
                        <span className="text-xs bg-blue-500/15 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded-full">
                          {t(`specialty.${tech.specialty}`)}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="table-cell text-gray-400 text-sm">
                      {tech.shift ? t(`shift.${tech.shift}`) : '—'}
                    </td>
                    <td className="table-cell text-right font-mono text-gray-300">
                      {tech.hourly_rate != null ? `$${tech.hourly_rate.toFixed(2)}/h` : '—'}
                    </td>
                    <td className="table-cell">
                      {tech.active ? (
                        <CheckCircle2 size={16} className="text-green-400" />
                      ) : (
                        <span className="text-gray-600 text-xs">Inactive</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default TechnicianList;
