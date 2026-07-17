import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, Plus, Cpu, MapPin, Activity, Monitor, Pencil, Power, ArrowUp, ArrowDown, ChevronsUpDown, ChevronDown, Check, X, Image as ImageIcon } from 'lucide-react';
import { fetchEquipment } from '../../api/workOrders';
import api from '../../api/axios';
import { usePermission } from '../../hooks/usePermission';
import type { Equipment } from '../../types';
import { STATUS_LABEL } from '../../utils/statusColors';

// Live status palette — mirrors utils/statusColors.ts STATUS_HEX (kiosk / map)
const STATUS_COLORS: Record<string, string> = {
  running: 'bg-green-500/15 text-green-400 border-green-500/20',
  planned_stop: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  stopped: 'bg-red-500/15 text-red-400 border-red-500/20',
  maintenance: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
  intervention: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
  unjustified: 'bg-pink-500/15 text-pink-400 border-pink-500/20',
  idle: 'bg-gray-500/15 text-gray-400 border-gray-500/20',
  // static catalog statuses (fallback when live_status is absent)
  in_maintenance: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
  scrapped: 'bg-gray-500/15 text-gray-400 border-gray-500/20',
};

// Effective operational status: live (kiosk/tickets/parent) over the static column
const effStatus = (e: Equipment): string => e.live_status ?? e.status;

const CRIT_COLORS: Record<string, string> = {
  critical: 'text-red-400',
  high: 'text-orange-400',
  medium: 'text-amber-400',
  low: 'text-green-400',
};

const CRIT_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

interface Plant { id: string; code: string; name: string; }

type SortKey = 'name' | 'plant' | 'department' | 'family' | 'subtype' | 'location' | 'criticality' | 'status';

// Real columns first (Option B), fall back to the imported specifications JSON for legacy rows.
const getDept = (e: Equipment) => e.department || ((e.specifications?.division as string) ?? '') || '';
const getFamily = (e: Equipment) => e.family || ((e.specifications?.famille as string) ?? '') || '';
const getSubtype = (e: Equipment) => e.subtype || '';

