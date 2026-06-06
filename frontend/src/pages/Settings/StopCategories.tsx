import { useState, useEffect } from 'react';
import { Plus, ChevronDown, ChevronRight, GripVertical, Check, X, Pencil } from 'lucide-react';
import {
  fetchAllCategories, createCategory, updateCategory, reorderCategories,
  fetchSubcategories, createSubcategory, updateSubcategory,
} from '../../api/stopCategories';
import { useTranslation } from 'react-i18next';
import type { StopCategoryOut, StopSubcategoryOut } from '../../types';

const TYPE_COLORS: Record<string, string> = {
  planned: '#3b82f6',
  maintenance: '#f59e0b',
  unplanned: '#ef4444',
};

const PRESET_ICONS = ['🔧', '⚙️', '🛑', '❌', '⚠️', '🕐', '🔴', '🔵', '🟡', '🟢', '🔨', '⛔', '🚫', '💡', '🔩', '🛠️', '📋', '🔔'];
const PRESET_COLORS = ['#ef4444', '#f59e0b', '#3b82f6', '#10b981', '#8b5cf6', '#ec4899', '#06b6d4', '#6b7280'];

function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {PRESET_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className="w-6 h-6 rounded-full border-2 transition-all"
          style={{ backgroundColor: c, borderColor: value === c ? 'white' : 'transparent' }}
        />
      ))}
    </div>
  );
}

function IconPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-1 flex-wrap">
      {PRESET_ICONS.map((ic) => (
        <button
          key={ic}
          type="button"
          onClick={() => onChange(ic)}
          className={`w-8 h-8 text-lg rounded-lg transition-all ${value === ic ? 'bg-white/15 ring-1 ring-white/30' : 'hover:bg-white/[0.05]'}`}
        >
          {ic}
        </button>
      ))}
    </div>
  );
}

