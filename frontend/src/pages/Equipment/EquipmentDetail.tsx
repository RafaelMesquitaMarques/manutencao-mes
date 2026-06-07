import { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, Cpu, MapPin, Clock, Gauge, AlertCircle, Calendar,
  Save, Plus, Trash2, Check, X, Copy, ChevronRight, ExternalLink,
  Settings, StopCircle, AlertTriangle, Users, BarChart2, Activity,
  type LucideIcon,
} from 'lucide-react';
import { fetchEquipmentById, fetchWorkOrders, fetchMaintenancePlans } from '../../api/workOrders';
import {
  fetchMachinesAll, updateMachineConfig,
  addMachineOperator, updateMachineOperatorRecord, deleteOperator,
  fetchMachineStopCategories, createMachineStopCategory, deleteMachineStopCategory,
  addStopSubcategory, deleteStopSubcategory,
  fetchMachineRejectCategories, createMachineRejectCategory, deleteMachineRejectCategory,
  addRejectSubcategory, deleteRejectSubcategory,
  cloneCategories,
} from '../../api/machines';
import api from '../../api/axios';
import type {
  Equipment, WorkOrder, MaintenancePlan,
  Machine, MachineConfigUpdate, MachineOperatorOut, MachineOperatorCreate,
  OperatorShift, StopCategoryOut, StopSubcategoryOut, StopCategoryType,
  RejectCategoryOut, RejectSubcategoryOut, HourlyRateCurrency,
} from '../../types';
import { format } from 'date-fns';
import { IconRenderer, IconPicker } from '../../components/ui/IconLibrary';

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

type TabId = 'overview' | 'workorders' | 'plans' | 'configuration';

// ─── Config sub-tab types ────────────────────────────────────────────────────────

type ConfigTab = 'general' | 'stop' | 'reject' | 'operators' | 'shifts' | 'parameters' | 'indicators';

