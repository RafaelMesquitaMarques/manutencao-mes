import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  BookOpen, Plus, Search, RefreshCw, X, Loader2, ListChecks, Wrench, Clock,
} from 'lucide-react';
import { fetchSops, createSop, type Sop, type SopCategory, type SopStatus } from '../../api/sops';
import { fetchEquipment } from '../../api/workOrders';
import type { Equipment } from '../../types';
import { usePermission } from '../../hooks/usePermission';

const CATEGORIES: SopCategory[] = ['operation', 'maintenance', 'safety', 'quality', 'setup'];
const STATUSES: SopStatus[] = ['draft', 'published', 'archived'];

export const CATEGORY_CHIP: Record<string, string> = {
  operation:   'text-sky-300 border-sky-500/40 bg-sky-500/10',
  maintenance: 'text-amber-300 border-amber-500/40 bg-amber-500/10',
  safety:      'text-red-300 border-red-500/40 bg-red-500/10',
  quality:     'text-violet-300 border-violet-500/40 bg-violet-500/10',
  setup:       'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
};

export const STATUS_CHIP: Record<string, string> = {
  draft:     'text-gray-300 border-white/20 bg-white/5',
  published: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  archived:  'text-gray-500 border-white/10 bg-white/[0.03]',
};

export default function SopList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canCreate = usePermission('sops', 'create');

  const [items, setItems] = useState<Sop[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<SopCategory | ''>('');
  const [status, setStatus] = useState<SopStatus | ''>('');
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetchSops({
      category: category || undefined,
      status: status || undefined,
      search: search.trim() || undefined,
    })
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [category, status, search]);

  useEffect(() => {
    const handle = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(handle);
  }, [load, search]);

  const counts = useMemo(() => {
    const by: Record<string, number> = {};
    for (const s of items) by[s.category] = (by[s.category] ?? 0) + 1;
    return by;
  }, [items]);

  return (
    <div className="flex flex-col bg-gray-950 text-gray-100 min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5 border-b border-gray-800 gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-white flex items-center gap-2">
            <BookOpen size={20} className="text-indigo-400" />
            {t('sops.title')}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">{t('sops.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            title={t('common.refresh', 'Refresh')}
            className="p-2 text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded-lg"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
          {canCreate && (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg"
            >
              <Plus size={15} /> {t('sops.newSop')}
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="px-6 py-4 flex items-center gap-3 flex-wrap border-b border-gray-800/60">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('sops.searchPlaceholder')}
            className="bg-gray-900 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500 w-64"
          />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setCategory('')}
            className={`text-xs px-3 py-1.5 rounded-full border font-bold transition-colors ${
              category === '' ? 'text-white border-indigo-400 bg-indigo-500/20' : 'text-gray-500 border-white/10 hover:border-white/25'
            }`}
          >
            {t('sops.allCategories')}
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(category === c ? '' : c)}
              className={`text-xs px-3 py-1.5 rounded-full border font-bold transition-colors ${
                category === c ? CATEGORY_CHIP[c] : 'text-gray-500 border-white/10 hover:border-white/25'
              }`}
            >
              {t(`sops.categories.${c}`)}{counts[c] ? ` · ${counts[c]}` : ''}
            </button>
          ))}
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as SopStatus | '')}
          className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 focus:outline-none focus:border-indigo-500"
        >
          <option value="">{t('sops.allStatuses')}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{t(`sops.statuses.${s}`)}</option>
          ))}
        </select>
      </div>

      {/* Grid */}
      <div className="flex-1 px-6 py-5">
        {loading && items.length === 0 ? (
          <p className="text-sm text-gray-600 py-10 text-center">{t('common.loading', 'Loading…')}</p>
        ) : items.length === 0 ? (
          <div className="text-center py-16 space-y-3">
            <BookOpen size={40} className="text-gray-700 mx-auto" />
            <p className="text-gray-500">{t('sops.empty')}</p>
            {canCreate && (
              <button
                onClick={() => setShowCreate(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg"
              >
                <Plus size={15} /> {t('sops.createFirst')}
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {items.map((sop) => (
              <button
                key={sop.id}
                onClick={() => navigate(`/sops/${sop.id}`)}
                className="text-left bg-[#0d1421] border border-white/[0.06] hover:border-indigo-500/40 rounded-2xl p-4 transition-colors group"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-[11px] text-gray-500">{sop.sop_number}</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border font-bold uppercase tracking-wide ${CATEGORY_CHIP[sop.category]}`}>
                    {t(`sops.categories.${sop.category}`)}
                  </span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border font-bold uppercase tracking-wide ${STATUS_CHIP[sop.status]}`}>
                    {t(`sops.statuses.${sop.status}`)}
                  </span>
                  <span className="ml-auto text-[10px] text-gray-600 font-mono">v{sop.version}</span>
                </div>
                <p className="text-white font-bold text-base mt-2 leading-snug group-hover:text-indigo-300 transition-colors">
                  {sop.title}
                </p>
                {sop.description && (
                  <p className="text-gray-500 text-sm mt-1 line-clamp-2">{sop.description}</p>
                )}
                <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
                  <span className="flex items-center gap-1"><ListChecks size={13} /> {t('sops.stepCount', { count: sop.step_count })}</span>
                  {sop.estimated_minutes != null && (
                    <span className="flex items-center gap-1"><Clock size={13} /> {Math.round(sop.estimated_minutes)} min</span>
                  )}
                  {sop.equipment.length > 0 && (
                    <span className="flex items-center gap-1 truncate">
                      <Wrench size={13} />
                      <span className="truncate">
                        {sop.equipment.slice(0, 2).map((e) => e.equipment_name).join(', ')}
                        {sop.equipment.length > 2 ? ` +${sop.equipment.length - 2}` : ''}
                      </span>
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {showCreate && <CreateSopModal onClose={() => setShowCreate(false)} />}
    </div>
  );
}

// ─── Create modal ───────────────────────────────────────────────────────────────

function CreateSopModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<SopCategory>('operation');
  const [description, setDescription] = useState('');
  const [minutes, setMinutes] = useState('');
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [equipmentIds, setEquipmentIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // Whole catalog for the link picker (the endpoint defaults to 50 rows).
    fetchEquipment({ limit: '2000' }).then(setEquipment).catch(() => {});
  }, []);

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true); setError('');
    try {
      const sop = await createSop({
        title: title.trim(),
        category,
        description: description.trim() || undefined,
        estimated_minutes: minutes ? Number(minutes) : undefined,
        equipment_ids: equipmentIds,
      });
      navigate(`/sops/${sop.id}`);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? t('common.saveError', 'Error'));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-[#0d1421] border border-white/[0.08] rounded-2xl p-5 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-white font-bold text-lg flex items-center gap-2">
            <BookOpen size={18} className="text-indigo-400" /> {t('sops.newSop')}
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 p-1"><X size={18} /></button>
        </div>

        <div>
          <label className="text-xs text-gray-500 font-semibold uppercase tracking-wide">{t('sops.fields.title')}</label>
          <input
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('sops.fields.titlePlaceholder')}
            className="mt-1 w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
          />
        </div>

        <div>
          <label className="text-xs text-gray-500 font-semibold uppercase tracking-wide">{t('sops.fields.category')}</label>
          <div className="flex items-center gap-1.5 flex-wrap mt-1">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`text-xs px-3 py-1.5 rounded-full border font-bold transition-colors ${
                  category === c ? CATEGORY_CHIP[c] : 'text-gray-500 border-white/10 hover:border-white/25'
                }`}
              >
                {t(`sops.categories.${c}`)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs text-gray-500 font-semibold uppercase tracking-wide">{t('sops.fields.description')}</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="mt-1 w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500 resize-y"
          />
        </div>

        <div>
          <label className="text-xs text-gray-500 font-semibold uppercase tracking-wide">{t('sops.fields.estimatedMinutes')}</label>
          <input
            value={minutes}
            onChange={(e) => setMinutes(e.target.value.replace(/[^0-9.]/g, ''))}
            inputMode="numeric"
            className="mt-1 w-28 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
          />
        </div>

        <div>
          <label className="text-xs text-gray-500 font-semibold uppercase tracking-wide">{t('sops.fields.equipment')}</label>
          <EquipmentPicker equipment={equipment} selected={equipmentIds} onChange={setEquipmentIds} />
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 rounded-lg border border-white/10">
            {t('common.cancel')}
          </button>
          <button
            onClick={submit}
            disabled={busy || !title.trim()}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg disabled:opacity-40"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            {t('common.create', 'Create')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Equipment multi-select (shared with SopDetail) ────────────────────────────

export function EquipmentPicker({ equipment, selected, onChange }: {
  equipment: Equipment[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const chosen = equipment.filter((e) => selected.includes(e.id));
  const options = equipment.filter(
    (e) => !selected.includes(e.id) &&
      (!query.trim() || `${e.name} ${e.code ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())),
  ).slice(0, 8);

  return (
    <div className="mt-1 space-y-2">
      {chosen.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chosen.map((e) => (
            <span key={e.id} className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border border-indigo-500/40 bg-indigo-500/10 text-indigo-200">
              {e.name}
              <button onClick={() => onChange(selected.filter((id) => id !== e.id))} aria-label={t('common.delete')}>
                <X size={12} className="hover:text-white" />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('sops.fields.equipmentSearch')}
        className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
      />
      {query.trim() && (
        <div className="border border-gray-800 rounded-lg divide-y divide-gray-800/70 overflow-hidden">
          {options.length === 0 ? (
            <p className="text-xs text-gray-600 px-3 py-2">{t('common.noData')}</p>
          ) : options.map((e) => (
            <button
              key={e.id}
              onClick={() => { onChange([...selected, e.id]); setQuery(''); }}
              className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-white/[0.04] flex items-center justify-between"
            >
              <span>{e.name}</span>
              <span className="text-xs text-gray-600 font-mono">{e.code}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