function SubcategoryRow({
  sub, onUpdate,
}: {
  sub: StopSubcategoryOut;
  onUpdate: (id: string, payload: Partial<StopSubcategoryOut>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName]       = useState(sub.name);
  const [icon, setIcon]       = useState(sub.icon);
  const [maint, setMaint]     = useState(sub.triggers_maintenance);
  const [busy, setBusy]       = useState(false);

  const save = async () => {
    setBusy(true);
    await onUpdate(sub.id, { name, icon, triggers_maintenance: maint });
    setBusy(false);
    setEditing(false);
  };

  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-white/[0.03] group">
      <GripVertical size={14} className="text-gray-700 opacity-0 group-hover:opacity-100" />
      <span className="text-xl">{sub.icon}</span>
      {editing ? (
        <div className="flex-1 space-y-2">
          <div className="flex gap-2">
            <input
              value={name} onChange={(e) => setName(e.target.value)}
              className="flex-1 bg-[#0b1120] border border-white/10 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
            />
            <button
              type="button"
              onClick={() => setMaint((v) => !v)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-bold border transition-all ${maint ? 'bg-amber-500/20 text-amber-400 border-amber-500/40' : 'bg-white/[0.04] text-gray-500 border-white/10'}`}
            >Maintenance</button>
          </div>
          <IconPicker value={icon} onChange={setIcon} />
          <div className="flex gap-2">
            <button onClick={save} disabled={busy} className="bg-blue-600 text-white px-3 py-1 rounded-lg text-xs font-bold disabled:opacity-50">
              <Check size={12} />
            </button>
            <button onClick={() => setEditing(false)} className="text-gray-600 px-3 py-1 border border-white/10 rounded-lg text-xs">
              <X size={12} />
            </button>
          </div>
        </div>
      ) : (
        <>
          <span className="flex-1 text-sm text-gray-300">{sub.name}</span>
          {sub.triggers_maintenance && (
            <span className="text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 rounded-full">Maintenance</span>
          )}
          <button
            onClick={() => { setName(sub.name); setIcon(sub.icon); setMaint(sub.triggers_maintenance); setEditing(true); }}
            className="opacity-0 group-hover:opacity-100 p-1 rounded text-gray-600 hover:text-gray-300 transition-all"
          ><Pencil size={12} /></button>
          <button
            onClick={() => onUpdate(sub.id, { is_active: !sub.is_active })}
            className={`text-xs px-2 py-0.5 rounded-full border transition-all ${sub.is_active ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-gray-500/10 text-gray-600 border-gray-700'}`}
          >{sub.is_active ? 'Active' : 'Inactive'}</button>
        </>
      )}
    </div>
  );
}

function CategoryCard({
  cat, index, onUpdate, onMoveUp, onMoveDown, isFirst, isLast,
}: {
  cat: StopCategoryOut;
  index: number;
  onUpdate: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const [expanded, setExpanded]     = useState(false);
  const [subs, setSubs]             = useState<StopSubcategoryOut[]>([]);
  const [loadingSubs, setLoadingSubs] = useState(false);
  const [editing, setEditing]       = useState(false);
  const [name, setName]             = useState(cat.name);
  const [icon, setIcon]             = useState(cat.icon);
  const [color, setColor]           = useState(cat.color);
  const [busy, setBusy]             = useState(false);
  const [showAddSub, setShowAddSub] = useState(false);
  const [newSubName, setNewSubName] = useState('');
  const [newSubIcon, setNewSubIcon] = useState('🔧');
  const [newSubMaint, setNewSubMaint] = useState(false);

  const loadSubs = async () => {
    setLoadingSubs(true);
    const data = await fetchSubcategories(cat.id);
    setSubs(data);
    setLoadingSubs(false);
  };

  const toggle = () => {
    if (!expanded && subs.length === 0) loadSubs();
    setExpanded((v) => !v);
  };

  const saveCat = async () => {
    setBusy(true);
    await updateCategory(cat.id, { name, icon, color });
    setBusy(false);
    setEditing(false);
    onUpdate();
  };

  const toggleActive = async () => {
    await updateCategory(cat.id, { is_active: !cat.is_active });
    onUpdate();
  };

  const handleSubUpdate = async (id: string, payload: Partial<StopSubcategoryOut>) => {
    await updateSubcategory(id, payload);
    await loadSubs();
  };

  const addSub = async () => {
    if (!newSubName.trim()) return;
    setBusy(true);
    await createSubcategory(cat.id, {
      name: newSubName, icon: newSubIcon, triggers_maintenance: newSubMaint,
      sort_order: subs.length + 1,
    });
    setNewSubName(''); setNewSubIcon('🔧'); setNewSubMaint(false);
    setShowAddSub(false);
    await loadSubs();
    setBusy(false);
  };

  return (
    <div className={`bg-[#0d1421] rounded-2xl border transition-all ${cat.is_active ? 'border-white/[0.06]' : 'border-white/[0.03] opacity-60'}`}>
      {/* Category header */}
      <div className="flex items-center gap-3 p-4">
        <div className="flex flex-col gap-0.5">
          <button onClick={onMoveUp} disabled={isFirst} className="p-0.5 text-gray-700 hover:text-gray-400 disabled:opacity-20 transition-all">▲</button>
          <button onClick={onMoveDown} disabled={isLast} className="p-0.5 text-gray-700 hover:text-gray-400 disabled:opacity-20 transition-all">▼</button>
        </div>

        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-2xl" style={{ backgroundColor: cat.color + '20' }}>
          {cat.icon}
        </div>

        {editing ? (
          <div className="flex-1 space-y-2">
            <div className="flex gap-2 items-center">
              <input
                value={name} onChange={(e) => setName(e.target.value)}
                className="flex-1 bg-[#0b1120] border border-white/10 rounded-xl px-4 py-2 text-white text-base focus:outline-none focus:border-blue-500"
              />
              <button onClick={saveCat} disabled={busy} className="bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-50">
                <Check size={14} />
              </button>
              <button onClick={() => setEditing(false)} className="text-gray-600 px-3 py-2 border border-white/10 rounded-xl text-sm">
                <X size={14} />
              </button>
            </div>
            <IconPicker value={icon} onChange={setIcon} />
            <ColorPicker value={color} onChange={setColor} />
          </div>
        ) : (
          <>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-base font-bold text-white">{cat.name}</span>
                <span
                  className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                  style={{ backgroundColor: TYPE_COLORS[cat.type] + '20', color: TYPE_COLORS[cat.type] }}
                >{cat.type}</span>
              </div>
              <p className="text-xs text-gray-600 mt-0.5">{subs.length || cat.subcategories?.length || 0} subcategories</p>
            </div>
            <button
              onClick={() => { setName(cat.name); setIcon(cat.icon); setColor(cat.color); setEditing(true); }}
              className="p-2 rounded-lg text-gray-600 hover:text-gray-300 hover:bg-white/[0.05] transition-all"
            ><Pencil size={14} /></button>
            <button onClick={toggleActive} className={`text-xs px-2.5 py-1 rounded-full border ${cat.is_active ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-gray-500/10 text-gray-600 border-gray-700'}`}>
              {cat.is_active ? 'Active' : 'Inactive'}
            </button>
          </>
        )}

        <button onClick={toggle} className="p-2 text-gray-600 hover:text-gray-300 transition-colors ml-1">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
      </div>

      {/* Expanded: subcategories */}
      {expanded && (
        <div className="border-t border-white/[0.04] px-4 pb-4 pt-2">
          {loadingSubs ? (
            <p className="text-xs text-gray-600 py-2">Loading...</p>
          ) : subs.length > 0 ? (
            <div className="space-y-0.5">
              {subs.map((s) => (
                <SubcategoryRow key={s.id} sub={s} onUpdate={handleSubUpdate} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-700 py-2">No subcategories</p>
          )}

          {showAddSub ? (
            <div className="mt-3 space-y-2 p-3 bg-white/[0.03] rounded-xl border border-white/[0.06]">
              <div className="flex gap-2">
                <input
                  value={newSubName} onChange={(e) => setNewSubName(e.target.value)}
                  placeholder="Subcategory name..."
                  className="flex-1 bg-[#0b1120] border border-white/10 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
                />
                <button
                  type="button"
                  onClick={() => setNewSubMaint((v) => !v)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-bold border transition-all ${newSubMaint ? 'bg-amber-500/20 text-amber-400 border-amber-500/40' : 'bg-white/[0.04] text-gray-500 border-white/10'}`}
                >Maintenance</button>
              </div>
              <IconPicker value={newSubIcon} onChange={setNewSubIcon} />
              <div className="flex gap-2">
                <button onClick={addSub} disabled={busy || !newSubName.trim()} className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold disabled:opacity-50">Add</button>
                <button onClick={() => setShowAddSub(false)} className="text-gray-600 px-3 py-1.5 border border-white/10 rounded-lg text-xs">Cancel</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowAddSub(true)}
              className="mt-2 flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-300 transition-colors"
            >
              <Plus size={12} /> Add subcategory
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function StopCategoriesPage() {
  const { t } = useTranslation();
  const [categories, setCategories] = useState<StopCategoryOut[]>([]);
  const [loading, setLoading]       = useState(true);
  const [showAdd, setShowAdd]       = useState(false);
  const [newName, setNewName]       = useState('');
  const [newType, setNewType]       = useState<'planned' | 'unplanned' | 'maintenance'>('unplanned');
  const [newIcon, setNewIcon]       = useState('🔧');
  const [newColor, setNewColor]     = useState('#ef4444');
  const [busy, setBusy]             = useState(false);

  const load = async () => {
    setLoading(true);
    const data = await fetchAllCategories();
    setCategories(data);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const moveCategory = async (index: number, direction: 'up' | 'down') => {
    const next = [...categories];
    const swap = direction === 'up' ? index - 1 : index + 1;
    [next[index], next[swap]] = [next[swap], next[index]];
    setCategories(next);
    await reorderCategories(next.map((c, i) => ({ id: c.id, sort_order: i + 1 })));
  };

  const addCategory = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    await createCategory({ name: newName, type: newType, icon: newIcon, color: newColor, sort_order: categories.length + 1 });
    setNewName(''); setNewIcon('🔧'); setNewColor('#ef4444');
    setShowAdd(false);
    await load();
    setBusy(false);
  };

  return (
    <div className="min-h-screen bg-[#060c17] text-white p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-black text-white">Stop Categories</h1>
          <p className="text-sm text-gray-600 mt-1">Configure stop reasons for machine pages</p>
        </div>
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-bold px-4 py-2.5 rounded-xl transition-colors text-sm"
        >
          <Plus size={16} /> Add Category
        </button>
      </div>

      {showAdd && (
        <div className="mb-6 p-5 bg-[#0d1421] rounded-2xl border border-white/[0.06] space-y-3">
          <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest">New Category</h3>
          <div className="flex gap-3">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Category name..."
              className="flex-1 bg-[#0b1120] border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value as typeof newType)}
              className="bg-[#0b1120] border border-white/10 rounded-xl px-3 py-2.5 text-white focus:outline-none focus:border-blue-500"
            >
              <option value="unplanned">Unplanned</option>
              <option value="planned">Planned</option>
              <option value="maintenance">Maintenance</option>
            </select>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-gray-600">Icon</p>
            <IconPicker value={newIcon} onChange={setNewIcon} />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-gray-600">Color</p>
            <ColorPicker value={newColor} onChange={setNewColor} />
          </div>
          <div className="flex gap-2">
            <button onClick={addCategory} disabled={busy || !newName.trim()} className="bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-50">Create</button>
            <button onClick={() => setShowAdd(false)} className="text-gray-600 px-4 py-2 border border-white/10 rounded-xl text-sm">Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-3">
          {categories.map((cat, i) => (
            <CategoryCard
              key={cat.id}
              cat={cat}
              index={i}
              onUpdate={load}
              onMoveUp={() => moveCategory(i, 'up')}
              onMoveDown={() => moveCategory(i, 'down')}
              isFirst={i === 0}
              isLast={i === categories.length - 1}
            />
          ))}
          {categories.length === 0 && (
            <div className="text-center py-16 text-gray-700">
              No stop categories configured yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