/** Excel-style column filter: pick multiple values via checkboxes. */
function MultiSelect({ label, options, selected, onChange }: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (vals: string[]) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  const shown = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;
  const active = selected.length > 0;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs border transition-colors ${
          active ? 'border-blue-500/40 text-gray-200 bg-blue-500/5' : 'border-white/[0.06] text-gray-400 hover:text-gray-200'
        }`}
      >
        <span>{label}</span>
        {active && <span className="text-[10px] font-bold px-1.5 rounded-full bg-blue-600 text-white">{selected.length}</span>}
        <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-56 bg-[#0d1421] border border-white/10 rounded-lg shadow-xl p-2">
          <div className="flex items-center justify-between mb-1.5 px-1">
            <button onClick={() => onChange(options.map((o) => o.value))} className="text-[11px] text-blue-400 hover:text-blue-300">
              {t('common.selectAll', 'Select all')}
            </button>
            <button onClick={() => onChange([])} className="text-[11px] text-gray-500 hover:text-gray-300">
              {t('common.clear', 'Clear')}
            </button>
          </div>
          {options.length > 8 && (
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('common.search', 'Search')}
              className="w-full mb-1.5 px-2 py-1 bg-[#0b1120] border border-white/10 rounded text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500/50"
            />
          )}
          <div className="max-h-56 overflow-y-auto space-y-0.5">
            {shown.length === 0 && <p className="text-xs text-gray-600 px-2 py-3 text-center">—</p>}
            {shown.map((o) => {
              const on = selected.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggle(o.value)}
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-left text-xs hover:bg-white/[0.05] transition-colors"
                >
                  <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${on ? 'bg-blue-600 border-blue-600' : 'border-white/20'}`}>
                    {on && <Check size={11} className="text-white" />}
                  </span>
                  <span className={`truncate ${on ? 'text-gray-100' : 'text-gray-400'}`}>{o.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function EquipmentList() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const lang = (i18n.language || 'en').slice(0, 2) as 'en' | 'fr' | 'es';
  const statusLabel = useCallback(
    (s: string) => STATUS_LABEL[s]?.[lang] ?? s.replace('_', ' '),
    [lang],
  );
  const canCreate = usePermission('equipment', 'create');
  const canUpdate = usePermission('equipment', 'update');
  const [items, setItems] = useState<Equipment[]>([]);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // Type tab lives in the URL so the detail page's back button can restore it.
  const [searchParams, setSearchParams] = useSearchParams();
  const typeParam = searchParams.get('type');
  const assetFilter: 'all' | 'production' | 'auxiliary' =
    typeParam === 'production' || typeParam === 'auxiliary' ? typeParam : 'all';
  const setAssetFilter = useCallback(
    (v: 'all' | 'production' | 'auxiliary') =>
      setSearchParams(v === 'all' ? {} : { type: v }, { replace: true }),
    [setSearchParams],
  );
  const openDetail = (id: string) =>
    navigate(`/equipment/${id}`, { state: { backTo: `/equipment${assetFilter === 'all' ? '' : `?type=${assetFilter}`}` } });

  // per-column filters (multi-select arrays; Location is free text)
  const [fPlant, setFPlant] = useState<string[]>([]);
  const [fDept, setFDept] = useState<string[]>([]);
  const [fFamily, setFFamily] = useState<string[]>([]);
  const [fSubtype, setFSubtype] = useState<string[]>([]);
  const [fCrit, setFCrit] = useState<string[]>([]);
  const [fStatus, setFStatus] = useState<string[]>([]);
  const [fLocation, setFLocation] = useState('');

  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // bulk selection / reclassification
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const PAGE = 200;
      const all: Equipment[] = [];
      for (let skip = 0; ; skip += PAGE) {
        const batch = await fetchEquipment({ limit: String(PAGE), skip: String(skip) });
        all.push(...batch);
        if (batch.length < PAGE) break;
      }
      setItems(all);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    api.get<Plant[] | { items: Plant[] }>('/api/plants/')
      .then(({ data }) => setPlants(Array.isArray(data) ? data : (data.items ?? [])))
      .catch(() => {});
  }, [load]);

  // clear selection when switching tabs (avoid acting on hidden rows)
  useEffect(() => { setSelected(new Set()); }, [assetFilter]);

  const plantName = (e: Equipment) => plants.find((p) => p.id === e.plant_id)?.name ?? '';

  const counts = {
    all: items.length,
    production: items.filter((e) => (e.asset_type ?? 'production') === 'production').length,
    auxiliary: items.filter((e) => e.asset_type === 'auxiliary').length,
  };

  const scoped = useMemo(
    () => items.filter((e) => assetFilter === 'all' || (e.asset_type ?? 'production') === assetFilter),
    [items, assetFilter],
  );

  const uniq = (vals: string[]) => Array.from(new Set(vals.filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const plantOpts = useMemo(() => uniq(scoped.map(plantName)).map((v) => ({ value: v, label: v })), [scoped, plants]);
  const deptOpts = useMemo(() => uniq(scoped.map(getDept)).map((v) => ({ value: v, label: v })), [scoped]);
  const familyOpts = useMemo(() => uniq(scoped.map(getFamily)).map((v) => ({ value: v, label: v })), [scoped]);
  const subtypeOpts = useMemo(() => uniq(scoped.map(getSubtype)).map((v) => ({ value: v, label: v })), [scoped]);
  const statusOpts = useMemo(() => uniq(scoped.map(effStatus)).map((v) => ({ value: v, label: statusLabel(v) })), [scoped, statusLabel]);
  const critOpts = ['critical', 'high', 'medium', 'low'].map((c) => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) }));

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const lq = fLocation.toLowerCase();
    return scoped.filter((e) => {
      if (fPlant.length && !fPlant.includes(plantName(e))) return false;
      if (fDept.length && !fDept.includes(getDept(e))) return false;
      if (fFamily.length && !fFamily.includes(getFamily(e))) return false;
      if (fSubtype.length && !fSubtype.includes(getSubtype(e))) return false;
      if (fCrit.length && !fCrit.includes(e.criticality)) return false;
      if (fStatus.length && !fStatus.includes(effStatus(e))) return false;
      if (lq && !(e.location ?? '').toLowerCase().includes(lq)) return false;
      if (q && !(
        e.name.toLowerCase().includes(q) ||
        e.code.toLowerCase().includes(q) ||
        (e.location ?? '').toLowerCase().includes(q) ||
        getSubtype(e).toLowerCase().includes(q) ||
        getDept(e).toLowerCase().includes(q) ||
        getFamily(e).toLowerCase().includes(q)
      )) return false;
      return true;
    });
  }, [scoped, search, fPlant, fDept, fFamily, fSubtype, fCrit, fStatus, fLocation, plants]);

  const sorted = useMemo(() => {
    const val = (e: Equipment): string | number => {
      switch (sortKey) {
        case 'plant': return plantName(e);
        case 'department': return getDept(e);
        case 'family': return getFamily(e);
        case 'subtype': return getSubtype(e);
        case 'location': return e.location ?? '';
        case 'criticality': return CRIT_ORDER[e.criticality] ?? 0;
        case 'status': return effStatus(e);
        default: return e.name;
      }
    };
    return [...filtered].sort((a, b) => {
      const va = val(a), vb = val(b);
      const c = typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb));
      return sortDir === 'asc' ? c : -c;
    });
  }, [filtered, sortKey, sortDir, plants]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir('asc'); }
  };

  const anyFilter = !!(fPlant.length || fDept.length || fFamily.length || fSubtype.length || fCrit.length || fStatus.length || fLocation || search);
  const clearAll = () => {
    setFPlant([]); setFDept([]); setFFamily([]); setFSubtype([]); setFCrit([]); setFStatus([]); setFLocation(''); setSearch('');
  };

  // selection helpers
  const toggleOne = (id: string) => setSelected((prev) => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const visibleIds = sorted.map((e) => e.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const toggleAll = () => setSelected((prev) => {
    const n = new Set(prev);
    if (allSelected) visibleIds.forEach((id) => n.delete(id));
    else visibleIds.forEach((id) => n.add(id));
    return n;
  });

  const moveSelected = async (target: 'production' | 'auxiliary') => {
    if (!selected.size || busy) return;
    setBusy(true);
    try {
      await Promise.all([...selected].map((id) => api.patch(`/api/equipment/${id}`, { asset_type: target })));
      setSelected(new Set());
      await load();
    } finally {
      setBusy(false);
    }
  };

  const isList = assetFilter !== 'production';

  const FILTER_TABS: { id: 'all' | 'production' | 'auxiliary'; label: string }[] = [
    { id: 'all', label: t('equipment.filterAll', 'All') },
    { id: 'production', label: t('equipment.filterProduction', 'Production') },
    { id: 'auxiliary', label: t('equipment.filterAuxiliary', 'Auxiliary') },
  ];

  const SortHead = ({ k, label, className = '' }: { k: SortKey; label: string; className?: string }) => (
    <th className={`sticky top-0 z-10 bg-[#0d1421] border-b border-white/[0.06] text-left text-[11px] uppercase tracking-wide text-gray-500 font-medium px-3 py-2 ${className}`}>
      <button onClick={() => toggleSort(k)} className="inline-flex items-center gap-1 hover:text-gray-200 transition-colors">
        {label}
        {sortKey === k
          ? (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)
          : <ChevronsUpDown size={11} className="opacity-40" />}
      </button>
    </th>
  );

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('equipment.title')}</h1>
          <p className="text-gray-500 text-sm mt-0.5">{t('equipment.subtitle')}</p>
        </div>
        {canCreate && (
          <Link
            to="/equipment/new"
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Plus size={16} />
            {t('equipment.newEquipment')}
          </Link>
        )}
      </div>

      {/* Search + type tabs */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1 min-w-[220px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('common.search')}
            className="w-full pl-9 pr-4 py-2 bg-[#0d1421] border border-white/[0.06] rounded-lg text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500/50"
          />
        </div>
        <div className="flex gap-1 bg-[#0d1421] border border-white/[0.06] rounded-lg p-1">
          {FILTER_TABS.map((tb) => (
            <button
              key={tb.id}
              onClick={() => setAssetFilter(tb.id)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                assetFilter === tb.id ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {tb.label}
              <span className="ml-1.5 text-[10px] opacity-60">{counts[tb.id]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Column filter bar (list views only) — multi-select like Excel */}
      {isList && (
        <div className="flex flex-wrap items-center gap-2">
          <MultiSelect label={t('equipment.colPlant', 'Plant')} options={plantOpts} selected={fPlant} onChange={setFPlant} />
          <MultiSelect label={t('equipment.department', 'Department')} options={deptOpts} selected={fDept} onChange={setFDept} />
          <MultiSelect label={t('equipment.family', 'Family')} options={familyOpts} selected={fFamily} onChange={setFFamily} />
          <MultiSelect label={t('equipment.colSubtype', 'Subtype')} options={subtypeOpts} selected={fSubtype} onChange={setFSubtype} />
          <MultiSelect label={t('equipment.criticality', 'Criticality')} options={critOpts} selected={fCrit} onChange={setFCrit} />
          <MultiSelect label={t('common.status', 'Status')} options={statusOpts} selected={fStatus} onChange={setFStatus} />
          <div className="relative">
            <MapPin size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-600" />
            <input
              value={fLocation}
              onChange={(e) => setFLocation(e.target.value)}
              placeholder={t('equipment.colLocation', 'Location')}
              className={`w-36 pl-7 pr-2 py-1.5 bg-[#0d1421] border rounded-lg text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500/50 ${
                fLocation ? 'border-blue-500/40' : 'border-white/[0.06]'
              }`}
            />
          </div>
          {anyFilter && (
            <button onClick={clearAll} className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-gray-400 hover:text-gray-200 border border-white/[0.06] rounded-lg transition-colors">
              <X size={12} /> {t('common.clear', 'Clear')}
            </button>
          )}
          <span className="text-xs text-gray-600 ml-auto">{sorted.length} / {scoped.length}</span>
        </div>
      )}

      {/* Bulk reclassification bar */}
      {selected.size > 0 && canUpdate && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-blue-600/10 border border-blue-500/30 rounded-lg">
          <span className="text-sm text-blue-200 font-medium">
            {selected.size} {t('equipment.selected', 'selected')}
          </span>
          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={() => moveSelected('auxiliary')}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-teal-600/50 text-teal-300 bg-teal-500/10 hover:bg-teal-500/20 transition-colors disabled:opacity-50"
            >
              <Power size={13} /> {t('equipment.moveToAuxiliary', 'Move to Auxiliary')}
            </button>
            <button
              onClick={() => moveSelected('production')}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-blue-600/50 text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 transition-colors disabled:opacity-50"
            >
              <Cpu size={13} /> {t('equipment.moveToProduction', 'Move to Production')}
            </button>
            <button onClick={() => setSelected(new Set())} className="px-2.5 py-1.5 text-xs text-gray-400 hover:text-gray-200 border border-white/[0.06] rounded-md">
              {t('common.clear', 'Clear')}
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center h-48 text-gray-500 text-sm">{t('common.loading')}</div>
      ) : sorted.length === 0 ? (
        <div className="flex items-center justify-center h-48 text-gray-500 text-sm">{t('equipment.noEquipment')}</div>
      ) : assetFilter === 'production' ? (
        /* ── Production: rich cards — scroll inside so header/tabs/bulk bar stay fixed ── */
        <div className="overflow-auto max-h-[calc(100vh-220px)] pr-1">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
          {sorted.map((eq) => {
            const isAux = eq.asset_type === 'auxiliary';
            const sel = selected.has(eq.id);
            return (
              <div
                key={eq.id}
                onClick={() => openDetail(eq.id)}
                className={`bg-[#0d1421] border rounded-xl p-3 hover:bg-[#0f1929] transition-all group cursor-pointer ${sel ? 'border-blue-500/60' : 'border-white/[0.06] hover:border-blue-500/30'}`}
              >
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={sel}
                    onChange={() => toggleOne(eq.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="w-4 h-4 accent-blue-500 cursor-pointer mt-1.5 flex-shrink-0"
                  />
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${isAux ? 'bg-teal-500/10' : 'bg-blue-500/10'}`}>
                    {isAux ? <Power size={16} className="text-teal-400" /> : <Cpu size={16} className="text-blue-400" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-semibold text-sm leading-snug break-words group-hover:text-blue-300 transition-colors">{eq.name}</p>
                    <p className="text-gray-600 text-xs font-mono truncate">
                      {eq.code}
                      {eq.location && <span className="font-sans text-gray-500"> · {eq.location}</span>}
                    </p>
                  </div>
                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border flex-shrink-0 ${STATUS_COLORS[effStatus(eq)] ?? STATUS_COLORS.stopped}`}>
                    {statusLabel(effStatus(eq))}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-2.5 pt-2.5 border-t border-white/[0.04]">
                  <Activity size={12} className={CRIT_COLORS[eq.criticality] ?? 'text-gray-500'} />
                  <span className={`text-xs ${CRIT_COLORS[eq.criticality] ?? 'text-gray-500'}`}>{eq.criticality}</span>
                  <span className="text-xs text-gray-600">{eq.hour_meter.toLocaleString()} {t('equipment.hours')}</span>
                  <div className="flex items-center gap-1.5 ml-auto">
                    <button
                      onClick={(e) => { e.stopPropagation(); navigate(`/machine/${eq.id}`); }}
                      title={t('equipment.machinePage')}
                      className="p-1.5 rounded-md border border-blue-700 text-blue-400 hover:bg-blue-900/20 transition-colors"
                    >
                      <Monitor size={13} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); openDetail(eq.id); }}
                      title={t('common.edit')}
                      className="p-1.5 rounded-md border border-gray-700 text-gray-400 hover:bg-gray-800 transition-colors"
                    >
                      <Pencil size={13} />
                    </button>
                  </div>
                </div>
                {/* Machine photo thumbnail (same image the factory-map block uses) */}
                {eq.icon_url ? (
                  <img
                    src={eq.icon_url}
                    alt={eq.name}
                    loading="lazy"
                    className="w-20 h-20 mt-2.5 rounded-lg object-cover border border-white/[0.06]"
                  />
                ) : (
                  <div
                    title={t('equipment.noPhoto')}
                    className="w-20 h-20 mt-2.5 rounded-lg border border-dashed border-white/[0.08] bg-white/[0.015] flex items-center justify-center"
                  >
                    <ImageIcon size={16} className="text-gray-700" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </div>
      ) : (
        /* ── All / Auxiliary: sortable, multi-filterable table ── */
        <div className="overflow-auto border border-white/[0.06] rounded-xl max-h-[calc(100vh-260px)]">
          <table className="w-full min-w-[960px] text-sm">
            <thead>
              <tr>
                <th className="sticky top-0 z-10 bg-[#0d1421] border-b border-white/[0.06] px-3 py-2 w-10">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="w-4 h-4 accent-blue-500 cursor-pointer align-middle"
                  />
                </th>
                <SortHead k="name" label={t('equipment.colName', 'Name')} />
                <SortHead k="plant" label={t('equipment.colPlant', 'Plant')} />
                <SortHead k="department" label={t('equipment.department', 'Department')} />
                <SortHead k="family" label={t('equipment.family', 'Family')} />
                <SortHead k="subtype" label={t('equipment.colSubtype', 'Subtype')} />
                <SortHead k="location" label={t('equipment.colLocation', 'Location')} />
                <SortHead k="criticality" label={t('equipment.criticality', 'Criticality')} />
                <SortHead k="status" label={t('common.status', 'Status')} />
                <th className="sticky top-0 z-10 bg-[#0d1421] border-b border-white/[0.06] px-3 py-2 w-24" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((eq) => {
                const isAux = eq.asset_type === 'auxiliary';
                const sel = selected.has(eq.id);
                return (
                  <tr
                    key={eq.id}
                    onClick={() => openDetail(eq.id)}
                    className={`border-b border-white/[0.04] hover:bg-white/[0.02] cursor-pointer transition-colors ${sel ? 'bg-blue-500/5' : ''}`}
                  >
                    <td className="px-3 py-2.5 w-10" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={sel}
                        onChange={() => toggleOne(eq.id)}
                        className="w-4 h-4 accent-blue-500 cursor-pointer align-middle"
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${isAux ? 'bg-teal-500/10' : 'bg-blue-500/10'}`}>
                          {isAux ? <Power size={14} className="text-teal-400" /> : <Cpu size={14} className="text-blue-400" />}
                        </div>
                        <div className="min-w-0">
                          <p className="text-white text-sm font-medium truncate max-w-[240px]">{eq.name}</p>
                          <p className="text-gray-600 text-xs font-mono">{eq.code}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-gray-400 whitespace-nowrap">{plantName(eq) || '—'}</td>
                    <td className="px-3 py-2.5 text-xs text-gray-400">{getDept(eq) || '—'}</td>
                    <td className="px-3 py-2.5 text-xs text-gray-400">{getFamily(eq) || '—'}</td>
                    <td className="px-3 py-2.5 text-xs text-gray-400">{getSubtype(eq) || '—'}</td>
                    <td className="px-3 py-2.5 text-xs text-gray-500">{eq.location || '—'}</td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex items-center gap-1 text-xs ${CRIT_COLORS[eq.criticality] ?? 'text-gray-500'}`}>
                        <Activity size={12} /> {eq.criticality}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${STATUS_COLORS[effStatus(eq)] ?? STATUS_COLORS.stopped}`}>
                        {statusLabel(effStatus(eq))}
                      </span>
                    </td>
                    <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-2">
                        {!isAux && (
                          <button
                            onClick={() => navigate(`/machine/${eq.id}`)}
                            className="p-1.5 rounded-md border border-blue-700 text-blue-400 hover:bg-blue-900/20 transition-colors"
                            title="Machine page"
                          >
                            <Monitor size={13} />
                          </button>
                        )}
                        <button
                          onClick={() => openDetail(eq.id)}
                          className="p-1.5 rounded-md border border-gray-700 text-gray-400 hover:bg-gray-800 transition-colors"
                          title="Edit"
                        >
                          <Pencil size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
