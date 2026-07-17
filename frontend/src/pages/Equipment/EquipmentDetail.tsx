import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, Cpu, MapPin, Clock, Gauge, AlertCircle, Calendar,
  Save, Plus, Trash2, Check, X, Copy, ChevronRight, ChevronDown, ExternalLink,
  Settings, StopCircle, AlertTriangle, Users, BarChart2, Activity,
  Zap, Pencil, Shield, Loader2, Power, CalendarClock, ListChecks, Search,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { fetchEquipmentById, fetchWorkOrders, fetchEquipment } from '../../api/workOrders';
import { fetchMaintenancePlans } from '../../api/maintenancePlans';
import {
  fetchPmTemplates, createPmTemplate, updatePmTemplate, deletePmTemplate, clonePmTemplate,
  addPmTemplateTask, updatePmTemplateTask, deletePmTemplateTask,
} from '../../api/pmTemplates';
import {
  fetchMachinesAll, updateMachineConfig,
  addMachineOperator, updateMachineOperatorRecord, deleteOperator,
  fetchMachineStopCategories, createMachineStopCategory, deleteMachineStopCategory,
  addStopSubcategory, updateStopSubcategory, deleteStopSubcategory,
  fetchMachineRejectCategories, createMachineRejectCategory, deleteMachineRejectCategory,
  addRejectSubcategory, updateRejectSubcategory, deleteRejectSubcategory,
  cloneCategories,
} from '../../api/machines';
import api from '../../api/axios';
import { fetchDepartments } from '../../api/departments';
import { fetchEquipmentCondition, type SushiCondition, type SushiSeries } from '../../api/sushi';
import SushiIcon from '../../components/ui/SushiIcon';
import ReactECharts from 'echarts-for-react';
import { uploadFile } from '../../api/uploads';
import { saveMachineLayout } from '../../api/factoryMap';
import type {
  Equipment, WorkOrder, MaintenancePlan, PmTemplate, PmTemplateTask, PmFrequency,
  Machine, MachineConfigUpdate, MachineOperatorOut, MachineOperatorCreate,
  OperatorShift, StopCategoryOut, StopSubcategoryOut, StopCategoryType,
  RejectCategoryOut, RejectSubcategoryOut, HourlyRateCurrency,
  InterventionType,
} from '../../types';
import { format } from 'date-fns';
import { IconRenderer, IconPicker, INTERVENTION_ICON_MAP, INTERVENTION_ICONS } from '../../components/ui/IconLibrary';
import PmStepsEditor from '../../components/pm/PmStepsEditor';
import { humanHours } from '../../utils/duration';

// ─── Status palettes ────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  running:        'bg-green-500/15 text-green-400 border-green-500/20',
  in_maintenance: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
  stopped:        'bg-red-500/15 text-red-400 border-red-500/20',
  scrapped:       'bg-gray-500/15 text-gray-400 border-gray-500/20',
};

const WO_STATUS_COLORS: Record<string, string> = {
  open:        'bg-blue-500/15 text-blue-400',
  in_progress: 'bg-amber-500/15 text-amber-400',
  completed:   'bg-green-500/15 text-green-400',
  on_hold:     'bg-gray-500/15 text-gray-400',
  cancelled:   'bg-red-500/15 text-red-400',
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'text-red-400',
  high:     'text-orange-400',
  medium:   'text-amber-400',
  low:      'text-green-400',
};

// ─── Main tab types ──────────────────────────────────────────────────────────────

type TabId = 'overview' | 'workorders' | 'plans' | 'configuration' | 'history' | 'condition';

// ─── Config sub-tab types ────────────────────────────────────────────────────────

type ConfigTab = 'general' | 'stop' | 'reject' | 'operators' | 'shifts' | 'parameters' | 'indicators' | 'intervention_types' | 'safety_checklist' | 'cleaning_checklist' | 'pm_templates';

// labelKey (i18n) wins over label when present.
const CONFIG_TABS: { id: ConfigTab; label: string; labelKey?: string; Icon: LucideIcon }[] = [
  { id: 'general',    label: 'General',          Icon: Settings     },
  { id: 'stop',       label: 'Stop Categories',  Icon: StopCircle   },
  { id: 'reject',     label: 'Reject Categories',Icon: AlertTriangle },
  { id: 'operators',  label: 'Operators',        Icon: Users        },
  { id: 'shifts',     label: 'Work Shifts',      Icon: Clock        },
  { id: 'parameters', label: 'Parameters',       Icon: BarChart2    },
  { id: 'indicators',          label: 'Indicators',          Icon: Activity },
  { id: 'intervention_types', label: 'Intervention Types',  Icon: Zap      },
  { id: 'safety_checklist',   label: 'Safety Checklist',    Icon: Shield   },
  { id: 'cleaning_checklist', label: 'Cleaning Checklist',  labelKey: 'equipment.cleaningChecklist', Icon: Sparkles },
];

const LANG_OPTIONS = [
  { value: 'fr', label: 'Français' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
];

const COLOR_PRESETS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];
const SHIFTS: OperatorShift[] = ['morning', 'afternoon', 'night', 'all'];
const STOP_TYPES: StopCategoryType[] = ['planned', 'unplanned', 'maintenance'];
const CURRENCIES: HourlyRateCurrency[] = ['CAD', 'USD', 'EUR'];

