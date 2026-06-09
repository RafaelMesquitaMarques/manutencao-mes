import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, Plus, Cpu, MapPin, Activity, Monitor, Pencil } from 'lucide-react';
import { fetchEquipment } from '../../api/workOrders';
import type { Equipment } from '../../types';

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-green-500/15 text-green-400 border-green-500/20',
  in_maintenance: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
  stopped: 'bg-red-500/15 text-red-400 border-red-500/20',
  scrapped: 'bg-gray-500/15 text-gray-400 border-gray-500/20',
};

const CRIT_COLORS: Record<string, string> = {
  critical: 'text-red-400',
  high: 'text-orange-400',
  medium: 'text-amber-400',
  low: 'text-green-400',
};

export default function EquipmentList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [items, setItems] = useState<Equipment[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchEquipment()
      .then(setItems)
      .finally(() => setLoading(false));
  }, []);

  const filtered = items.filter(
    (e) =>
      e.name.toLowerCase().includes(search.toLowerCase()) ||
      e.code.toLowerCase().includes(search.toLowerCase()) ||
      (e.location ?? '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('equipment.title')}</h1>
          <p className="text-gray-500 text-sm mt-0.5">{t('equipment.subtitle')}</p>
        </div>
        <Link
          to="/equipment/new"
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <Plus size={16} />
          {t('equipment.newEquipment')}
        </Link>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('common.search')}
          className="w-full pl-9 pr-4 py-2 bg-[#0d1421] border border-white/[0.06] rounded-lg text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500/50"
        />
      </div>

      {/* Grid */}
      {loading ? (
        <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
          {t('common.loading')}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
          {t('equipment.noEquipment')}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((eq) => (
            <Link
              key={eq.id}
              to={`/equipment/${eq.id}`}
              className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4 hover:border-blue-500/30 hover:bg-[#0f1929] transition-all group"
            >
              {/* Top row */}
              <div className="flex items-start justify-between mb-3">
                <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center flex-shrink-0">
                  <Cpu size={20} className="text-blue-400" />
                </div>
                <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${STATUS_COLORS[eq.status] ?? STATUS_COLORS.stopped}`}>
                  {eq.status.replace('_', ' ')}
                </span>
              </div>

              {/* Name + code */}
              <p className="text-white font-semibold text-sm leading-snug group-hover:text-blue-300 transition-colors">
                {eq.name}
              </p>
              <p className="text-gray-600 text-xs font-mono mt-0.5">{eq.code}</p>

              {/* Location */}
              {eq.location && (
                <div className="flex items-center gap-1.5 mt-2">
                  <MapPin size={12} className="text-gray-600" />
                  <span className="text-gray-500 text-xs">{eq.location}</span>
                </div>
              )}

              {/* Bottom row */}
              <div className="flex items-center justify-between mt-3 pt-3 border-t border-white/[0.04]">
                <div className="flex items-center gap-1.5">
                  <Activity size={12} className={CRIT_COLORS[eq.criticality] ?? 'text-gray-500'} />
                  <span className={`text-xs ${CRIT_COLORS[eq.criticality] ?? 'text-gray-500'}`}>
                    {eq.criticality}
                  </span>
                </div>
                <span className="text-xs text-gray-600">
                  {eq.hour_meter.toLocaleString()} {t('equipment.hours')}
                </span>
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-white/[0.04]">
                <button
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); navigate(`/machine/${eq.id}`); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-blue-700 text-blue-400 hover:bg-blue-900/20 transition-colors"
                >
                  <Monitor size={12} /> Machine page
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); navigate(`/equipment/${eq.id}`); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-gray-700 text-gray-400 hover:bg-gray-800 transition-colors ml-auto"
                >
                  <Pencil size={12} /> Edit
                </button>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