const CONFIG_TABS: { id: ConfigTab; label: string; Icon: LucideIcon }[] = [
  { id: 'general',    label: 'General',          Icon: Settings     },
  { id: 'stop',       label: 'Stop Categories',  Icon: StopCircle   },
  { id: 'reject',     label: 'Reject Categories',Icon: AlertTriangle },
  { id: 'operators',  label: 'Operators',        Icon: Users        },
  { id: 'shifts',     label: 'Work Shifts',      Icon: Clock        },
  { id: 'parameters', label: 'Parameters',       Icon: BarChart2    },
  { id: 'indicators', label: 'Indicators',       Icon: Activity     },
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

function CloneModal({ machines, sourceMachineId, categoryType, onClose }: {
  machines: Machine[]; sourceMachineId: string; categoryType: 'stop' | 'reject'; onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const targets = machines.filter((m) => m.id !== sourceMachineId);
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-[#0d1421] border border-white/10 rounded-2xl p-6 w-full max-w-md space-y-4">
        <h2 className="text-base font-black text-white">Clone {categoryType} categories to…</h2>
        <p className="text-xs text-gray-500">Existing categories on target machines will be replaced.</p>
        <div className="space-y-2 max-h-60 overflow-y-auto">
          {targets.map((m) => (
            <label key={m.id} className="flex items-center gap-3 cursor-pointer p-3 rounded-xl hover:bg-white/[0.04]">
              <input type="checkbox" checked={selected.includes(m.id)} onChange={() => toggle(m.id)} className="accent-blue-500 w-4 h-4" />
              <span className="text-sm text-white">{m.display_name || m.name}</span>
            </label>
          ))}
        </div>
        <div className="flex gap-2">
          <button onClick={run} disabled={busy || !selected.length}
            className={`flex-1 py-2.5 rounded-xl text-sm font-black transition-all ${done ? 'bg-green-600' : 'bg-blue-600 hover:bg-blue-500'} text-white disabled:opacity-50`}>
            {done ? 'Cloned!' : busy ? 'Cloning…' : `Clone to ${selected.length} machine${selected.length !== 1 ? 's' : ''}`}
          </button>
          <button onClick={onClose} className="px-4 py-2.5 rounded-xl text-sm text-gray-400 border border-white/10 hover:border-white/20">Cancel</button>
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
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => { setCats(await fetchMachineStopCategories(slug)); }, [slug]);
  useEffect(() => { load(); }, [load]);

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
    await deleteMachineStopCategory(slug, id);
    if (selected?.id === id) setSelected(null);
    await load();
  };

  const addSub = async () => {
    if (!selected || !addSubForm.name.trim()) return;
    setBusy(true);
    await addStopSubcategory(slug, selected.id, addSubForm);
    setAddSubForm({ name: '', icon: 'wrench', color: '#6b7280', comment_required: false, triggers_maintenance: false });
    setShowAddSub(false);
    const refreshed = await fetchMachineStopCategories(slug);
    setCats(refreshed);
    setSelected(refreshed.find((c) => c.id === selected.id) ?? null);
    setBusy(false);
  };

  const delSub = async (subId: string) => {
    if (!selected) return;
    await deleteStopSubcategory(slug, subId);
    const refreshed = await fetchMachineStopCategories(slug);
    setCats(refreshed);
    setSelected(refreshed.find((c) => c.id === selected.id) ?? null);
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
              <div key={sub.id} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-white/[0.03]">
                <IconRenderer icon={sub.icon} color={sub.color || '#6b7280'} size={16} />
                <span className="flex-1 text-sm text-gray-300">{sub.name}</span>
                {sub.triggers_maintenance && <span className="text-xs text-orange-400 bg-orange-400/10 px-2 py-0.5 rounded-full">🔧 maint.</span>}
                <button onClick={() => delSub(sub.id)} className="p-1 rounded-lg text-gray-700 hover:text-red-400 hover:bg-red-400/10 transition-colors"><Trash2 size={11} /></button>
              </div>
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
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => { setCats(await fetchMachineRejectCategories(slug)); }, [slug]);
  useEffect(() => { load(); }, [load]);

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
    await deleteMachineRejectCategory(slug, id);
    if (selected?.id === id) setSelected(null);
    await load();
  };

  const addSub = async () => {
    if (!selected || !addSubForm.name.trim()) return;
    setBusy(true);
    await addRejectSubcategory(slug, selected.id, addSubForm);
    setAddSubForm({ name: '', icon: 'quality', color: '#6b7280', comment_required: false });
    setShowAddSub(false);
    const refreshed = await fetchMachineRejectCategories(slug);
    setCats(refreshed);
    setSelected(refreshed.find((c) => c.id === selected.id) ?? null);
    setBusy(false);
  };

  const delSub = async (subId: string) => {
    if (!selected) return;
    await deleteRejectSubcategory(slug, subId);
    const refreshed = await fetchMachineRejectCategories(slug);
    setCats(refreshed);
    setSelected(refreshed.find((c) => c.id === selected.id) ?? null);
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
              <div key={sub.id} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-white/[0.03]">
                <IconRenderer icon={sub.icon || 'quality'} color={sub.color || '#6b7280'} size={16} />
                <span className="flex-1 text-sm text-gray-300">{sub.name}</span>
                <button onClick={() => delSub(sub.id)} className="p-1 rounded-lg text-gray-700 hover:text-red-400 hover:bg-red-400/10 transition-colors"><Trash2 size={11} /></button>
              </div>
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

function ParametersTab({ form, set }: {
  form: MachineConfigUpdate;
  set: <K extends keyof MachineConfigUpdate>(k: K, v: MachineConfigUpdate[K]) => void;
}) {
  return (
    <div className="space-y-6">
      <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5 space-y-4">
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">Targets</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-500 mb-1.5">Target Availability (%)</label>
            <input type="number" min={0} max={100} value={form.target_availability_pct ?? 70}
              onChange={(e) => set('target_availability_pct', Number(e.target.value))}
              className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="block text-sm text-gray-500 mb-1.5">Daily Production Target</label>
            <input type="number" min={0} value={form.target_count ?? 0}
              onChange={(e) => set('target_count', Number(e.target.value))}
              className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="block text-sm text-gray-500 mb-1.5">Per-Shift Target</label>
            <input type="number" min={0} value={form.target_count_per_shift ?? 0}
              onChange={(e) => set('target_count_per_shift', Number(e.target.value))}
              className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-blue-500" />
          </div>
        </div>
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

// ─── Configuration panel (lazy) ───────────────────────────────────────────────────

function ConfigurationPanel({ equipment }: { equipment: Equipment }) {
  const [machine, setMachine] = useState<Machine | null>(null);
  const [allMachines, setAllMachines] = useState<Machine[]>([]);
  const [searched, setSearched] = useState(false);
  const [configTab, setConfigTab] = useState<ConfigTab>('general');
  const [form, setForm] = useState<MachineConfigUpdate>({
    display_name:            equipment.name || '',
    page_language:           'fr',
    custom_color:            '',
    target_availability_pct: 70,
    target_count:            0,
    target_count_per_shift:  0,
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
    fetchMachinesAll().then((machines) => {
      setAllMachines(machines);
      const found = machines.find((m) => m.code && equipment.code && m.code === equipment.code);
      if (found) {
        setMachine(found);
        setForm({
          display_name:            found.display_name || '',
          page_language:           found.page_language || 'fr',
          custom_color:            found.custom_color || '',
          target_availability_pct: found.target_availability_pct ?? 70,
          target_count:            found.target_count ?? 0,
          target_count_per_shift:  found.target_count_per_shift ?? 0,
          hourly_rate:             found.hourly_rate,
          hourly_rate_currency:    found.hourly_rate_currency ?? 'CAD',
          show_production_panel:   found.show_production_panel ?? true,
          show_reject_panel:       found.show_reject_panel ?? true,
          show_availability_gauge: found.show_availability_gauge ?? true,
          show_job_number:         found.show_job_number ?? true,
        });
      }
      setSearched(true);
    });
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
      {/* MES integration info banner — shown when no linked machine */}
      {!machine && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-blue-500/20 bg-blue-500/5 text-sm">
          <Settings size={15} className="text-blue-400 flex-shrink-0" />
          <span className="text-blue-300">
            MES kiosk integration coming soon. Configuration is saved and will activate when a kiosk machine with code{' '}
            <span className="font-mono text-white">{equipment.code}</span> is linked.
          </span>
        </div>
      )}

      {/* Config sub-tab header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 overflow-x-auto pb-1">
          {CONFIG_TABS.map(({ id, label, Icon }) => (
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
              {label}
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
        {configTab === 'parameters' && <ParametersTab form={form} set={set} />}
        {configTab === 'indicators' && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <Activity size={40} className="text-gray-700 mb-4" />
            <p className="text-gray-600 text-sm">Indicators configuration — coming soon</p>
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
  const [tab, setTab] = useState<TabId>('overview');
  const [equipment, setEquipment] = useState<Equipment | null>(null);
  const [wos, setWOs] = useState<WorkOrder[]>([]);
  const [plans, setPlans] = useState<MaintenancePlan[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    Promise.allSettled([
      fetchEquipmentById(id),
      fetchWorkOrders({ equipment_id: id, limit: '50' }),
      fetchMaintenancePlans(id),
    ]).then(([eq, wo, pl]) => {
      if (eq.status === 'fulfilled') setEquipment(eq.value);
      if (wo.status === 'fulfilled') setWOs(wo.value);
      if (pl.status === 'fulfilled') setPlans(pl.value);
      setLoading(false);
    });
  }, [id]);

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

  const tabs: { id: TabId; label: string }[] = [
    { id: 'overview',       label: t('equipment.tabOverview') },
    { id: 'workorders',     label: `${t('equipment.tabWorkOrders')} (${wos.length})` },
    { id: 'plans',          label: `${t('equipment.tabPlans')} (${plans.length})` },
    { id: 'configuration',  label: 'Configuration' },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Back + Header */}
      <div>
        <button
          onClick={() => navigate('/equipment')}
          className="flex items-center gap-1.5 text-gray-500 hover:text-gray-300 text-sm mb-4 transition-colors"
        >
          <ArrowLeft size={15} />
          {t('equipment.title')}
        </button>

        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center flex-shrink-0">
              <Cpu size={24} className="text-blue-400" />
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold text-white">{equipment.name}</h1>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${STATUS_COLORS[equipment.status] ?? STATUS_COLORS.stopped}`}>
                  {equipment.status.replace('_', ' ')}
                </span>
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
      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-300">{t('equipment.specifications')}</h3>
            <SpecRow label={t('equipment.manufacturer')} value={equipment.manufacturer} />
            <SpecRow label={t('equipment.model')} value={equipment.model} />
            <SpecRow label={t('equipment.serialNumber')} value={equipment.serial_number} />
            <SpecRow label={t('equipment.year')} value={equipment.manufacturing_year?.toString()} />
            <SpecRow label={t('equipment.criticality')} value={equipment.criticality} />
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
              <StatCard label={t('equipment.avgRepair')} value={`${(wos.filter((w) => w.repair_hours).reduce((a, w) => a + (w.repair_hours ?? 0), 0) / Math.max(wos.filter((w) => w.repair_hours).length, 1)).toFixed(1)}h`} icon={<Gauge size={16} className="text-purple-400" />} />
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
          {plans.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-gray-600 text-sm bg-[#0d1421] border border-white/[0.06] rounded-xl">
              {t('equipment.noPlans')}
            </div>
          ) : (
            plans.map((plan) => (
              <div key={plan.id} className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-white font-medium text-sm">{plan.name}</p>
                    {plan.description && <p className="text-gray-500 text-xs mt-0.5">{plan.description}</p>}
                    <div className="flex items-center gap-3 mt-2 text-xs text-gray-600">
                      <span>{plan.trigger_type}</span>
                      {plan.interval_days && <span>Every {plan.interval_days} days</span>}
                    </div>
                  </div>
                  {plan.next_execution_at && (
                    <div className="text-right">
                      <p className="text-xs text-gray-600">Next</p>
                      <p className="text-sm text-amber-400 font-medium">
                        {format(new Date(plan.next_execution_at), 'MMM dd, yyyy')}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'configuration' && <ConfigurationPanel equipment={equipment} />}
    </div>
  );
}

function SpecRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-white/[0.03] last:border-0">
      <span className="text-xs text-gray-600">{label}</span>
      <span className="text-sm text-gray-300">{value ?? '—'}</span>
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