// ─── Shared config helpers ────────────────────────────────────────────────────────

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center justify-between cursor-pointer">
      <span className="text-sm text-gray-300">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative w-11 h-6 rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-gray-700'}`}
      >
        <span className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${checked ? 'left-6' : 'left-1'}`} />
      </button>
    </label>
  );
}

type AnyCategory = { id: string; name: string; icon?: string; color?: string; sort_order: number; subcategories?: unknown[] };

function errDetail(e: unknown): string {
  const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  return e instanceof Error ? e.message : String(e);
}

function CategoryCard({ cat, selected, onSelect, onDelete }: {
  cat: AnyCategory; selected: boolean; onSelect: () => void; onDelete: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={`relative p-4 rounded-2xl border cursor-pointer transition-all ${
        selected ? 'bg-blue-600/20 border-blue-500/50' : 'bg-[#0d1421] border-white/[0.06] hover:border-white/20'
      }`}
    >
      <div className="flex items-center gap-3">
        <IconRenderer icon={cat.icon || 'wrench'} color={cat.color || '#6b7280'} size={22} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-white truncate">{cat.name}</p>
          <p className="text-xs text-gray-600">{(cat.subcategories as unknown[])?.length ?? 0} subcategories</p>
        </div>
        <ChevronRight size={14} className="text-gray-600" />
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute top-2 right-2 p-1.5 rounded-lg text-gray-700 hover:text-red-400 hover:bg-red-400/10 transition-colors"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

// ─── Clone modal ──────────────────────────────────────────────────────────────────

type CloneAssetFilter = 'all' | 'production' | 'auxiliary';

function CloneModal({ machines, sourceMachineId, categoryType, onClose }: {
  machines: Machine[]; sourceMachineId: string; categoryType: 'stop' | 'reject'; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [query, setQuery] = useState('');
  const [assetFilter, setAssetFilter] = useState<CloneAssetFilter>('all');
  const [assetTypes, setAssetTypes] = useState<Record<string, 'production' | 'auxiliary'>>({});

  // asset_type lives on Equipment; machines link back via equipment_id.
  useEffect(() => {
    fetchEquipment({ limit: '1000' }).then((eqs) => {
      const map: Record<string, 'production' | 'auxiliary'> = {};
      eqs.forEach((eq) => { map[eq.id] = eq.asset_type ?? 'production'; });
      setAssetTypes(map);
    }).catch(() => {});
  }, []);

  const q = query.trim().toLowerCase();
  const targets = machines.filter((m) => {
    if (m.id === sourceMachineId) return false;
    if (q && !(m.display_name || m.name).toLowerCase().includes(q) && !m.name.toLowerCase().includes(q)) return false;
    if (assetFilter !== 'all') {
      const type = (m.equipment_id && assetTypes[m.equipment_id]) || 'production';
      if (type !== assetFilter) return false;
    }
    return true;
  });
  const toggle = (id: string) =>
    setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);

  const run = async () => {
    if (!selected.length) return;
    setBusy(true);
    await cloneCategories({ source_machine_id: sourceMachineId, target_machine_ids: selected, category_type: categoryType });
    setDone(true);
    setBusy(false);
    setTimeout(onClose, 1200);
  };

  const FILTERS: CloneAssetFilter[] = ['all', 'production', 'auxiliary'];
  const filterLabel: Record<CloneAssetFilter, string> = {
    all: t('common.all'),
    production: t('equipment.assetProduction'),
    auxiliary: t('equipment.assetAuxiliary'),
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-[#0d1421] border border-white/10 rounded-2xl p-6 w-full max-w-md space-y-4">
        <h2 className="text-base font-black text-white">
          {categoryType === 'stop' ? t('equipment.cloneCatsStopTitle') : t('equipment.cloneCatsRejectTitle')}
        </h2>
        <p className="text-xs text-gray-500">{t('equipment.cloneCatsHint')}</p>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('equipment.cloneSearchMachines')}
            className="w-full bg-[#0b1120] border border-white/10 rounded-xl pl-9 pr-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500" />
        </div>
        <div className="flex gap-2">
          {FILTERS.map((f) => (
            <button key={f} type="button" onClick={() => setAssetFilter(f)}
              className={`px-3 py-1 rounded-xl text-xs font-bold border transition-all ${assetFilter === f ? 'bg-blue-600 text-white border-blue-500' : 'bg-white/[0.04] text-gray-400 border-white/10'}`}>
              {filterLabel[f]}
            </button>
          ))}
        </div>
        <div className="space-y-2 max-h-60 overflow-y-auto">
          {targets.map((m) => (
            <label key={m.id} className="flex items-center gap-3 cursor-pointer p-3 rounded-xl hover:bg-white/[0.04]">
              <input type="checkbox" checked={selected.includes(m.id)} onChange={() => toggle(m.id)} className="accent-blue-500 w-4 h-4" />
              <span className="text-sm text-white">{m.display_name || m.name}</span>
            </label>
          ))}
          {targets.length === 0 && (
            <p className="text-center py-4 text-gray-600 text-sm">{t('equipment.cloneNoMachines')}</p>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={run} disabled={busy || !selected.length}
            className={`flex-1 py-2.5 rounded-xl text-sm font-black transition-all ${done ? 'bg-green-600' : 'bg-blue-600 hover:bg-blue-500'} text-white disabled:opacity-50`}>
            {done ? t('equipment.cloned') : busy ? t('equipment.cloning') : t('equipment.cloneCount', { count: selected.length })}
          </button>
          <button onClick={onClose} className="px-4 py-2.5 rounded-xl text-sm text-gray-400 border border-white/10 hover:border-white/20">{t('common.cancel')}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Stop Categories tab ──────────────────────────────────────────────────────────

function StopCategoriesTab({ slug, allMachines, machineId }: { slug: string; allMachines: Machine[]; machineId: string }) {
  const [cats, setCats] = useState<StopCategoryOut[]>([]);
  const [selected, setSelected] = useState<StopCategoryOut | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showClone, setShowClone] = useState(false);
  const [addForm, setAddForm] = useState<{ name: string; type: StopCategoryType; icon: string; color: string; comment_required: boolean; triggers_maintenance: boolean }>(
    { name: '', type: 'unplanned', icon: 'wrench', color: '#ef4444', comment_required: false, triggers_maintenance: false },
  );
  const [addSubForm, setAddSubForm] = useState({ name: '', icon: 'wrench', color: '#6b7280', comment_required: false, triggers_maintenance: false });
  const [showAddSub, setShowAddSub] = useState(false);
  const [editSubId, setEditSubId] = useState<string | null>(null);
  const [editSubForm, setEditSubForm] = useState({ name: '', icon: 'wrench', color: '#6b7280', triggers_maintenance: false });
  const [busy, setBusy] = useState(false);
  const { t } = useTranslation();

  const load = useCallback(async () => { setCats(await fetchMachineStopCategories(slug)); }, [slug]);
  useEffect(() => { load(); }, [load]);

  const refreshKeepingSelection = async (selectedId: string) => {
    const refreshed = await fetchMachineStopCategories(slug);
    setCats(refreshed);
    setSelected(refreshed.find((c) => c.id === selectedId) ?? null);
  };

  const addCat = async () => {
    if (!addForm.name.trim()) return;
    setBusy(true);
    await createMachineStopCategory(slug, addForm);
    setAddForm({ name: '', type: 'unplanned', icon: 'wrench', color: '#ef4444', comment_required: false, triggers_maintenance: false });
    setShowAdd(false);
    await load();
    setBusy(false);
  };

  const delCat = async (id: string) => {
    if (!confirm('Delete this category and all its subcategories?')) return;
    try {
      await deleteMachineStopCategory(slug, id);
    } catch (e) {
      alert(t('equipment.deleteFailed', { detail: errDetail(e) }));
      return;
    }
    if (selected?.id === id) setSelected(null);
    await load();
  };

  const addSub = async () => {
    if (!selected || !addSubForm.name.trim()) return;
    setBusy(true);
    await addStopSubcategory(slug, selected.id, addSubForm);
    setAddSubForm({ name: '', icon: 'wrench', color: '#6b7280', comment_required: false, triggers_maintenance: false });
    setShowAddSub(false);
    await refreshKeepingSelection(selected.id);
    setBusy(false);
  };

  const startEditSub = (sub: StopSubcategoryOut) => {
    setEditSubId(sub.id);
    setEditSubForm({
      name: sub.name, icon: sub.icon || 'wrench', color: sub.color || '#6b7280',
      triggers_maintenance: !!sub.triggers_maintenance,
    });
  };

  const saveEditSub = async () => {
    if (!selected || !editSubId || !editSubForm.name.trim()) return;
    setBusy(true);
    try {
      await updateStopSubcategory(slug, editSubId, editSubForm);
      setEditSubId(null);
      await refreshKeepingSelection(selected.id);
    } finally {
      setBusy(false);
    }
  };

  const delSub = async (subId: string) => {
    if (!selected) return;
    try {
      await deleteStopSubcategory(slug, subId);
    } catch (e) {
      alert(t('equipment.deleteFailed', { detail: errDetail(e) }));
      return;
    }
    await refreshKeepingSelection(selected.id);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">Stop Categories</h2>
        <div className="flex gap-2">
          <button onClick={() => setShowClone(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-white/[0.05] hover:bg-white/[0.1] text-gray-300 rounded-xl text-xs font-bold border border-white/10 transition-colors">
            <Copy size={12} /> Clone to…
          </button>
          <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition-colors">
            <Plus size={12} /> Add
          </button>
        </div>
      </div>

      {showAdd && (
        <div className="p-4 bg-[#0d1421] rounded-2xl border border-white/[0.06] space-y-3">
          <input value={addForm.name} onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Category name" className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          <div className="flex gap-2 flex-wrap">
            {STOP_TYPES.map((t) => (
              <button key={t} type="button" onClick={() => setAddForm((f) => ({ ...f, type: t }))}
                className={`px-3 py-1 rounded-xl text-xs font-bold capitalize border transition-all ${addForm.type === t ? 'bg-blue-600 text-white border-blue-500' : 'bg-white/[0.04] text-gray-400 border-white/10'}`}>
                {t}
              </button>
            ))}
          </div>
          <div className="flex gap-3 items-center">
            <div><label className="block text-xs text-gray-500 mb-1">Icon</label><IconPicker value={addForm.icon} onChange={(k) => setAddForm((f) => ({ ...f, icon: k }))} /></div>
            <div><label className="block text-xs text-gray-500 mb-1">Color</label>
              <input type="color" value={addForm.color} onChange={(e) => setAddForm((f) => ({ ...f, color: e.target.value }))} className="w-10 h-10 rounded-lg cursor-pointer border-0 bg-transparent" />
            </div>
          </div>
          <div className="flex gap-4">
            <Toggle label="Comment required" checked={addForm.comment_required} onChange={(v) => setAddForm((f) => ({ ...f, comment_required: v }))} />
            <Toggle label="Triggers maintenance" checked={addForm.triggers_maintenance} onChange={(v) => setAddForm((f) => ({ ...f, triggers_maintenance: v }))} />
          </div>
          <div className="flex gap-2">
            <button onClick={addCat} disabled={busy || !addForm.name.trim()} className="bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-50 flex items-center gap-1.5"><Check size={13} /> Add</button>
            <button onClick={() => setShowAdd(false)} className="text-gray-500 px-4 py-2 border border-white/10 rounded-xl text-sm"><X size={13} /></button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {cats.map((cat) => (
          <CategoryCard key={cat.id} cat={cat} selected={selected?.id === cat.id}
            onSelect={() => setSelected(selected?.id === cat.id ? null : cat)}
            onDelete={() => delCat(cat.id)} />
        ))}
        {cats.length === 0 && <p className="col-span-2 text-center py-10 text-gray-700 text-sm">No categories. Add one or they'll fall back to global defaults.</p>}
      </div>

      {selected && (
        <div className="p-4 bg-[#0b1120] rounded-2xl border border-white/[0.06] space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest">Subcategories — {selected.name}</h3>
            <button onClick={() => setShowAddSub(true)} className="flex items-center gap-1 px-2.5 py-1 bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 rounded-lg text-xs font-bold transition-colors">
              <Plus size={11} /> Add
            </button>
          </div>
          {showAddSub && (
            <div className="p-3 bg-[#0d1421] rounded-xl space-y-2">
              <input value={addSubForm.name} onChange={(e) => setAddSubForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Subcategory name" className="w-full bg-[#0b1120] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
              <div className="flex gap-3 items-center">
                <IconPicker value={addSubForm.icon} onChange={(k) => setAddSubForm((f) => ({ ...f, icon: k }))} />
                <input type="color" value={addSubForm.color} onChange={(e) => setAddSubForm((f) => ({ ...f, color: e.target.value }))} className="w-9 h-9 rounded-lg cursor-pointer border-0 bg-transparent" />
                <Toggle label="Triggers maintenance" checked={addSubForm.triggers_maintenance} onChange={(v) => setAddSubForm((f) => ({ ...f, triggers_maintenance: v }))} />
              </div>
              <div className="flex gap-2">
                <button onClick={addSub} disabled={busy || !addSubForm.name.trim()} className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold disabled:opacity-50 flex items-center gap-1"><Check size={11} /> Add</button>
                <button onClick={() => setShowAddSub(false)} className="text-gray-500 px-3 py-1.5 border border-white/10 rounded-lg text-xs"><X size={11} /></button>
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            {(selected.subcategories || []).map((sub: StopSubcategoryOut) => (
              editSubId === sub.id ? (
                <div key={sub.id} className="p-3 bg-[#0d1421] rounded-xl space-y-2 border border-blue-500/30">
                  <input value={editSubForm.name} onChange={(e) => setEditSubForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder={t('equipment.subNamePlaceholder')} className="w-full bg-[#0b1120] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
                  <div className="flex gap-3 items-center">
                    <IconPicker value={editSubForm.icon} onChange={(k) => setEditSubForm((f) => ({ ...f, icon: k }))} />
                    <input type="color" value={editSubForm.color} onChange={(e) => setEditSubForm((f) => ({ ...f, color: e.target.value }))} className="w-9 h-9 rounded-lg cursor-pointer border-0 bg-transparent" />
                    <Toggle label={t('equipment.triggersMaintenance')} checked={editSubForm.triggers_maintenance} onChange={(v) => setEditSubForm((f) => ({ ...f, triggers_maintenance: v }))} />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={saveEditSub} disabled={busy || !editSubForm.name.trim()} className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold disabled:opacity-50 flex items-center gap-1"><Check size={11} /> {t('common.save')}</button>
                    <button onClick={() => setEditSubId(null)} className="text-gray-500 px-3 py-1.5 border border-white/10 rounded-lg text-xs"><X size={11} /></button>
                  </div>
                </div>
              ) : (
                <div key={sub.id} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-white/[0.03]">
                  <IconRenderer icon={sub.icon} color={sub.color || '#6b7280'} size={16} />
                  <span className="flex-1 text-sm text-gray-300">{sub.name}</span>
                  {sub.triggers_maintenance && <span className="text-xs text-orange-400 bg-orange-400/10 px-2 py-0.5 rounded-full">🔧 maint.</span>}
                  <button onClick={() => startEditSub(sub)} title={t('common.edit')} className="p-1 rounded-lg text-gray-700 hover:text-blue-400 hover:bg-blue-400/10 transition-colors"><Pencil size={11} /></button>
                  <button onClick={() => delSub(sub.id)} className="p-1 rounded-lg text-gray-700 hover:text-red-400 hover:bg-red-400/10 transition-colors"><Trash2 size={11} /></button>
                </div>
              )
            ))}
            {(selected.subcategories || []).length === 0 && <p className="text-xs text-gray-700 text-center py-4">No subcategories</p>}
          </div>
        </div>
      )}

      {showClone && <CloneModal machines={allMachines} sourceMachineId={machineId} categoryType="stop" onClose={() => setShowClone(false)} />}
    </div>
  );
}

// ─── Reject Categories tab ────────────────────────────────────────────────────────

function RejectCategoriesTab({ slug, allMachines, machineId }: { slug: string; allMachines: Machine[]; machineId: string }) {
  const [cats, setCats] = useState<RejectCategoryOut[]>([]);
  const [selected, setSelected] = useState<RejectCategoryOut | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showClone, setShowClone] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', icon: 'quality', color: '#10b981', comment_required: false });
  const [addSubForm, setAddSubForm] = useState({ name: '', icon: 'quality', color: '#6b7280', comment_required: false });
  const [showAddSub, setShowAddSub] = useState(false);
  const [editSubId, setEditSubId] = useState<string | null>(null);
  const [editSubForm, setEditSubForm] = useState({ name: '', icon: 'quality', color: '#6b7280' });
  const [busy, setBusy] = useState(false);
  const { t } = useTranslation();

  const load = useCallback(async () => { setCats(await fetchMachineRejectCategories(slug)); }, [slug]);
  useEffect(() => { load(); }, [load]);

  const refreshKeepingSelection = async (selectedId: string) => {
    const refreshed = await fetchMachineRejectCategories(slug);
    setCats(refreshed);
    setSelected(refreshed.find((c) => c.id === selectedId) ?? null);
  };

  const addCat = async () => {
    if (!addForm.name.trim()) return;
    setBusy(true);
    await createMachineRejectCategory(slug, addForm);
    setAddForm({ name: '', icon: 'quality', color: '#10b981', comment_required: false });
    setShowAdd(false);
    await load();
    setBusy(false);
  };

  const delCat = async (id: string) => {
    if (!confirm('Delete this reject category?')) return;
    try {
      await deleteMachineRejectCategory(slug, id);
    } catch (e) {
      alert(t('equipment.deleteFailed', { detail: errDetail(e) }));
      return;
    }
    if (selected?.id === id) setSelected(null);
    await load();
  };

  const addSub = async () => {
    if (!selected || !addSubForm.name.trim()) return;
    setBusy(true);
    await addRejectSubcategory(slug, selected.id, addSubForm);
    setAddSubForm({ name: '', icon: 'quality', color: '#6b7280', comment_required: false });
    setShowAddSub(false);
    await refreshKeepingSelection(selected.id);
    setBusy(false);
  };

  const startEditSub = (sub: RejectSubcategoryOut) => {
    setEditSubId(sub.id);
    setEditSubForm({ name: sub.name, icon: sub.icon || 'quality', color: sub.color || '#6b7280' });
  };

  const saveEditSub = async () => {
    if (!selected || !editSubId || !editSubForm.name.trim()) return;
    setBusy(true);
    try {
      await updateRejectSubcategory(slug, editSubId, editSubForm);
      setEditSubId(null);
      await refreshKeepingSelection(selected.id);
    } finally {
      setBusy(false);
    }
  };

  const delSub = async (subId: string) => {
    if (!selected) return;
    try {
      await deleteRejectSubcategory(slug, subId);
    } catch (e) {
      alert(t('equipment.deleteFailed', { detail: errDetail(e) }));
      return;
    }
    await refreshKeepingSelection(selected.id);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">Reject Categories</h2>
        <div className="flex gap-2">
          <button onClick={() => setShowClone(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-white/[0.05] hover:bg-white/[0.1] text-gray-300 rounded-xl text-xs font-bold border border-white/10 transition-colors">
            <Copy size={12} /> Clone to…
          </button>
          <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition-colors">
            <Plus size={12} /> Add
          </button>
        </div>
      </div>

      {showAdd && (
        <div className="p-4 bg-[#0d1421] rounded-2xl border border-white/[0.06] space-y-3">
          <input value={addForm.name} onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Category name" className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          <div className="flex gap-3 items-center">
            <div><label className="block text-xs text-gray-500 mb-1">Icon</label><IconPicker value={addForm.icon} onChange={(k) => setAddForm((f) => ({ ...f, icon: k }))} /></div>
            <div><label className="block text-xs text-gray-500 mb-1">Color</label>
              <input type="color" value={addForm.color} onChange={(e) => setAddForm((f) => ({ ...f, color: e.target.value }))} className="w-10 h-10 rounded-lg cursor-pointer border-0 bg-transparent" />
            </div>
            <Toggle label="Comment required" checked={addForm.comment_required} onChange={(v) => setAddForm((f) => ({ ...f, comment_required: v }))} />
          </div>
          <div className="flex gap-2">
            <button onClick={addCat} disabled={busy || !addForm.name.trim()} className="bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-50 flex items-center gap-1.5"><Check size={13} /> Add</button>
            <button onClick={() => setShowAdd(false)} className="text-gray-500 px-4 py-2 border border-white/10 rounded-xl text-sm"><X size={13} /></button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {cats.map((cat) => (
          <CategoryCard key={cat.id} cat={cat} selected={selected?.id === cat.id}
            onSelect={() => setSelected(selected?.id === cat.id ? null : cat)}
            onDelete={() => delCat(cat.id)} />
        ))}
        {cats.length === 0 && <p className="col-span-2 text-center py-10 text-gray-700 text-sm">No reject categories configured.</p>}
      </div>

      {selected && (
        <div className="p-4 bg-[#0b1120] rounded-2xl border border-white/[0.06] space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest">Subcategories — {selected.name}</h3>
            <button onClick={() => setShowAddSub(true)} className="flex items-center gap-1 px-2.5 py-1 bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 rounded-lg text-xs font-bold transition-colors">
              <Plus size={11} /> Add
            </button>
          </div>
          {showAddSub && (
            <div className="p-3 bg-[#0d1421] rounded-xl space-y-2">
              <input value={addSubForm.name} onChange={(e) => setAddSubForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Subcategory name" className="w-full bg-[#0b1120] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
              <div className="flex gap-3 items-center">
                <IconPicker value={addSubForm.icon} onChange={(k) => setAddSubForm((f) => ({ ...f, icon: k }))} />
                <input type="color" value={addSubForm.color} onChange={(e) => setAddSubForm((f) => ({ ...f, color: e.target.value }))} className="w-9 h-9 rounded-lg cursor-pointer border-0 bg-transparent" />
              </div>
              <div className="flex gap-2">
                <button onClick={addSub} disabled={busy || !addSubForm.name.trim()} className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold disabled:opacity-50 flex items-center gap-1"><Check size={11} /> Add</button>
                <button onClick={() => setShowAddSub(false)} className="text-gray-500 px-3 py-1.5 border border-white/10 rounded-lg text-xs"><X size={11} /></button>
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            {(selected.subcategories || []).map((sub: RejectSubcategoryOut) => (
              editSubId === sub.id ? (
                <div key={sub.id} className="p-3 bg-[#0d1421] rounded-xl space-y-2 border border-blue-500/30">
                  <input value={editSubForm.name} onChange={(e) => setEditSubForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder={t('equipment.subNamePlaceholder')} className="w-full bg-[#0b1120] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
                  <div className="flex gap-3 items-center">
                    <IconPicker value={editSubForm.icon} onChange={(k) => setEditSubForm((f) => ({ ...f, icon: k }))} />
                    <input type="color" value={editSubForm.color} onChange={(e) => setEditSubForm((f) => ({ ...f, color: e.target.value }))} className="w-9 h-9 rounded-lg cursor-pointer border-0 bg-transparent" />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={saveEditSub} disabled={busy || !editSubForm.name.trim()} className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold disabled:opacity-50 flex items-center gap-1"><Check size={11} /> {t('common.save')}</button>
                    <button onClick={() => setEditSubId(null)} className="text-gray-500 px-3 py-1.5 border border-white/10 rounded-lg text-xs"><X size={11} /></button>
                  </div>
                </div>
              ) : (
                <div key={sub.id} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-white/[0.03]">
                  <IconRenderer icon={sub.icon || 'quality'} color={sub.color || '#6b7280'} size={16} />
                  <span className="flex-1 text-sm text-gray-300">{sub.name}</span>
                  <button onClick={() => startEditSub(sub)} title={t('common.edit')} className="p-1 rounded-lg text-gray-700 hover:text-blue-400 hover:bg-blue-400/10 transition-colors"><Pencil size={11} /></button>
                  <button onClick={() => delSub(sub.id)} className="p-1 rounded-lg text-gray-700 hover:text-red-400 hover:bg-red-400/10 transition-colors"><Trash2 size={11} /></button>
                </div>
              )
            ))}
            {(selected.subcategories || []).length === 0 && <p className="text-xs text-gray-700 text-center py-4">No subcategories</p>}
          </div>
        </div>
      )}

      {showClone && <CloneModal machines={allMachines} sourceMachineId={machineId} categoryType="reject" onClose={() => setShowClone(false)} />}
    </div>
  );
}

// ─── Operators tab ────────────────────────────────────────────────────────────────

function OperatorsTab({ machineRef }: { machineRef: string }) {
  const [operators, setOperators] = useState<MachineOperatorOut[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<MachineOperatorCreate>({ name: '', shift: 'all' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get<MachineOperatorOut[]>(`/api/machines/${machineRef}/operators`);
    setOperators(data);
  }, [machineRef]);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!form.name.trim()) return;
    setBusy(true);
    await addMachineOperator(machineRef, form);
    setForm({ name: '', shift: 'all' });
    setShowAdd(false);
    await load();
    setBusy(false);
  };

  const toggle = async (op: MachineOperatorOut) => {
    await updateMachineOperatorRecord(op.id, { is_active: !op.is_active });
    await load();
  };

  const del = async (op: MachineOperatorOut) => {
    if (!confirm(`Remove ${op.name}?`)) return;
    await deleteOperator(op.id);
    await load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">Operators</h2>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition-colors">
          <Plus size={12} /> Add
        </button>
      </div>

      {showAdd && (
        <div className="p-4 bg-[#0d1421] rounded-2xl border border-white/[0.06] space-y-3">
          <div className="flex gap-2">
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Full name" className="flex-1 bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            <input value={form.employee_code || ''} onChange={(e) => setForm((f) => ({ ...f, employee_code: e.target.value }))}
              placeholder="Employee #" className="w-28 bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div className="flex gap-2 flex-wrap">
            {SHIFTS.map((s) => (
              <button key={s} type="button" onClick={() => setForm((f) => ({ ...f, shift: s }))}
                className={`px-3 py-1 rounded-xl text-xs font-bold capitalize border transition-all ${form.shift === s ? 'bg-blue-600 text-white border-blue-500' : 'bg-white/[0.04] text-gray-400 border-white/10'}`}>
                {s}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={add} disabled={busy || !form.name.trim()} className="bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-50 flex items-center gap-1.5"><Check size={13} /> Add</button>
            <button onClick={() => setShowAdd(false)} className="text-gray-500 px-4 py-2 border border-white/10 rounded-xl text-sm"><X size={13} /></button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {operators.length === 0 && <p className="text-center py-10 text-gray-700 text-sm">No operators configured.</p>}
        {operators.map((op) => (
          <div key={op.id} className={`bg-[#0d1421] rounded-2xl border border-white/[0.06] p-4 flex items-center gap-3 ${!op.is_active ? 'opacity-50' : ''}`}>
            <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-base font-black text-blue-400">
              {op.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-white">{op.name}</p>
              <p className="text-xs text-gray-600 capitalize">{op.employee_code ? `#${op.employee_code} · ` : ''}{op.shift}</p>
            </div>
            <button onClick={() => toggle(op)} className={`px-3 py-1 rounded-xl text-xs font-bold border transition-all ${op.is_active ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-gray-500/10 text-gray-600 border-gray-700'}`}>
              {op.is_active ? 'Active' : 'Inactive'}
            </button>
            <button onClick={() => del(op)} className="p-1.5 rounded-lg text-gray-700 hover:text-red-400 hover:bg-red-400/10 transition-colors"><Trash2 size={13} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Work Shifts tab ──────────────────────────────────────────────────────────────

const DEFAULT_SHIFTS_DEF = [
  { key: 'morning',   label: 'Morning',   defaultStart: '06:00', defaultEnd: '14:00', color: '#f59e0b' },
  { key: 'afternoon', label: 'Afternoon', defaultStart: '14:00', defaultEnd: '22:00', color: '#3b82f6' },
  { key: 'night',     label: 'Night',     defaultStart: '22:00', defaultEnd: '06:00', color: '#8b5cf6' },
];

function WorkShiftsTab({ machineId, savedConfig }: {
  machineId: string;
  savedConfig?: Record<string, { start: string; end: string }> | null;
}) {
  const initShifts = DEFAULT_SHIFTS_DEF.map((s) => ({
    ...s,
    start: savedConfig?.[s.key]?.start ?? s.defaultStart,
    end:   savedConfig?.[s.key]?.end   ?? s.defaultEnd,
  }));
  const [shifts, setShifts] = useState(initShifts);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    const config: Record<string, { start: string; end: string }> = {};
    shifts.forEach((s) => { config[s.key] = { start: s.start, end: s.end }; });
    try {
      await api.patch(`/api/machines/${machineId}`, { shifts_config: config });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">Work Shifts</h2>
      <p className="text-xs text-gray-600">Shift definitions are used for stop/reject traceability.</p>
      <div className="space-y-3">
        {shifts.map((sh, i) => (
          <div key={sh.key} className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-4 flex items-center gap-4">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: sh.color }} />
            <span className="w-24 text-sm font-bold text-white">{sh.label}</span>
            <div className="flex items-center gap-2 flex-1">
              <input type="time" value={sh.start}
                onChange={(e) => setShifts((prev) => prev.map((x, j) => j === i ? { ...x, start: e.target.value } : x))}
                className="bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
              <span className="text-gray-600 text-xs">to</span>
              <input type="time" value={sh.end}
                onChange={(e) => setShifts((prev) => prev.map((x, j) => j === i ? { ...x, end: e.target.value } : x))}
                className="bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button onClick={handleSave} disabled={saving} className="btn-primary py-2 px-5 text-sm">
          {saving ? 'Saving...' : 'Save shifts'}
        </button>
        {saved && <span className="text-green-400 text-sm">Saved.</span>}
      </div>
      <p className="text-xs text-gray-700 italic">Shift times are informational — actual shift assignment is done on the machine kiosk page.</p>
    </div>
  );
}

// ─── Parameters tab ───────────────────────────────────────────────────────────────

// Total operating hours/day and shift count from the machine's shifts_config
// (overnight-aware). Mirrors the backend's _shift_hours so the per-shift/daily
// preview matches what gets persisted. Falls back to 3 shifts × 8h = 24h/day.
export function shiftHours(cfg?: Record<string, { start: string; end: string }> | null): { total: number; count: number } {
  const durations: number[] = [];
  for (const s of Object.values(cfg || {})) {
    const [sh, sm] = String(s?.start ?? '').split(':').map(Number);
    const [eh, em] = String(s?.end ?? '').split(':').map(Number);
    if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) continue;
    const start = sh * 60 + sm, end = eh * 60 + em;
    const span = end > start ? end - start : end + 24 * 60 - start;  // overnight-aware
    if (span > 0) durations.push(span / 60);
  }
  if (!durations.length) return { total: 24, count: 3 };
  return { total: durations.reduce((a, b) => a + b, 0), count: durations.length };
}

function ParametersTab({ form, set, shiftsConfig }: {
  form: MachineConfigUpdate;
  set: <K extends keyof MachineConfigUpdate>(k: K, v: MachineConfigUpdate[K]) => void;
  shiftsConfig?: Record<string, { start: string; end: string }> | null;
}) {
  const { t } = useTranslation();
  const { total: dayHours, count: shiftCount } = shiftHours(shiftsConfig);
  const avgShiftHours = shiftCount ? dayHours / shiftCount : 8;
  const perHour  = form.target_count_per_hour ?? 0;
  const perShift = Math.round(perHour * avgShiftHours);
  const daily    = Math.round(perHour * dayHours);
  const fmtH = (h: number) => (Number.isInteger(h) ? String(h) : h.toFixed(1));
  const calcBadge = (
    <span className="text-[10px] uppercase tracking-wide text-blue-400/80 bg-blue-500/10 px-1.5 py-0.5 rounded">{t('equipment.paramCalculated')}</span>
  );
  return (
    <div className="space-y-6">
      <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5 space-y-4">
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">{t('equipment.paramTargets')}</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-500 mb-1.5">{t('equipment.paramTargetAvailability')}</label>
            <input type="number" min={0} max={100} value={form.target_availability_pct ?? 70}
              onChange={(e) => set('target_availability_pct', Number(e.target.value))}
              className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="block text-sm text-gray-500 mb-1.5">{t('equipment.paramHourlyTarget')}</label>
            <input type="number" min={0} value={form.target_count_per_hour ?? 0}
              onChange={(e) => set('target_count_per_hour', Number(e.target.value))}
              className="w-full bg-[#0b1120] border border-blue-500/40 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-blue-500" />
            <p className="mt-1.5 text-xs text-gray-600">{t('equipment.paramHourlyTargetHint')}</p>
          </div>
          <div>
            <label className="flex items-center gap-2 text-sm text-gray-500 mb-1.5">{t('equipment.paramPerShiftTarget')} {calcBadge}</label>
            <input type="number" value={perShift || ''} readOnly disabled tabIndex={-1}
              className="w-full bg-white/[0.02] border border-white/10 rounded-xl px-4 py-2.5 text-gray-400 cursor-not-allowed" />
          </div>
          <div>
            <label className="flex items-center gap-2 text-sm text-gray-500 mb-1.5">{t('equipment.paramDailyTarget')} {calcBadge}</label>
            <input type="number" value={daily || ''} readOnly disabled tabIndex={-1}
              className="w-full bg-white/[0.02] border border-white/10 rounded-xl px-4 py-2.5 text-gray-400 cursor-not-allowed" />
          </div>
        </div>
        <p className="text-xs text-gray-600">{t('equipment.paramDerivedNote', { shifts: shiftCount, total: fmtH(dayHours) })}</p>
      </div>

      <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5 space-y-4">
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">Hourly Rate</h2>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-sm text-gray-500 mb-1.5">Rate</label>
            <input type="number" min={0} step="0.01" value={form.hourly_rate ?? ''}
              onChange={(e) => set('hourly_rate', e.target.value ? Number(e.target.value) : undefined)}
              placeholder="e.g. 85.00"
              className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="block text-sm text-gray-500 mb-1.5">Currency</label>
            <div className="flex gap-1">
              {CURRENCIES.map((c) => (
                <button key={c} type="button" onClick={() => set('hourly_rate_currency', c)}
                  className={`px-3 py-2.5 rounded-xl text-xs font-bold border transition-all ${form.hourly_rate_currency === c ? 'bg-blue-600 text-white border-blue-500' : 'bg-white/[0.04] text-gray-400 border-white/10'}`}>
                  {c}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5 space-y-4">
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">Panels</h2>
        <Toggle label="Show Production Panel"   checked={!!form.show_production_panel}   onChange={(v) => set('show_production_panel', v)} />
        <Toggle label="Show Availability Gauge" checked={!!form.show_availability_gauge} onChange={(v) => set('show_availability_gauge', v)} />
        <Toggle label="Show Reject Panel"       checked={!!form.show_reject_panel}       onChange={(v) => set('show_reject_panel', v)} />
        <Toggle label="Show Job Number"         checked={!!form.show_job_number}         onChange={(v) => set('show_job_number', v)} />
      </div>
    </div>
  );
}

// ─── Intervention Types config tab ───────────────────────────────────────────────

// Picker choices + name→component map live in IconLibrary (named imports only —
// a `import * as lucide` here used to pull the whole icon package into the bundle).
const IT_ICONS = INTERVENTION_ICONS;

function ITDynamicIcon({ name, size = 16 }: { name: string; size?: number }) {
  const Icon = INTERVENTION_ICON_MAP[name];
  if (Icon) return <Icon size={size} />;
  return <span style={{ fontSize: Math.floor(size * 0.6) }}>{name ? name[0] : '?'}</span>;
}

interface ITForm { name: string; icon: string; color: string; sort_order: number; }
const IT_EMPTY: ITForm = { name: '', icon: 'Wrench', color: '#388bfd', sort_order: 0 };

function ITIconPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {IT_ICONS.map((ic) => (
        <button key={ic} type="button" onClick={() => onChange(ic)} title={ic}
          className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${
            value === ic
              ? 'bg-blue-600 text-white'
              : 'bg-white/[0.04] border border-white/10 text-gray-400 hover:text-gray-200 hover:border-blue-500/40'
          }`}>
          <ITDynamicIcon name={ic} size={13} />
        </button>
      ))}
    </div>
  );
}

function InterventionTypesConfigTab({ equipmentId }: { equipmentId: string }) {
  const [types, setTypes] = useState<InterventionType[]>([]);
  const [loadingIT, setLoadingIT] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState<ITForm>(IT_EMPTY);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<ITForm>(IT_EMPTY);
  const [saving, setSaving] = useState(false);

  const { t } = useTranslation();
  const [allEquipment, setAllEquipment] = useState<Equipment[]>([]);
  const [showClone, setShowClone] = useState(false);
  const [cloneTargets, setCloneTargets] = useState<string[]>([]);
  const [cloneQuery, setCloneQuery] = useState('');
  const [cloning, setCloning] = useState(false);
  const [cloneMsg, setCloneMsg] = useState('');
  useEffect(() => { fetchEquipment({ limit: '1000' }).then(setAllEquipment).catch(() => {}); }, []);
  const toggleCloneTarget = (id: string) =>
    setCloneTargets((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const handleCloneIT = async () => {
    if (cloneTargets.length === 0) return;
    setCloning(true);
    try {
      const r = await api.post('/api/settings/intervention-types/clone', {
        source_equipment_id: equipmentId, target_equipment_ids: cloneTargets,
      });
      setCloneMsg(t('equipment.cloneITSuccess', { count: r.data.cloned_to, defaultValue: `Copié vers ${r.data.cloned_to} équipement(s)` }));
      setShowClone(false); setCloneTargets([]); setCloneQuery('');
      setTimeout(() => setCloneMsg(''), 4000);
    } finally { setCloning(false); }
  };

  const load = useCallback(async () => {
    setLoadingIT(true);
    try {
      const r = await api.get(`/api/settings/intervention-types/?equipment_id=${equipmentId}`);
      setTypes(r.data.items.filter((t: InterventionType) => t.is_active));
    } catch {
      setTypes([]);
    } finally {
      setLoadingIT(false);
    }
  }, [equipmentId]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!addForm.name.trim()) return;
    setSaving(true);
    try {
      await api.post('/api/settings/intervention-types/', {
        equipment_id: equipmentId,
        name: addForm.name.trim(),
        icon: addForm.icon,
        color: addForm.color,
        sort_order: addForm.sort_order,
      });
      setShowAdd(false);
      setAddForm(IT_EMPTY);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = async (id: string) => {
    setSaving(true);
    try {
      await api.patch(`/api/settings/intervention-types/${id}`, {
        name: editForm.name.trim(),
        icon: editForm.icon,
        color: editForm.color,
        sort_order: editForm.sort_order,
      });
      setEditId(null);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteIT = async (id: string) => {
    if (!confirm('Désactiver ce type?')) return;
    await api.delete(`/api/settings/intervention-types/${id}`);
    await load();
  };

  // Clone-target list filtered by the search box (matches name or location).
  const cloneCandidates = allEquipment.filter((eq) => eq.id !== equipmentId);
  const cloneQ = cloneQuery.trim().toLowerCase();
  const filteredCloneEquipment = cloneQ
    ? cloneCandidates.filter((eq) =>
        eq.name.toLowerCase().includes(cloneQ) || (eq.location ?? '').toLowerCase().includes(cloneQ))
    : cloneCandidates;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">Intervention Types</h2>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowClone((v) => !v)} disabled={types.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white/[0.06] hover:bg-white/[0.1] text-gray-200 rounded-xl text-xs font-bold transition-colors disabled:opacity-40">
            <Copy size={12} /> {t('equipment.cloneTo', 'Clone to…')}
          </button>
          <button onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition-colors">
            <Plus size={12} /> Add
          </button>
        </div>
      </div>

      {cloneMsg && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-teal-500/15 border border-teal-500/30 text-teal-300 text-sm">
          <Check size={14} /> {cloneMsg}
        </div>
      )}

      {showClone && (
        <div className="p-4 bg-[#0d1421] rounded-2xl border border-teal-500/30 space-y-3">
          <p className="text-sm font-semibold text-white">{t('equipment.cloneITTitle', 'Copier ces types vers…')}</p>
          <p className="text-xs text-gray-500">{t('equipment.cloneITHint', 'Les types actifs de l’équipement cible sont remplacés par ceux-ci.')}</p>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              value={cloneQuery}
              onChange={(e) => setCloneQuery(e.target.value)}
              placeholder={t('equipment.cloneITSearch', 'Rechercher un équipement…')}
              className="w-full bg-[#0b1120] border border-white/10 rounded-xl pl-9 pr-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-teal-500" />
          </div>
          <div className="max-h-52 overflow-y-auto space-y-1 pr-1">
            {filteredCloneEquipment.map((eq) => (
              <label key={eq.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/5 cursor-pointer text-sm text-gray-200">
                <input type="checkbox" checked={cloneTargets.includes(eq.id)} onChange={() => toggleCloneTarget(eq.id)}
                  className="w-4 h-4 rounded border-gray-600 bg-[#0b1120] text-teal-500" />
                {eq.name}{eq.location ? <span className="text-gray-600 text-xs">· {eq.location}</span> : null}
              </label>
            ))}
            {filteredCloneEquipment.length === 0 && (
              <p className="text-center py-4 text-gray-600 text-sm">{t('equipment.cloneITNoMatch', 'Aucun équipement trouvé')}</p>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={handleCloneIT} disabled={cloning || cloneTargets.length === 0}
              className="bg-teal-600 hover:bg-teal-500 text-white px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-50 flex items-center gap-1.5">
              {cloning ? <Loader2 size={13} className="animate-spin" /> : <Copy size={13} />}
              {t('pm.copyAction', 'Copier')} ({cloneTargets.length})
            </button>
            <button onClick={() => { setShowClone(false); setCloneTargets([]); setCloneQuery(''); }}
              className="text-gray-500 px-4 py-2 border border-white/10 rounded-xl text-sm">
              <X size={13} />
            </button>
          </div>
        </div>
      )}

      {showAdd && (
        <div className="p-4 bg-[#0d1421] rounded-2xl border border-blue-500/30 space-y-3">
          <p className="text-sm font-semibold text-white">New type</p>
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-[160px]">
              <label className="block text-xs text-gray-500 mb-1">Name</label>
              <input value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                placeholder="e.g. Conveyor..."
                className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Color</label>
              <input type="color" value={addForm.color}
                onChange={(e) => setAddForm({ ...addForm, color: e.target.value })}
                className="h-9 w-12 rounded-lg cursor-pointer border border-white/10 bg-transparent" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Order</label>
              <input type="number" value={addForm.sort_order}
                onChange={(e) => setAddForm({ ...addForm, sort_order: Number(e.target.value) })}
                className="w-16 bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-sm text-white" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-2">Icon</label>
            <ITIconPicker value={addForm.icon} onChange={(v) => setAddForm({ ...addForm, icon: v })} />
          </div>
          <div className="flex gap-2">
            <button onClick={handleAdd} disabled={saving || !addForm.name.trim()}
              className="bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-50 flex items-center gap-1.5">
              <Check size={13} /> Add
            </button>
            <button onClick={() => { setShowAdd(false); setAddForm(IT_EMPTY); }}
              className="text-gray-500 px-4 py-2 border border-white/10 rounded-xl text-sm">
              <X size={13} />
            </button>
          </div>
        </div>
      )}

      {loadingIT ? (
        <div className="py-10 text-center text-gray-600 text-sm">Loading…</div>
      ) : types.length === 0 ? (
        <div className="py-10 text-center text-gray-700 text-sm">No types configured. Add one above.</div>
      ) : (
        <div className="space-y-2">
          {types.map((t) =>
            editId === t.id ? (
              <div key={t.id} className="p-4 bg-[#0d1421] rounded-2xl border border-blue-500/30 space-y-3">
                <div className="flex flex-wrap gap-3 items-end">
                  <div className="flex-1 min-w-[160px]">
                    <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                      className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
                  </div>
                  <input type="color" value={editForm.color}
                    onChange={(e) => setEditForm({ ...editForm, color: e.target.value })}
                    className="h-9 w-12 rounded-lg cursor-pointer border border-white/10 bg-transparent" />
                  <input type="number" value={editForm.sort_order}
                    onChange={(e) => setEditForm({ ...editForm, sort_order: Number(e.target.value) })}
                    className="w-16 bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-sm text-white" />
                </div>
                <ITIconPicker value={editForm.icon} onChange={(v) => setEditForm({ ...editForm, icon: v })} />
                <div className="flex gap-2">
                  <button onClick={() => handleEdit(t.id)} disabled={saving}
                    className="bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-50 flex items-center gap-1.5">
                    <Check size={13} /> Save
                  </button>
                  <button onClick={() => setEditId(null)}
                    className="text-gray-500 px-4 py-2 border border-white/10 rounded-xl text-sm">
                    <X size={13} />
                  </button>
                </div>
              </div>
            ) : (
              <div key={t.id} className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-4 flex items-center gap-3 hover:border-white/20 transition-colors">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: `${t.color}18`, color: t.color, border: `1px solid ${t.color}40` }}>
                  <ITDynamicIcon name={t.icon} size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-white">{t.name}</p>
                  <p className="text-xs text-gray-600 font-mono">{t.icon}</p>
                </div>
                <div className="w-4 h-4 rounded-full flex-shrink-0" style={{ background: t.color }} />
                <button
                  onClick={() => { setEditId(t.id); setEditForm({ name: t.name, icon: t.icon, color: t.color, sort_order: t.sort_order }); }}
                  className="p-1.5 rounded-lg text-gray-700 hover:text-blue-400 hover:bg-blue-400/10 transition-colors">
                  <Pencil size={13} />
                </button>
                <button onClick={() => handleDeleteIT(t.id)}
                  className="p-1.5 rounded-lg text-gray-700 hover:text-red-400 hover:bg-red-400/10 transition-colors">
                  <Trash2 size={13} />
                </button>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

// ─── PM Templates Config Tab ─────────────────────────────────────────────────────

const PM_FREQUENCIES: PmFrequency[] = ['daily', 'weekly', 'monthly', 'quarterly', 'semiannual', 'annual'];

interface PmTemplateFormState {
  name: string;
  frequency_type: PmFrequency;
  description: string;
  estimated_hours: number;
}

const EMPTY_PM_TEMPLATE_FORM: PmTemplateFormState = {
  name: '',
  frequency_type: 'monthly',
  description: '',
  estimated_hours: 1,
};

function PmTemplatesConfigTab({ equipmentId }: { equipmentId: string }) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<PmTemplate[]>([]);
  const [loadingPM, setLoadingPM] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState<PmTemplateFormState>(EMPTY_PM_TEMPLATE_FORM);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<PmTemplateFormState>(EMPTY_PM_TEMPLATE_FORM);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [allEquipment, setAllEquipment] = useState<Equipment[]>([]);
  const [cloneFor, setCloneFor] = useState<string | null>(null);
  const [cloneTargets, setCloneTargets] = useState<string[]>([]);
  const [cloning, setCloning] = useState(false);
  const [cloneMsg, setCloneMsg] = useState('');

  const load = useCallback(async () => {
    setLoadingPM(true);
    try {
      const items = await fetchPmTemplates({ equipment_id: equipmentId });
      setTemplates(items);
    } catch {
      setTemplates([]);
    } finally {
      setLoadingPM(false);
    }
  }, [equipmentId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { fetchEquipment({ limit: '1000' }).then(setAllEquipment).catch(() => {}); }, []);

  const openClone = (id: string) => { setCloneFor(id); setCloneTargets([]); setCloneMsg(''); };
  const toggleCloneTarget = (id: string) =>
    setCloneTargets((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);

  const handleClone = async () => {
    if (!cloneFor || cloneTargets.length === 0) return;
    setCloning(true);
    try {
      const res = await clonePmTemplate(cloneFor, cloneTargets);
      setCloneMsg(t('pm.cloneSuccess', { count: res.cloned_to, defaultValue: `Copié vers ${res.cloned_to} équipement(s)` }));
      setCloneFor(null);
      setCloneTargets([]);
    } finally {
      setCloning(false);
    }
  };

  const handleAdd = async () => {
    if (!addForm.name.trim()) return;
    setSaving(true);
    try {
      const created = await createPmTemplate({
        equipment_id: equipmentId,
        frequency_type: addForm.frequency_type,
        name: addForm.name.trim(),
        description: addForm.description.trim() || undefined,
        estimated_hours: addForm.estimated_hours,
      });
      setShowAdd(false);
      setAddForm(EMPTY_PM_TEMPLATE_FORM);
      await load();
      setExpandedId(created.id);   // open the procedure editor right away
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = async (id: string) => {
    setSaving(true);
    try {
      await updatePmTemplate(id, {
        name: editForm.name.trim(),
        frequency_type: editForm.frequency_type,
        description: editForm.description.trim() || undefined,
        estimated_hours: editForm.estimated_hours,
      });
      setEditId(null);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (tpl: PmTemplate) => {
    await updatePmTemplate(tpl.id, { is_active: !tpl.is_active });
    await load();
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('pm.confirmDeleteTemplate'))) return;
    await deletePmTemplate(id);
    await load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">{t('pm.templates')}</h2>
        <button onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition-colors">
          <Plus size={12} /> {t('common.add')}
        </button>
      </div>

      {cloneMsg && (
        <div className="flex items-center gap-2 p-2.5 bg-teal-500/10 border border-teal-500/30 rounded-xl text-teal-300 text-sm">
          <Check size={14} /> {cloneMsg}
        </div>
      )}

      {showAdd && (
        <div className="p-4 bg-[#0d1421] rounded-2xl border border-blue-500/30 space-y-3">
          <p className="text-sm font-semibold text-white">{t('pm.newTemplate')}</p>
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-[160px]">
              <label className="block text-xs text-gray-500 mb-1">{t('pm.name')}</label>
              <input value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                placeholder={t('pm.namePlaceholder')}
                className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">{t('pm.frequencyType')}</label>
              <select value={addForm.frequency_type} onChange={(e) => setAddForm({ ...addForm, frequency_type: e.target.value as PmFrequency })}
                className="bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
                {PM_FREQUENCIES.map((f) => <option key={f} value={f}>{t(`pmFrequency.${f}`)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">{t('pm.estimatedHours')}</label>
              <input type="number" min={0} step="0.5" value={addForm.estimated_hours}
                onChange={(e) => setAddForm({ ...addForm, estimated_hours: Number(e.target.value) })}
                className="w-20 bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-sm text-white" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('common.description')}</label>
            <input value={addForm.description} onChange={(e) => setAddForm({ ...addForm, description: e.target.value })}
              className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500" />
          </div>
          <div className="flex gap-2">
            <button onClick={handleAdd} disabled={saving || !addForm.name.trim()}
              className="bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-50 flex items-center gap-1.5">
              <Check size={13} /> {t('common.add')}
            </button>
            <button onClick={() => { setShowAdd(false); setAddForm(EMPTY_PM_TEMPLATE_FORM); }}
              className="text-gray-500 px-4 py-2 border border-white/10 rounded-xl text-sm">
              <X size={13} />
            </button>
          </div>
        </div>
      )}

      {loadingPM ? (
        <div className="py-10 text-center text-gray-600 text-sm">{t('common.loading')}</div>
      ) : templates.length === 0 ? (
        <div className="py-10 text-center text-gray-700 text-sm">{t('pm.noTemplates')}</div>
      ) : (
        <div className="space-y-2">
          {templates.map((tpl) =>
            editId === tpl.id ? (
              <div key={tpl.id} className="p-4 bg-[#0d1421] rounded-2xl border border-blue-500/30 space-y-3">
                <div className="flex flex-wrap gap-3 items-end">
                  <div className="flex-1 min-w-[160px]">
                    <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                      className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
                  </div>
                  <select value={editForm.frequency_type} onChange={(e) => setEditForm({ ...editForm, frequency_type: e.target.value as PmFrequency })}
                    className="bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
                    {PM_FREQUENCIES.map((f) => <option key={f} value={f}>{t(`pmFrequency.${f}`)}</option>)}
                  </select>
                  <input type="number" min={0} step="0.5" value={editForm.estimated_hours}
                    onChange={(e) => setEditForm({ ...editForm, estimated_hours: Number(e.target.value) })}
                    className="w-20 bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-sm text-white" />
                </div>
                <input value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                  className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
                <div className="flex gap-2">
                  <button onClick={() => handleEdit(tpl.id)} disabled={saving}
                    className="bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-50 flex items-center gap-1.5">
                    <Check size={13} /> {t('common.save')}
                  </button>
                  <button onClick={() => setEditId(null)}
                    className="text-gray-500 px-4 py-2 border border-white/10 rounded-xl text-sm">
                    <X size={13} />
                  </button>
                </div>
              </div>
            ) : (
              <div key={tpl.id} className="bg-[#0d1421] rounded-2xl border border-white/[0.06] overflow-hidden">
                <div className="flex items-center gap-3 p-4 hover:border-white/20 transition-colors">
                  <button onClick={() => setExpandedId(expandedId === tpl.id ? null : tpl.id)} className="p-1 text-gray-600 hover:text-gray-300">
                    {expandedId === tpl.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setExpandedId(expandedId === tpl.id ? null : tpl.id)}>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-bold text-white">{tpl.name}</p>
                      {!tpl.is_active && <span className="text-xs px-1.5 py-0.5 rounded-full bg-gray-500/15 text-gray-500">{t('pm.inactive')}</span>}
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-gray-600">
                      <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">{t(`pmFrequency.${tpl.frequency_type}`)}</span>
                      <span>{tpl.estimated_hours}h</span>
                      <span>{t('pm.taskCount', { count: tpl.tasks.length })}</span>
                      <span className="text-blue-400/80 inline-flex items-center gap-1">
                        <ListChecks size={11} /> {t('pm.procedureHint', 'procédure · photos/vidéos')}
                      </span>
                    </div>
                    {tpl.description && <p className="text-gray-500 text-xs mt-1">{tpl.description}</p>}
                  </div>
                  <button onClick={() => openClone(tpl.id)}
                    title={t('pm.copyTo', 'Copier vers un autre équipement')}
                    className="p-1.5 rounded-lg text-gray-700 hover:text-teal-400 hover:bg-teal-400/10 transition-colors">
                    <Copy size={13} />
                  </button>
                  <button onClick={() => handleToggleActive(tpl)}
                    title={tpl.is_active ? t('pm.deactivate') : t('pm.activate')}
                    className={`p-1.5 rounded-lg transition-colors ${tpl.is_active ? 'text-green-400 hover:bg-green-400/10' : 'text-gray-700 hover:text-gray-400 hover:bg-white/5'}`}>
                    <Power size={14} />
                  </button>
                  <button
                    onClick={() => { setEditId(tpl.id); setEditForm({ name: tpl.name, frequency_type: tpl.frequency_type, description: tpl.description ?? '', estimated_hours: tpl.estimated_hours }); }}
                    className="p-1.5 rounded-lg text-gray-700 hover:text-blue-400 hover:bg-blue-400/10 transition-colors">
                    <Pencil size={13} />
                  </button>
                  <button onClick={() => handleDelete(tpl.id)}
                    className="p-1.5 rounded-lg text-gray-700 hover:text-red-400 hover:bg-red-400/10 transition-colors">
                    <Trash2 size={13} />
                  </button>
                </div>
                {cloneFor === tpl.id && (
                  <div className="border-t border-white/[0.06] p-4 space-y-3">
                    <p className="text-sm font-semibold text-white">{t('pm.copyToTitle', 'Copier ce modèle vers…')}</p>
                    <p className="text-xs text-gray-500">{t('pm.copyToHint', 'Les étapes, photos, vidéos et liens sont copiés.')}</p>
                    <div className="max-h-52 overflow-y-auto space-y-1 pr-1">
                      {allEquipment.filter((eq) => eq.id !== equipmentId).map((eq) => (
                        <label key={eq.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/5 cursor-pointer text-sm text-gray-200">
                          <input type="checkbox" checked={cloneTargets.includes(eq.id)} onChange={() => toggleCloneTarget(eq.id)}
                            className="w-4 h-4 rounded border-gray-600 bg-[#0b1120] text-blue-500" />
                          {eq.name}{eq.location ? <span className="text-gray-600 text-xs">· {eq.location}</span> : null}
                        </label>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <button onClick={handleClone} disabled={cloning || cloneTargets.length === 0}
                        className="bg-teal-600 hover:bg-teal-500 text-white px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-50 flex items-center gap-1.5">
                        {cloning ? <Loader2 size={13} className="animate-spin" /> : <Copy size={13} />}
                        {t('pm.copyAction', 'Copier')} ({cloneTargets.length})
                      </button>
                      <button onClick={() => setCloneFor(null)} className="text-gray-500 px-4 py-2 border border-white/10 rounded-xl text-sm">
                        <X size={13} />
                      </button>
                    </div>
                  </div>
                )}
                {expandedId === tpl.id && (
                  <div className="border-t border-white/[0.06] p-4">
                    <PmStepsEditor template={tpl} onChange={load} />
                  </div>
                )}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

// PM template steps are now edited via the shared <PmStepsEditor> component
// (description + expected result + photos/videos/links), reused on the plan page.

// ─── Safety Checklist Config Tab ─────────────────────────────────────────────────

interface SCItem { id: string; text: string; sort_order: number; is_required: boolean; }

function SafetyChecklistConfigTab({ equipmentId }: { equipmentId: string }) {
  const [items, setItems] = useState<SCItem[]>([]);
  const [checklistId, setChecklistId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newText, setNewText] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/api/settings/safety-checklists/${equipmentId}`);
      setChecklistId(res.data.checklist?.id ?? null);
      setItems(res.data.items ?? []);
    } catch { setItems([]); }
    finally { setLoading(false); }
  }, [equipmentId]);

  useEffect(() => { load(); }, [load]);

  const addItem = async () => {
    if (!newText.trim()) return;
    setSaving(true);
    try {
      await api.post(`/api/settings/safety-checklists/${equipmentId}/items`, {
        text: newText.trim(),
        sort_order: items.length,
        is_required: true,
      });
      setNewText('');
      await load();
    } catch { /* ignore */ }
    finally { setSaving(false); }
  };

  const toggleRequired = async (item: SCItem) => {
    try {
      await api.patch(`/api/settings/safety-checklists/${equipmentId}/items/${item.id}`, {
        is_required: !item.is_required,
      });
      await load();
    } catch { /* ignore */ }
  };

  const deleteItem = async (id: string) => {
    setDeletingId(id);
    try {
      await api.delete(`/api/settings/safety-checklists/${equipmentId}/items/${id}`);
      await load();
    } catch { /* ignore */ }
    finally { setDeletingId(null); }
  };

  if (loading) return <div className="p-4 text-gray-500 text-sm">Chargement…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-1">
        <Shield size={15} className="text-amber-400" />
        <p className="text-sm font-semibold text-gray-200">Checklist de sécurité</p>
        {checklistId && <span className="text-xs text-gray-600 font-mono">{checklistId.slice(0, 8)}</span>}
      </div>
      <p className="text-xs text-gray-600">
        Ces éléments seront présentés au mécanicien avant de démarrer chaque intervention.
      </p>

      {items.length === 0 && (
        <p className="text-gray-600 text-sm py-2">Aucun élément — ajoutez-en un ci-dessous.</p>
      )}

      {items.map((item, idx) => (
        <div key={item.id} className="flex items-center gap-3 py-2 px-3 rounded-lg"
          style={{ background: '#0d1117', border: '1px solid #21262d' }}>
          <span className="text-gray-600 text-xs w-5 text-right">{idx + 1}</span>
          <p className="flex-1 text-sm text-gray-200">{item.text}</p>
          <button
            onClick={() => toggleRequired(item)}
            className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
              item.is_required
                ? 'text-amber-400 border-amber-500/40 bg-amber-500/10'
                : 'text-gray-600 border-gray-700/40'
            }`}>
            {item.is_required ? 'Obligatoire' : 'Optionnel'}
          </button>
          <button
            onClick={() => deleteItem(item.id)}
            disabled={deletingId === item.id}
            className="p-1 text-gray-600 hover:text-red-400 transition-colors disabled:opacity-40">
            {deletingId === item.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          </button>
        </div>
      ))}

      {/* Add new item */}
      <div className="flex gap-2 items-center">
        <input
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addItem(); }}
          placeholder="Nouvel élément de vérification…"
          className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-blue-500/50"
        />
        <button
          disabled={saving || !newText.trim()}
          onClick={addItem}
          className="px-3 py-2 rounded-lg text-sm font-medium text-white transition-all disabled:opacity-40"
          style={{ background: '#1d4ed8' }}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
        </button>
      </div>
    </div>
  );
}

// ─── Cleaning Checklist Config Tab ─────────────────────────────────────────────────
// Operator cleaning tasks shown on the kiosk when a stop is declared with the
// linked stop reason (e.g. "Nettoyage"). Mirrors the safety checklist CRUD.

function CleaningChecklistConfigTab({ equipmentId, slug }: { equipmentId: string; slug: string }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<SCItem[]>([]);
  const [checklist, setChecklist] = useState<{ id: string; stop_category_id: string | null } | null>(null);
  const [cats, setCats] = useState<StopCategoryOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [newText, setNewText] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/api/settings/cleaning-checklists/${equipmentId}`);
      setChecklist(res.data.checklist ?? null);
      setItems(res.data.items ?? []);
    } catch { setItems([]); }
    finally { setLoading(false); }
  }, [equipmentId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { fetchMachineStopCategories(slug).then(setCats).catch(() => {}); }, [slug]);

  const linkCategory = async (catId: string) => {
    try {
      await api.patch(`/api/settings/cleaning-checklists/${equipmentId}`, { stop_category_id: catId });
      await load();
    } catch { /* ignore */ }
  };

  const addItem = async () => {
    if (!newText.trim()) return;
    setSaving(true);
    try {
      await api.post(`/api/settings/cleaning-checklists/${equipmentId}/items`, {
        text: newText.trim(),
        sort_order: items.length,
        is_required: true,
      });
      setNewText('');
      await load();
    } catch { /* ignore */ }
    finally { setSaving(false); }
  };

  const toggleRequired = async (item: SCItem) => {
    try {
      await api.patch(`/api/settings/cleaning-checklists/${equipmentId}/items/${item.id}`, {
        is_required: !item.is_required,
      });
      await load();
    } catch { /* ignore */ }
  };

  const deleteItem = async (id: string) => {
    setDeletingId(id);
    try {
      await api.delete(`/api/settings/cleaning-checklists/${equipmentId}/items/${id}`);
      await load();
    } catch { /* ignore */ }
    finally { setDeletingId(null); }
  };

  if (loading) return <div className="p-4 text-gray-500 text-sm">{t('common.loading')}</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles size={15} className="text-cyan-400" />
        <p className="text-sm font-semibold text-gray-200">{t('equipment.cleaningChecklist')}</p>
        {checklist && <span className="text-xs text-gray-600 font-mono">{checklist.id.slice(0, 8)}</span>}
      </div>
      <p className="text-xs text-gray-600">{t('equipment.cleaningChecklistDesc')}</p>

      {/* Linked stop reason — which kiosk stop button opens this checklist */}
      <div className="p-3 rounded-lg space-y-1.5" style={{ background: '#0d1117', border: '1px solid #21262d' }}>
        <label className="block text-xs text-gray-500">{t('equipment.cleaningLinkedReason')}</label>
        <select
          value={checklist?.stop_category_id ?? ''}
          onChange={(e) => linkCategory(e.target.value)}
          className="w-full bg-[#0b1120] border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500/50"
        >
          <option value="">{t('equipment.cleaningNoReason')}</option>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        {!checklist?.stop_category_id ? (
          <p className="text-xs text-amber-400/80">{t('equipment.cleaningNotLinkedWarning')}</p>
        ) : (
          <p className="text-xs text-gray-600">{t('equipment.cleaningLinkedReasonHint')}</p>
        )}
      </div>

      {items.length === 0 && (
        <p className="text-gray-600 text-sm py-2">{t('equipment.checklistNoItems')}</p>
      )}

      {items.map((item, idx) => (
        <div key={item.id} className="flex items-center gap-3 py-2 px-3 rounded-lg"
          style={{ background: '#0d1117', border: '1px solid #21262d' }}>
          <span className="text-gray-600 text-xs w-5 text-right">{idx + 1}</span>
          <p className="flex-1 text-sm text-gray-200">{item.text}</p>
          <button
            onClick={() => toggleRequired(item)}
            className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
              item.is_required
                ? 'text-amber-400 border-amber-500/40 bg-amber-500/10'
                : 'text-gray-600 border-gray-700/40'
            }`}>
            {item.is_required ? t('equipment.checklistRequired') : t('equipment.checklistOptional')}
          </button>
          <button
            onClick={() => deleteItem(item.id)}
            disabled={deletingId === item.id}
            className="p-1 text-gray-600 hover:text-red-400 transition-colors disabled:opacity-40">
            {deletingId === item.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          </button>
        </div>
      ))}

      {/* Add new item */}
      <div className="flex gap-2 items-center">
        <input
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addItem(); }}
          placeholder={t('equipment.checklistNewItemPlaceholder')}
          className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-blue-500/50"
        />
        <button
          disabled={saving || !newText.trim()}
          onClick={addItem}
          className="px-3 py-2 rounded-lg text-sm font-medium text-white transition-all disabled:opacity-40"
          style={{ background: '#1d4ed8' }}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
        </button>
      </div>
    </div>
  );
}

// ─── History tab ──────────────────────────────────────────────────────────────────

interface HistoryItem {
  id: string;
  called_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  called_by_name: string;
  started_by_name: string;
  completed_by_name: string;
  intervention_type_name: string;
  operator_note: string;
  mechanic_note: string;
  response_time_minutes: number | null;
  intervention_duration_minutes: number | null;
  total_downtime_minutes: number | null;
  ticket_id: string | null;
}

function fmtMin(v: number | null): string {
  if (v == null) return '—';
  if (v < 60) return `${v.toFixed(0)} min`;
  return `${(v / 60).toFixed(1)} h`;
}

function responseColor(v: number | null): string {
  if (v == null) return 'text-gray-500';
  if (v <= 5)  return 'text-green-400';
  if (v <= 15) return 'text-amber-400';
  return 'text-red-400';
}

function HistoryTab({ equipment }: { equipment: Equipment }) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const limit = 20;

  useEffect(() => {
    setLoading(true);
    api.get(`/api/machine-operator/${equipment.id}/history?skip=${page * limit}&limit=${limit}`)
      .then(r => { setItems(r.data.items); setTotal(r.data.total); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [equipment.id, page]);

  if (loading) return <div className="text-gray-500 text-sm p-4">Loading…</div>;
  if (items.length === 0) return (
    <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-8 text-center text-gray-500 text-sm">
      No completed interventions recorded yet.
    </div>
  );

  return (
    <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] text-xs text-gray-500 uppercase">
              <th className="px-4 py-3 text-left">Date</th>
              <th className="px-4 py-3 text-left">Type</th>
              <th className="px-4 py-3 text-right">Response</th>
              <th className="px-4 py-3 text-right">Duration</th>
              <th className="px-4 py-3 text-right">Downtime</th>
              <th className="px-4 py-3 text-left">Note</th>
              <th className="px-4 py-3 text-left">Ticket</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                <td className="px-4 py-3 text-gray-300 whitespace-nowrap">
                  {item.called_at ? format(new Date(item.called_at), 'yyyy-MM-dd HH:mm') : '—'}
                </td>
                <td className="px-4 py-3 text-gray-300">{item.intervention_type_name}</td>
                <td className={`px-4 py-3 text-right font-medium ${responseColor(item.response_time_minutes)}`}>
                  {fmtMin(item.response_time_minutes)}
                </td>
                <td className="px-4 py-3 text-right text-gray-300">{fmtMin(item.intervention_duration_minutes)}</td>
                <td className="px-4 py-3 text-right text-gray-300">{fmtMin(item.total_downtime_minutes)}</td>
                <td className="px-4 py-3 text-gray-500 max-w-[200px] truncate">
                  {item.mechanic_note || item.operator_note || '—'}
                </td>
                <td className="px-4 py-3">
                  {item.ticket_id ? (
                    <Link to={`/tickets/${item.ticket_id}`} className="text-blue-400 hover:underline text-xs">
                      View
                    </Link>
                  ) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > limit && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-white/[0.06] text-xs text-gray-500">
          <span>{total} total</span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-3 py-1 rounded bg-white/[0.05] disabled:opacity-30"
            >Prev</button>
            <span className="px-2 py-1">{page + 1} / {Math.ceil(total / limit)}</span>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={(page + 1) * limit >= total}
              className="px-3 py-1 rounded bg-white/[0.05] disabled:opacity-30"
            >Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Configuration panel (lazy) ───────────────────────────────────────────────────

function ConfigurationPanel({ equipment }: { equipment: Equipment }) {
  const { t } = useTranslation();
  // Auxiliary (utility) assets have no kiosk/MES layer — only maintenance-relevant
  // config (intervention types + safety checklist) applies to them.
  const isAux = equipment.asset_type === 'auxiliary';
  const visibleConfigTabs = isAux
    ? CONFIG_TABS.filter((c) => c.id === 'intervention_types' || c.id === 'safety_checklist')
    : CONFIG_TABS;

  const [machine, setMachine] = useState<Machine | null>(null);
  const [allMachines, setAllMachines] = useState<Machine[]>([]);
  const [searched, setSearched] = useState(false);
  const [configTab, setConfigTab] = useState<ConfigTab>(isAux ? 'intervention_types' : 'general');
  const [form, setForm] = useState<MachineConfigUpdate>({
    display_name:            equipment.name || '',
    page_language:           'fr',
    custom_color:            '',
    target_availability_pct: 70,
    target_count:            0,
    target_count_per_shift:  0,
    target_count_per_hour:   0,
    hourly_rate_currency:    'CAD',
    show_production_panel:   true,
    show_reject_panel:       true,
    show_availability_gauge: true,
    show_job_number:         true,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // The ref used for all /api/machines/:ref/... calls.
  // When a linked Machine is found by code match, use its slug/id.
  // Otherwise, fall back to the equipment UUID — the backend will
  // auto-provision a Machine record on first write.
  const machineRef = machine?.page_slug || machine?.id || equipment.id;
  const machineId  = machine?.id || equipment.id;

  useEffect(() => {
    fetchMachinesAll()
      .then((machines) => {
        setAllMachines(machines);
        // Match the kiosk by the authoritative FK link (equipment_id) — the same
        // link the factory map uses — falling back to code for legacy records.
        // (A kiosk's own code often differs from the equipment catalog code, e.g.
        // machine "S001" ↔ equipment "PARA-SAW-09", which broke the code-only match.)
        const found = machines.find((m) => m.equipment_id && m.equipment_id === equipment.id)
          || machines.find((m) => m.code && equipment.code && m.code === equipment.code);
        if (found) {
          setMachine(found);
          // Hourly target is the master goal. Legacy machines configured before it
          // existed only have per-shift/daily → back-derive an hourly value from
          // their shifts so the field isn't empty on first open.
          const sh = shiftHours(found.shifts_config);
          const avg = sh.count ? sh.total / sh.count : 8;
          const perHour = found.target_count_per_hour
            ?? (found.target_count_per_shift ? Math.round(found.target_count_per_shift / avg)
              : found.target_count ? Math.round(found.target_count / sh.total)
              : 0);
          setForm({
            display_name:            found.display_name || '',
            page_language:           found.page_language || 'fr',
            custom_color:            found.custom_color || '',
            target_availability_pct: found.target_availability_pct ?? 70,
            target_count:            found.target_count ?? 0,
            target_count_per_shift:  found.target_count_per_shift ?? 0,
            target_count_per_hour:   perHour,
            hourly_rate:             found.hourly_rate,
            hourly_rate_currency:    found.hourly_rate_currency ?? 'CAD',
            show_production_panel:   found.show_production_panel ?? true,
            show_reject_panel:       found.show_reject_panel ?? true,
            show_availability_gauge: found.show_availability_gauge ?? true,
            show_job_number:         found.show_job_number ?? true,
          });
        }
      })
      .catch(() => { /* ignore fetch errors — config works with defaults */ })
      .finally(() => setSearched(true));
  }, [equipment.code, equipment.id, equipment.name]);

  const set = <K extends keyof MachineConfigUpdate>(key: K, val: MachineConfigUpdate[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  const save = async () => {
    setSaving(true);
    await updateMachineConfig(machineId, form);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (!searched) {
    return (
      <div className="flex justify-center py-16">
        <div className="w-6 h-6 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
      </div>
    );
  }

  const showSave = configTab === 'general' || configTab === 'parameters';

  return (
    <div className="space-y-4">
      {/* Auxiliary assets: maintenance-only, no kiosk/MES */}
      {isAux ? (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-teal-500/20 bg-teal-500/5 text-sm">
          <Power size={15} className="text-teal-400 flex-shrink-0" />
          <span className="text-teal-300">
            Auxiliary (utility) asset — maintenance only. No kiosk page, stop/reject categories,
            operators or MES/OEE. Configure intervention types and the safety checklist used during work orders.
          </span>
        </div>
      ) : (
        /* MES integration info banner — shown when no linked machine */
        !machine && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-blue-500/20 bg-blue-500/5 text-sm">
            <Settings size={15} className="text-blue-400 flex-shrink-0" />
            <span className="text-blue-300">
              MES kiosk integration coming soon. Configuration is saved and will activate when a kiosk machine with code{' '}
              <span className="font-mono text-white">{equipment.code}</span> is linked.
            </span>
          </div>
        )
      )}

      {/* Config sub-tab header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 overflow-x-auto pb-1">
          {visibleConfigTabs.map(({ id, label, labelKey, Icon }) => (
            <button
              key={id}
              onClick={() => setConfigTab(id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all ${
                configTab === id
                  ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.04] border border-transparent'
              }`}
            >
              <Icon size={12} />
              {labelKey ? t(labelKey) : label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {machine?.page_slug && (
            <Link
              to={`/machines/${machine.page_slug}`}
              target="_blank"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white border border-white/10 hover:border-white/20 transition-all"
            >
              <ExternalLink size={12} /> Open kiosk
            </Link>
          )}
          {showSave && (
            <button onClick={save} disabled={saving}
              className={`flex items-center gap-1.5 py-1.5 px-4 rounded-lg font-bold text-xs transition-all ${saved ? 'bg-green-600' : 'bg-blue-600 hover:bg-blue-500'} text-white disabled:opacity-50`}>
              <Save size={12} />
              {saved ? 'Saved!' : saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>

      {/* Config sub-tab content */}
      <div className="max-w-3xl">
        {configTab === 'general' && (
          <div className="space-y-6">
            <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5 space-y-4">
              <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">Display</h2>
              <div>
                <label className="block text-sm text-gray-500 mb-1.5">Display Name (override)</label>
                <input type="text" value={form.display_name || ''} onChange={(e) => set('display_name', e.target.value)}
                  placeholder={machine?.name || equipment.name}
                  className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-sm text-gray-500 mb-1.5">Page Language</label>
                <div className="flex gap-2">
                  {LANG_OPTIONS.map((l) => (
                    <button key={l.value} type="button" onClick={() => set('page_language', l.value)}
                      className={`px-4 py-2 rounded-xl text-sm font-bold border transition-all ${form.page_language === l.value ? 'bg-blue-600 text-white border-blue-500' : 'bg-white/[0.04] text-gray-400 border-white/10 hover:border-white/20'}`}>
                      {l.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-500 mb-1.5">Accent Color</label>
                <div className="flex gap-2 items-center flex-wrap">
                  {COLOR_PRESETS.map((c) => (
                    <button key={c} type="button" onClick={() => set('custom_color', c)}
                      className="w-8 h-8 rounded-full border-2 transition-all"
                      style={{ backgroundColor: c, borderColor: form.custom_color === c ? 'white' : 'transparent' }} />
                  ))}
                  <input type="text" value={form.custom_color || ''} onChange={(e) => set('custom_color', e.target.value)}
                    placeholder="#3b82f6"
                    className="w-28 bg-[#0b1120] border border-white/10 rounded-xl px-3 py-1.5 text-white text-sm font-mono focus:outline-none focus:border-blue-500" />
                </div>
              </div>
            </div>
            <div className="bg-[#0d1421] rounded-2xl border border-red-500/20 p-5 space-y-3">
              <h2 className="text-sm font-bold text-red-400 uppercase tracking-widest">Danger Zone</h2>
              <p className="text-xs text-gray-600">Deleting the machine is not supported from here. Contact your system administrator.</p>
            </div>
          </div>
        )}
        {configTab === 'stop' && <StopCategoriesTab slug={machineRef} allMachines={allMachines} machineId={machineId} />}
        {configTab === 'reject' && <RejectCategoriesTab slug={machineRef} allMachines={allMachines} machineId={machineId} />}
        {configTab === 'operators' && <OperatorsTab machineRef={machineRef} />}
        {configTab === 'shifts' && <WorkShiftsTab machineId={machineId} savedConfig={machine?.shifts_config} />}
        {configTab === 'parameters' && <ParametersTab form={form} set={set} shiftsConfig={machine?.shifts_config} />}
        {configTab === 'indicators' && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <Activity size={40} className="text-gray-700 mb-4" />
            <p className="text-gray-600 text-sm">Indicators configuration — coming soon</p>
          </div>
        )}
        {configTab === 'intervention_types' && <InterventionTypesConfigTab equipmentId={equipment.id} />}
        {configTab === 'safety_checklist' && <SafetyChecklistConfigTab equipmentId={equipment.id} />}
        {configTab === 'cleaning_checklist' && <CleaningChecklistConfigTab equipmentId={equipment.id} slug={machineRef} />}
      </div>
    </div>
  );
}

// ─── Condition monitoring (Yokogawa Sushi Sensors) ─────────────────────────────────

const SUSHI_HEALTH_DOT: Record<string, string> = {
  online: 'text-green-400', stale: 'text-amber-400',
  offline: 'text-red-400', unknown: 'text-gray-500',
};

const METRIC_ORDER = ['vel', 'acc', 'temp', 'press'] as const;

// Chart palette — validated for the app's dark surface (#0d1421) with the
// dataviz six-checks script. Entity colors are fixed per axis (never cycled);
// status colors are reserved for threshold state and never used as a series.
const CHART = {
  base: '#3987e5',
  axis: { XYZ: '#3987e5', X: '#199e70', Y: '#c98500', Z: '#008300' } as Record<string, string>,
  warn: '#fab219',
  crit: '#d03b3b',
  ink: '#8b94a7',
  grid: 'rgba(148, 163, 184, 0.08)',
};

// Mini arc gauge for the chart-card readout: 180° track split into the alarm
// zones (ok/warn/crit at low opacity), a full-color progress arc up to the
// current value, and a dot marking it. Pure SVG — no chart runtime involved.
function ConditionGauge({ value, warn, crit, low }: {
  value: number;
  warn?: number | null;
  crit?: number | null;
  low?: number | null;
}) {
  const W = 64, H = 38, CX = 32, CY = 34, R = 26, SW = 6;
  const scale = crit != null ? crit * 1.25
    : warn != null ? warn * 1.5
    : Math.max(value * 1.4, 1);
  const frac = Math.min(1, Math.max(0.005, value / scale));

  const pt = (f: number) => {
    const a = Math.PI * (1 - f);               // 0 → left, 1 → right
    return { x: CX + R * Math.cos(a), y: CY - R * Math.sin(a) };
  };
  const arc = (f0: number, f1: number) => {
    const p0 = pt(f0), p1 = pt(f1);
    return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${R} ${R} 0 0 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
  };

  // Zone segments on the track (fractions of the scale).
  const zones: { f0: number; f1: number; color: string }[] = [];
  const wF = warn != null ? Math.min(1, warn / scale) : null;
  const cF = crit != null ? Math.min(1, crit / scale) : null;
  const lF = low != null ? Math.min(1, low / scale) : null;
  if (lF != null) zones.push({ f0: 0, f1: lF, color: CHART.warn });
  zones.push({ f0: lF ?? 0, f1: wF ?? cF ?? 1, color: CHART.base });
  if (wF != null) zones.push({ f0: wF, f1: cF ?? 1, color: CHART.warn });
  if (cF != null) zones.push({ f0: cF, f1: 1, color: CHART.crit });

  const zoneColor = (f: number) =>
    (cF != null && f >= cF) ? CHART.crit
    : (wF != null && f >= wF) ? CHART.warn
    : (lF != null && f <= lF) ? CHART.warn
    : CHART.base;
  const color = zoneColor(frac);
  const dot = pt(frac);

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" className="shrink-0">
      {zones.filter((z) => z.f1 - z.f0 > 0.001).map((z, i) => (
        <path key={i} d={arc(z.f0, z.f1)} stroke={z.color} strokeOpacity={0.22}
          strokeWidth={SW} fill="none" strokeLinecap="round" />
      ))}
      <path d={arc(0, frac)} stroke={color} strokeWidth={SW} fill="none" strokeLinecap="round" />
      <circle cx={dot.x} cy={dot.y} r={4.4} fill={color} stroke="#0d1421" strokeWidth={2} />
    </svg>
  );
}

function ConditionChart({ title, unit, series, warn, crit, low }: {
  title: string;
  unit: string;
  series: SushiSeries[];
  warn?: number | null;
  crit?: number | null;
  low?: number | null;
}) {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || 'en').slice(0, 2);
  const single = series.length === 1;

  // Threshold guides — dashed, labeled, recessive.
  const markLines: object[] = [];
  const mk = (y: number, color: string, text: string) => ({
    yAxis: y,
    lineStyle: { color, type: [4, 4], width: 1, opacity: 0.9 },
    label: { color, fontSize: 10, fontWeight: 600, formatter: text, position: 'insideEndTop' },
  });
  if (warn != null) markLines.push(mk(warn, CHART.warn, `${t('sushi.warn')} ${warn}`));
  if (crit != null) markLines.push(mk(crit, CHART.crit, `${t('sushi.crit')} ${crit}`));
  if (low != null) markLines.push(mk(low, CHART.warn, `${t('sushi.low')} ${low}`));

  // Status recoloring of the line as it enters the alarm bands (single series
  // only — with several axes, color stays with the entity).
  const pieces: object[] = [];
  if (single) {
    if (low != null) pieces.push({ max: low, color: CHART.warn });
    if (warn != null && crit != null) {
      pieces.push({ min: warn, max: crit, color: CHART.warn }, { min: crit, color: CHART.crit });
    } else if (warn != null) {
      pieces.push({ min: warn, color: CHART.warn });
    } else if (crit != null) {
      pieces.push({ min: crit, color: CHART.crit });
    }
  }

  const avgSeries = series.map((s, i) => {
    const color = CHART.axis[s.axis || 'XYZ'] ?? CHART.base;
    return {
      name: s.axis || title,
      type: 'line',
      z: 3,
      showSymbol: false,
      smooth: 0.25,
      lineStyle: { width: 2, ...(pieces.length ? {} : { color }) },
      itemStyle: { color },
      emphasis: { focus: 'none' },
      areaStyle: single ? {
        opacity: 1,
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(57, 135, 229, 0.16)' },
            { offset: 1, color: 'rgba(57, 135, 229, 0)' },
          ],
        },
      } : undefined,
      // dims 2/3 carry the bucket min/max for the tooltip
      data: s.points.map((p) => [p.t, Number(p.avg.toFixed(3)), Number(p.min.toFixed(3)), Number(p.max.toFixed(3))]),
      ...(i === 0 && markLines.length ? { markLine: { symbol: 'none', silent: true, animation: false, data: markLines } } : {}),
    };
  });

  // Min–max envelope behind the line (single series): base + delta stack.
  const bandSeries = single ? [
    {
      name: '__band-base',
      type: 'line', stack: '__band', z: 1, silent: true,
      showSymbol: false, lineStyle: { opacity: 0 }, emphasis: { disabled: true },
      data: series[0].points.map((p) => [p.t, Number(p.min.toFixed(3))]),
    },
    {
      name: '__band',
      type: 'line', stack: '__band', z: 1, silent: true,
      showSymbol: false, lineStyle: { opacity: 0 }, emphasis: { disabled: true },
      areaStyle: { color: CHART.base, opacity: 0.14 },
      data: series[0].points.map((p) => [p.t, Number((p.max - p.min).toFixed(3))]),
    },
  ] : [];

  const option = {
    backgroundColor: 'transparent',
    animationDuration: 500,
    animationEasing: 'cubicOut',
    grid: { left: 46, right: 14, top: single ? 20 : 30, bottom: 26 },
    ...(pieces.length ? {
      visualMap: {
        show: false, type: 'piecewise', dimension: 1,
        seriesIndex: bandSeries.length ? [2] : [0],
        pieces,
        outOfRange: { color: CHART.base },
      },
    } : {}),
    ...(single ? {} : {
      legend: {
        top: 0, right: 0, icon: 'roundRect',
        itemWidth: 10, itemHeight: 3, itemGap: 10,
        textStyle: { color: CHART.ink, fontSize: 10 },
      },
    }),
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(13, 20, 33, 0.95)',
      borderColor: 'rgba(255,255,255,0.08)',
      padding: [6, 10],
      textStyle: { color: '#e5e7eb', fontSize: 12 },
      axisPointer: {
        type: 'cross',
        lineStyle: { color: 'rgba(148,163,184,0.35)' },
        crossStyle: { color: 'rgba(148,163,184,0.35)' },
        label: { backgroundColor: '#1e293b', color: '#cbd5e1', fontSize: 10, borderRadius: 3 },
      },
      formatter: (ps: { seriesName: string; marker: string; value: [string, number, number?, number?] }[]) => {
        const rows = ps.filter((x) => !String(x.seriesName).startsWith('__'));
        if (!rows.length) return '';
        const d = new Date(rows[0].value[0]);
        const time = d.toLocaleString(lang, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        const body = rows.map((x) => {
          const [, avg, mn, mx] = x.value;
          const range = mn != null && mx != null && mx - mn > 0.005
            ? ` <span style="color:${CHART.ink};font-size:11px">${mn.toFixed(2)} – ${mx.toFixed(2)}</span>`
            : '';
          return `${x.marker} <b>${avg.toFixed(2)}</b> <span style="color:${CHART.ink}">${unit}</span>${range}`;
        }).join('<br/>');
        return `<div style="color:${CHART.ink};font-size:11px;margin-bottom:2px">${time}</div>${body}`;
      },
    },
    dataZoom: [{ type: 'inside', throttle: 50 }],
    xAxis: {
      type: 'time',
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: CHART.ink, fontSize: 10, hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      scale: true,
      splitNumber: 4,
      axisLabel: { color: CHART.ink, fontSize: 10 },
      splitLine: { lineStyle: { color: CHART.grid } },
    },
    series: [...bandSeries, ...avgSeries],
  };

  const latest = series.find((s) => s.latest)?.latest;
  const status = latest == null ? 'ok'
    : crit != null && latest.value >= crit ? 'critical'
    : warn != null && latest.value >= warn ? 'warning'
    : low != null && latest.value <= low ? 'warning'
    : 'ok';

  // Trend: latest vs ~1 h earlier (or the window start when shorter). For
  // vibration/temperature "up" is the bad direction; pressure is direction-neutral.
  const pts = series[0]?.points ?? [];
  let delta: number | null = null;
  if (latest && pts.length >= 2) {
    const cutoff = new Date(latest.timestamp).getTime() - 3600_000;
    const ref = [...pts].reverse().find((p) => new Date(p.t).getTime() <= cutoff) ?? pts[0];
    delta = latest.value - ref.avg;
  }
  const isPress = low != null;
  const deltaBad = delta != null && delta > 0 && !isPress;
  const deltaGood = delta != null && delta < 0 && !isPress;

  return (
    <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
      <div className="flex items-center justify-between mb-1.5 gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-300 truncate">{title}</h3>
          <div className="flex items-center gap-2 mt-1">
            {status !== 'ok' && (
              <span className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${
                status === 'critical'
                  ? 'bg-red-500/10 border-red-500/40 text-red-400 animate-pulse'
                  : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
              }`}>
                ▲ {t(`sushi.sev_${status}`)}
              </span>
            )}
            {delta != null && Math.abs(delta) >= 0.01 && (
              <span
                title={t('sushi.delta1h')}
                className={`inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums px-1.5 py-0.5 rounded-md bg-white/[0.04] ${
                  deltaBad ? 'text-rose-400' : deltaGood ? 'text-emerald-400' : 'text-gray-400'
                }`}
              >
                {delta > 0 ? '↗' : '↘'} {Math.abs(delta).toFixed(2)}
                <span className="text-gray-600 ml-0.5">/1h</span>
              </span>
            )}
          </div>
        </div>
        {latest && (
          <div className="flex items-center gap-2.5 shrink-0">
            <ConditionGauge value={latest.value} warn={warn} crit={crit} low={low} />
            <div className="text-right leading-none">
              <span className="text-[26px] font-bold text-white tabular-nums tracking-tight">
                {latest.value.toFixed(2)}
              </span>
              <span className="block text-[11px] text-gray-500 mt-1">{unit}</span>
            </div>
          </div>
        )}
      </div>
      <ReactECharts option={option} style={{ height: 235 }} notMerge />
    </div>
  );
}

function ConditionTab({ condition, hours, onHours }: {
  condition: SushiCondition;
  hours: number;
  onHours: (h: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || 'en').slice(0, 2);
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(lang) : '—');

  const metricSeries = (metric: string) => condition.series.filter((s) => s.metric === metric && s.points.length > 0);
  const th = condition.devices[0]?.thresholds;

  const metricCards = METRIC_ORDER
    .map((metric) => ({ metric, series: metricSeries(metric) }))
    .filter((x) => x.series.length > 0);

  return (
    <div className="space-y-4">
      {/* Device health cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {condition.devices.map((d) => (
          <div key={d.id} className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <SushiIcon size={15} />
                  <span className="text-sm font-semibold text-gray-200">{d.name}</span>
                  <span className={`inline-flex items-center gap-1 text-xs ${SUSHI_HEALTH_DOT[d.health]}`}>
                    ● {t(`devices.sushiHealth_${d.health}`)}
                  </span>
                </div>
                <p className="text-[11px] text-gray-600 font-mono mt-0.5">
                  {d.model.toUpperCase()} · {d.dev_eui}{d.tag_name ? ` · ${d.tag_name}` : ''}
                </p>
              </div>
              {d.namur && d.namur !== 'good' && (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-400">
                  {t(`devices.namur_${d.namur}`)}
                </span>
              )}
            </div>
            <div className="grid grid-cols-4 gap-2 mt-3 text-center">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-gray-600">{t('devices.sushiBattery')}</p>
                <p className={`text-sm font-semibold ${d.battery_pct != null && d.battery_pct < 10 ? 'text-red-400' : d.battery_pct != null && d.battery_pct < 20 ? 'text-amber-400' : 'text-gray-200'}`}>
                  {d.battery_pct != null ? `${Math.round(d.battery_pct)}%` : '—'}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-gray-600">RSSI / SNR</p>
                <p className="text-sm font-semibold text-gray-200">
                  {d.rssi_dbm != null ? Math.round(d.rssi_dbm) : '—'}<span className="text-[10px] text-gray-500"> dBm</span>
                  {d.snr_db != null ? ` ${d.snr_db.toFixed(1)}` : ''}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-gray-600">{t('sushi.period')}</p>
                <p className="text-sm font-semibold text-gray-200">{d.update_period_min} min</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-gray-600">{t('devices.sushiLastUplink')}</p>
                <p className="text-xs font-medium text-gray-300 mt-0.5">{fmt(d.last_uplink_at)}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Range selector */}
      <div className="flex items-center gap-1.5">
        {[6, 24, 168, 720].map((h) => (
          <button key={h} onClick={() => onHours(h)}
            className={`px-2.5 py-1 text-xs rounded-lg border transition-colors ${
              hours === h
                ? 'border-blue-500/40 bg-blue-500/10 text-blue-300'
                : 'border-white/[0.08] text-gray-500 hover:text-gray-300'
            }`}>
            {h === 6 ? t('sushi.range6h') : h === 24 ? t('sushi.range24h') : h === 168 ? t('sushi.range7d') : t('sushi.range30d')}
          </button>
        ))}
      </div>

      {/* Metric charts */}
      {metricCards.length === 0 ? (
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-8 text-center text-gray-600 text-sm">
          {t('sushi.noData')}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {metricCards.map(({ metric, series }) => (
            <ConditionChart
              key={metric}
              title={t(`sushi.metric_${metric}`)}
              unit={series[0].unit}
              series={series}
              warn={metric === 'vel' ? th?.vel_warn_mms : metric === 'acc' ? th?.acc_warn_ms2 : metric === 'temp' ? th?.temp_warn_c : th?.press_max_mpa}
              crit={metric === 'vel' ? th?.vel_crit_mms : metric === 'acc' ? th?.acc_crit_ms2 : metric === 'temp' ? th?.temp_crit_c : null}
              low={metric === 'press' ? th?.press_min_mpa : null}
            />
          ))}
        </div>
      )}

      {/* Recent condition alerts */}
      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">{t('sushi.recentAlerts')}</h3>
        {condition.alerts.length === 0 ? (
          <p className="text-gray-600 text-sm">{t('sushi.noAlerts')}</p>
        ) : (
          <div className="space-y-2">
            {condition.alerts.map((a) => (
              <div key={a.id} className="flex items-center gap-3 text-sm">
                <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full ${
                  a.severity === 'critical' ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-400'
                }`}>
                  {t(`sushi.sev_${a.severity}`, a.severity)}
                </span>
                <span className="text-gray-300 flex-1 truncate">{a.message}</span>
                <span className="text-xs text-gray-600 whitespace-nowrap">{fmt(a.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────────

export default function EquipmentDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  // Restore the list's type tab (e.g. /equipment?type=production) when we came from it.
  const stateBackTo = (location.state as { backTo?: unknown } | null)?.backTo;
  const backTo = typeof stateBackTo === 'string' && stateBackTo.startsWith('/equipment') ? stateBackTo : '/equipment';
  const [tab, setTab] = useState<TabId>('overview');
  const [equipment, setEquipment] = useState<Equipment | null>(null);
  const [wos, setWOs] = useState<WorkOrder[]>([]);
  const [plans, setPlans] = useState<MaintenancePlan[]>([]);
  const [loading, setLoading] = useState(true);
  // Cost centers usable as the machine's default (same list the WO-approval picker
  // uses, so the stored name always matches an approval option).
  const [costCenters, setCostCenters] = useState<{ name: string; code: string | null }[]>([]);
  // The plant's managed departments — the field picks from this list, not free text.
  const [departments, setDepartments] = useState<{ name: string }[]>([]);
  // Sushi Sensor condition monitoring — the tab only exists when the asset has devices.
  const [condition, setCondition] = useState<SushiCondition | null>(null);
  const [condHours, setCondHours] = useState(24);

  useEffect(() => {
    if (!id) return;
    Promise.allSettled([
      fetchEquipmentById(id),
      fetchWorkOrders({ equipment_id: id, limit: '50' }),
      fetchMaintenancePlans({ equipment_id: id }),
      fetchEquipmentCondition(id, 24),
    ]).then(([eq, wo, pl, cond]) => {
      if (eq.status === 'fulfilled') setEquipment(eq.value);
      if (wo.status === 'fulfilled') setWOs(wo.value);
      if (pl.status === 'fulfilled') setPlans(pl.value.items);
      if (cond.status === 'fulfilled') setCondition(cond.value);
      setLoading(false);
    });
  }, [id]);

  const changeCondHours = useCallback((h: number) => {
    setCondHours(h);
    if (id) fetchEquipmentCondition(id, h).then(setCondition).catch(() => {});
  }, [id]);

  useEffect(() => {
    api.get<{ name: string; code: string | null }[]>('/api/wo-approval/cost-centers')
      .then(({ data }) => setCostCenters(data))
      .catch(() => {});
    fetchDepartments().then(setDepartments).catch(() => {});
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500 text-sm">
        {t('common.loading')}
      </div>
    );
  }

  if (!equipment) {
    return (
      <div className="p-6 text-center text-gray-500">
        {t('equipment.notFound')}
      </div>
    );
  }

  const isAux = equipment.asset_type === 'auxiliary';

  // Auxiliary (utility) assets have no kiosk/MES layer → no operator-intervention history tab.
  const hasCondition = (condition?.devices.length ?? 0) > 0;

  const tabs: { id: TabId; label: string }[] = [
    { id: 'overview',       label: t('equipment.tabOverview') },
    ...(hasCondition ? [{ id: 'condition' as TabId, label: t('equipment.tabCondition') }] : []),
    { id: 'workorders',     label: `${t('equipment.tabWorkOrders')} (${wos.length})` },
    { id: 'plans',          label: `${t('equipment.tabPlans')} (${plans.length})` },
    ...(isAux ? [] : [{ id: 'history' as TabId, label: 'Historique' }]),
    { id: 'configuration',  label: 'Configuration' },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Back + Header */}
      <div>
        <button
          onClick={() => navigate(backTo)}
          className="flex items-center gap-1.5 text-gray-500 hover:text-gray-300 text-sm mb-4 transition-colors"
        >
          <ArrowLeft size={15} />
          {t('equipment.title')}
        </button>

        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${isAux ? 'bg-teal-500/10' : 'bg-blue-500/10'}`}>
              {isAux ? <Power size={24} className="text-teal-400" /> : <Cpu size={24} className="text-blue-400" />}
            </div>
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl font-bold text-white">{equipment.name}</h1>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${STATUS_COLORS[equipment.status] ?? STATUS_COLORS.stopped}`}>
                  {equipment.status.replace('_', ' ')}
                </span>
                {isAux && (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full border border-teal-500/20 bg-teal-500/10 text-teal-400">
                    {equipment.subtype || t('equipment.filterAuxiliary', 'Auxiliary')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-4 mt-1">
                <span className="text-gray-500 text-sm font-mono">{equipment.code}</span>
                {equipment.location && (
                  <div className="flex items-center gap-1 text-gray-500 text-sm">
                    <MapPin size={13} />
                    {equipment.location}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="text-right">
            <div className="flex items-center gap-1.5 text-gray-400">
              <Gauge size={15} />
              <span className="text-sm">{t('equipment.hourMeter')}</span>
            </div>
            <p className="text-2xl font-bold text-white mt-0.5">
              {equipment.hour_meter.toLocaleString()}
              <span className="text-sm font-normal text-gray-500 ml-1">h</span>
            </p>
          </div>
        </div>
      </div>

      {/* Main tabs */}
      <div className="border-b border-white/[0.06]">
        <div className="flex gap-0">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              onClick={() => setTab(tb.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                tab === tb.id
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              {tb.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {tab === 'condition' && condition && (
        <ConditionTab condition={condition} hours={condHours} onHours={changeCondHours} />
      )}

      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-300">{t('equipment.specifications')}</h3>
            <EditableSpecRow
              label={t('equipment.name', 'Name')}
              value={equipment.name}
              equipmentId={equipment.id}
              field="name"
              placeholder="Machine name"
              onSaved={(v) => setEquipment((prev) => (prev ? { ...prev, name: v } : prev))}
            />
            <EditableSpecRow
              label={t('equipment.functionLabel', 'Function')}
              value={equipment.function_label}
              equipmentId={equipment.id}
              field="function_label"
              placeholder="e.g. CNC grooving machine"
              onSaved={(v) => setEquipment((prev) => (prev ? { ...prev, function_label: v } : prev))}
            />
            <EditableSpecRow
              label={t('equipment.code', 'Code')}
              value={equipment.code}
              equipmentId={equipment.id}
              field="code"
              placeholder="e.g. MILL-GRO-01"
              onSaved={(v) => setEquipment((prev) => (prev ? { ...prev, code: v } : prev))}
            />
            <EditableSpecRow
              label={t('equipment.equipmentType', 'Type')}
              value={equipment.asset_type}
              equipmentId={equipment.id}
              field="asset_type"
              type="select"
              options={[
                { value: 'production', label: t('equipment.filterProduction', 'Production') },
                { value: 'auxiliary', label: t('equipment.filterAuxiliary', 'Auxiliary') },
              ]}
              onSaved={(v) => setEquipment((prev) => (prev ? { ...prev, asset_type: v as 'production' | 'auxiliary' } : prev))}
            />
            <EditableSpecRow
              label={t('equipment.colSubtype', 'Subtype')}
              value={equipment.subtype}
              equipmentId={equipment.id}
              field="subtype"
              placeholder="e.g. Conveyor, HVAC, Sewing machine"
              onSaved={(v) => setEquipment((prev) => (prev ? { ...prev, subtype: v } : prev))}
            />
            <EditableSpecRow
              label={t('equipment.manufacturer')}
              value={equipment.manufacturer}
              equipmentId={equipment.id}
              field="manufacturer"
              placeholder="e.g. SCHELLING"
              onSaved={(v) => setEquipment((prev) => (prev ? { ...prev, manufacturer: v } : prev))}
            />
            <EditableSpecRow
              label={t('equipment.model')}
              value={equipment.model}
              equipmentId={equipment.id}
              field="model"
              placeholder="e.g. FH6"
              onSaved={(v) => setEquipment((prev) => (prev ? { ...prev, model: v } : prev))}
            />
            <EditableSpecRow
              label={t('equipment.serialNumber')}
              value={equipment.serial_number}
              equipmentId={equipment.id}
              field="serial_number"
              placeholder="e.g. SN-2024-00123"
              onSaved={(v) => setEquipment((prev) => (prev ? { ...prev, serial_number: v } : prev))}
            />
            <EditableSpecRow
              label={t('equipment.year')}
              value={equipment.manufacturing_year?.toString()}
              equipmentId={equipment.id}
              field="manufacturing_year"
              type="number"
              placeholder="e.g. 2021"
              onSaved={(v) => setEquipment((prev) => (prev ? { ...prev, manufacturing_year: v ? Number(v) : undefined } : prev))}
            />
            <EditableSpecRow
              label={t('equipment.criticality')}
              value={equipment.criticality}
              equipmentId={equipment.id}
              field="criticality"
              type="select"
              options={['low', 'medium', 'high', 'critical'].map((c) => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) }))}
              onSaved={(v) => setEquipment((prev) => (prev ? { ...prev, criticality: v } : prev))}
            />
            <EditableSpecRow
              label={t('equipment.department', 'Department')}
              value={equipment.department}
              equipmentId={equipment.id}
              field="department"
              type="select"
              options={[
                { value: '', label: '—' },
                ...departments.map((d) => ({ value: d.name, label: d.name })),
                ...(equipment.department && !departments.some((d) => d.name === equipment.department)
                  ? [{ value: equipment.department, label: `${equipment.department} (⚠)` }] : []),
              ]}
              onSaved={(v) => setEquipment((prev) => (prev ? { ...prev, department: v } : prev))}
            />
            <EditableSpecRow
              label={t('equipment.costCenter', 'Cost center')}
              value={equipment.cost_center}
              equipmentId={equipment.id}
              field="cost_center"
              type="select"
              options={[
                { value: '', label: '—' },
                ...costCenters.map((cc) => ({
                  value: cc.name,
                  label: cc.code ? `${cc.code} · ${cc.name}` : cc.name,
                })),
              ]}
              onSaved={(v) => setEquipment((prev) => (prev ? { ...prev, cost_center: v } : prev))}
            />
            <EditableSpecRow
              label={t('equipment.family', 'Family')}
              value={equipment.family}
              equipmentId={equipment.id}
              field="family"
              placeholder="e.g. Edgebander"
              onSaved={(v) => setEquipment((prev) => (prev ? { ...prev, family: v } : prev))}
            />
            <EditableSpecRow
              label={t('equipment.pmStrategy', 'PM strategy')}
              value={equipment.pm_strategy}
              equipmentId={equipment.id}
              field="pm_strategy"
              placeholder="e.g. Préventif calendrier + inspection"
              onSaved={(v) => setEquipment((prev) => (prev ? { ...prev, pm_strategy: v } : prev))}
            />
            <EditableSpecRow
              label={t('equipment.cleaningPriority', 'Cleaning priority')}
              value={equipment.cleaning_priority}
              equipmentId={equipment.id}
              field="cleaning_priority"
              type="select"
              options={[
                { value: '', label: '—' },
                { value: 'Basse', label: 'Basse' },
                { value: 'Moyenne', label: 'Moyenne' },
                { value: 'Haute', label: 'Haute' },
              ]}
              onSaved={(v) => setEquipment((prev) => (prev ? { ...prev, cleaning_priority: v } : prev))}
            />
            {equipment.asset_type === 'auxiliary' && (
              <ParentMachineRow
                equipmentId={equipment.id}
                currentParentId={equipment.parent_equipment_id ?? null}
                onSaved={(pid) => setEquipment((prev) => (prev ? { ...prev, parent_equipment_id: pid } : prev))}
              />
            )}
            <EditableSpecRow
              label={t('equipment.height3d', '3D height')}
              value={equipment.height_3d != null ? String(equipment.height_3d) : undefined}
              equipmentId={equipment.id}
              field="height_3d"
              type="number"
              placeholder="e.g. 4.5"
              onSaved={(v) => setEquipment((prev) => (prev ? { ...prev, height_3d: v ? Number(v) : null } : prev))}
            />
            <ModelUploadRow equipment={equipment} onSaved={(url) => setEquipment((prev) => (prev ? { ...prev, model_url: url } : prev))} />
            {equipment.description && (
              <div className="pt-2 border-t border-white/[0.04]">
                <p className="text-xs text-gray-600 mb-1">{t('common.description')}</p>
                <p className="text-sm text-gray-300">{equipment.description}</p>
              </div>
            )}
          </div>
          <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
            <h3 className="text-sm font-semibold text-gray-300 mb-3">{t('equipment.stats')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <StatCard label={t('equipment.totalWOs')} value={String(wos.length)} icon={<AlertCircle size={16} className="text-blue-400" />} />
              <StatCard label={t('equipment.openWOs')} value={String(wos.filter((w) => w.status === 'open' || w.status === 'in_progress').length)} icon={<Clock size={16} className="text-amber-400" />} />
              <StatCard label={t('equipment.activePlans')} value={String(plans.length)} icon={<Calendar size={16} className="text-green-400" />} />
              <StatCard label={t('equipment.avgRepair')} value={humanHours(wos.filter((w) => w.repair_hours).reduce((a, w) => a + (w.repair_hours ?? 0), 0) / Math.max(wos.filter((w) => w.repair_hours).length, 1))} icon={<Gauge size={16} className="text-purple-400" />} />
            </div>
          </div>
        </div>
      )}

      {tab === 'workorders' && (
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl overflow-hidden">
          {wos.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-gray-600 text-sm">
              {t('workOrders.noResults')}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  <th className="text-left text-xs text-gray-600 font-medium px-4 py-3">{t('workOrders.woNumber')}</th>
                  <th className="text-left text-xs text-gray-600 font-medium px-4 py-3">{t('workOrders.titleField')}</th>
                  <th className="text-left text-xs text-gray-600 font-medium px-4 py-3">{t('common.type')}</th>
                  <th className="text-left text-xs text-gray-600 font-medium px-4 py-3">{t('common.priority')}</th>
                  <th className="text-left text-xs text-gray-600 font-medium px-4 py-3">{t('common.status')}</th>
                  <th className="text-left text-xs text-gray-600 font-medium px-4 py-3">{t('workOrders.openedAt')}</th>
                </tr>
              </thead>
              <tbody>
                {wos.map((wo) => (
                  <tr key={wo.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <Link to={`/work-orders/${wo.id}`} className="text-blue-400 hover:text-blue-300 font-mono text-xs">
                        {wo.wo_number}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-gray-300 max-w-xs truncate">{wo.title}</td>
                    <td className="px-4 py-3 text-gray-400 capitalize">{wo.type}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium capitalize ${PRIORITY_COLORS[wo.priority] ?? 'text-gray-400'}`}>
                        {wo.priority}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${WO_STATUS_COLORS[wo.status] ?? 'text-gray-400'}`}>
                        {wo.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {format(new Date(wo.opened_at), 'MMM dd, yyyy')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'plans' && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Link to={`/maintenance/plans/new?equipmentId=${equipment.id}`} className="btn-primary py-1.5 px-3 text-sm gap-1.5">
              <Plus size={14} />
              {t('pm.newPlan')}
            </Link>
          </div>
          {plans.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-gray-600 text-sm bg-[#0d1421] border border-white/[0.06] rounded-xl">
              {t('equipment.noPlans')}
            </div>
          ) : (
            plans.map((plan) => {
              const freqLabel = plan.frequency_type
                ? ((plan.frequency_value ?? 1) > 1
                    ? `${t('pm.every')} ${plan.frequency_value} ${t(`pmFrequency.unit.${plan.frequency_type}`)}`
                    : t(`pmFrequency.${plan.frequency_type}`))
                : null;
              return (
                <Link key={plan.id} to={`/maintenance/plans/${plan.id}`} className="block bg-[#0d1421] border border-white/[0.06] rounded-xl p-4 hover:border-white/20 transition-colors">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-white font-medium text-sm">{plan.name}</p>
                        {!plan.is_active && (
                          <span className="text-xs px-1.5 py-0.5 rounded-full bg-gray-500/15 text-gray-500">{t('pm.inactive')}</span>
                        )}
                      </div>
                      {plan.description && <p className="text-gray-500 text-xs mt-0.5">{plan.description}</p>}
                      <div className="flex items-center gap-3 mt-2 text-xs text-gray-600">
                        {freqLabel && <span>{freqLabel}</span>}
                        {plan.assigned_technician_name && <span>{plan.assigned_technician_name}</span>}
                      </div>
                    </div>
                    {plan.next_due_date && (
                      <div className="text-right">
                        <p className="text-xs text-gray-600">{t('pm.nextDue')}</p>
                        <p className="text-sm text-amber-400 font-medium">{plan.next_due_date}</p>
                      </div>
                    )}
                  </div>
                </Link>
              );
            })
          )}

          {/* Reusable PM procedures (templates) — illustrated step-by-step (photos/videos) */}
          <div className="pt-5 mt-3 border-t border-white/[0.06]">
            <PmTemplatesConfigTab equipmentId={equipment.id} />
          </div>
        </div>
      )}

      {tab === 'history' && <HistoryTab equipment={equipment} />}

      {tab === 'configuration' && <ConfigurationPanel equipment={equipment} />}
    </div>
  );
}

/** Spec row whose value can be edited inline and saved via PATCH /api/equipment/{id}.
 *  Supports free text, numbers and a fixed set of options (select). */
/** Upload / replace a 3D model (.glb) for the equipment, saved to model_url. */
function ModelUploadRow({ equipment, onSaved }: { equipment: Equipment; onSaved: (url: string | null) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const onFile = async (f: File) => {
    setBusy(true); setErr('');
    try {
      const up = await uploadFile(f);
      await api.patch(`/api/equipment/${equipment.id}`, { model_url: up.url });
      onSaved(up.url);
    } catch (e) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setErr(msg ?? 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await api.patch(`/api/equipment/${equipment.id}`, { model_url: null });
    onSaved(null);
  };

  return (
    <div className="flex items-center justify-between gap-2 py-1.5 border-b border-white/[0.03] last:border-0">
      <span className="text-xs text-gray-600 flex-shrink-0">3D model</span>
      <div className="flex items-center gap-2">
        {err ? <span className="text-xs text-red-400">{err}</span>
          : equipment.model_url ? <span className="text-xs text-green-400">✓ uploaded</span>
          : <span className="text-xs text-gray-500">—</span>}
        <button onClick={() => fileRef.current?.click()} disabled={busy}
          className="text-xs text-blue-400 hover:text-blue-300 border border-blue-500/30 rounded px-2 py-0.5 disabled:opacity-50">
          {busy ? 'Uploading…' : (equipment.model_url ? 'Replace .glb' : 'Upload .glb')}
        </button>
        {equipment.model_url && (
          <button onClick={remove} className="text-xs text-gray-500 hover:text-red-400">Remove</button>
        )}
        <input ref={fileRef} type="file" accept=".glb,.gltf" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      </div>
    </div>
  );
}

function EditableSpecRow({
  label, value, equipmentId, field, onSaved, placeholder, type = 'text', options,
}: {
  label: string;
  value?: string | null;
  equipmentId: string;
  field: string;
  onSaved: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'number' | 'select';
  options?: { value: string; label: string }[];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const raw = draft.trim();
      // numbers go as int|null, everything else as the trimmed string
      const payloadVal: string | number | null =
        type === 'number' ? (raw === '' ? null : Number(raw)) : raw;
      await api.patch(`/api/equipment/${equipmentId}`, { [field]: payloadVal });
      onSaved(raw);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => { setDraft(value ?? ''); setEditing(false); };
  const startEdit = () => { setDraft(value ?? ''); setEditing(true); };

  const editorCls =
    'bg-[#0b1120] border border-white/[0.1] rounded px-2 py-1 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 disabled:opacity-50';

  return (
    <div className="flex items-center justify-between gap-2 py-1.5 border-b border-white/[0.03] last:border-0">
      <span className="text-xs text-gray-600 flex-shrink-0">{label}</span>
      {editing ? (
        <div className="flex items-center gap-1.5">
          {type === 'select' ? (
            <select
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') cancel(); }}
              disabled={saving}
              className={`w-44 ${editorCls}`}
            >
              {(options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <input
              autoFocus
              type={type === 'number' ? 'number' : 'text'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
              placeholder={placeholder}
              disabled={saving}
              className={`w-44 ${editorCls}`}
            />
          )}
          <button onClick={save} disabled={saving} className="text-green-400 hover:text-green-300 p-0.5 disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={14} />}
          </button>
          <button onClick={cancel} disabled={saving} className="text-gray-500 hover:text-red-400 p-0.5 disabled:opacity-50">
            <X size={14} />
          </button>
        </div>
      ) : (
        <button onClick={startEdit} className="group flex items-center gap-1.5 text-sm text-gray-300 hover:text-white">
          <span>{value || '—'}</span>
          <Pencil size={11} className="text-gray-600 group-hover:text-blue-400" />
        </button>
      )}
    </div>
  );
}

/** Shows / edits the parent machine a cobot or conveyor serves (saved as parent_equipment_id). */
function ParentMachineRow({ equipmentId, currentParentId, onSaved }: {
  equipmentId: string;
  currentParentId: string | null;
  onSaved: (parentId: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentParentId ?? '');
  const [saving, setSaving] = useState(false);
  const [machines, setMachines] = useState<Equipment[]>([]);
  // Parents are production machines (orbit hosts). Fetch only those: ~dozens, and it keeps us
  // under the endpoint's limit cap (le=200) — requesting all equipment (>200) 422s and the list
  // silently came back empty.
  useEffect(() => { fetchEquipment({ asset_type: 'production', limit: '200' }).then(setMachines).catch(() => {}); }, []);
  const parentName = machines.find((m) => m.id === currentParentId)?.name ?? null;
  const options = machines
    .filter((m) => m.id !== equipmentId && (m.subtype ?? '').toLowerCase() !== 'cobot' && (m.subtype ?? '').toLowerCase() !== 'conveyor')
    .sort((a, b) => a.name.localeCompare(b.name));

  const save = async () => {
    setSaving(true);
    try {
      await saveMachineLayout(equipmentId, { parent_equipment_id: draft || null });
      onSaved(draft || null);
      setEditing(false);
    } finally { setSaving(false); }
  };
  const editorCls = 'bg-[#0b1120] border border-white/[0.1] rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-blue-500 disabled:opacity-50';

  return (
    <div className="flex items-center justify-between gap-2 py-1.5 border-b border-white/[0.03] last:border-0">
      <span className="text-xs text-gray-600 flex-shrink-0">Parent machine</span>
      {editing ? (
        <div className="flex items-center gap-1.5">
          <select autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} disabled={saving} className={`w-44 ${editorCls}`}>
            <option value="">— none —</option>
            {options.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <button onClick={save} disabled={saving} className="text-green-400 hover:text-green-300 p-0.5 disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={14} />}
          </button>
          <button onClick={() => { setDraft(currentParentId ?? ''); setEditing(false); }} disabled={saving} className="text-gray-500 hover:text-red-400 p-0.5 disabled:opacity-50">
            <X size={14} />
          </button>
        </div>
      ) : (
        <button onClick={() => { setDraft(currentParentId ?? ''); setEditing(true); }} className="group flex items-center gap-1.5 text-sm text-gray-300 hover:text-white">
          <span>{parentName || '—'}</span>
          <Pencil size={11} className="text-gray-600 group-hover:text-blue-400" />
        </button>
      )}
    </div>
  );
}

function StatCard({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="bg-white/[0.02] rounded-lg p-3">
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <span className="text-xs text-gray-600">{label}</span>
      </div>
      <p className="text-lg font-bold text-white">{value}</p>
    </div>
  );
}
