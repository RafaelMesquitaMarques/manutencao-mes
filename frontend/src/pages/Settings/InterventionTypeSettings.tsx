import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Check, X } from 'lucide-react';
import api from '../../api/axios';
import { fetchEquipment } from '../../api/workOrders';
import type { Equipment, InterventionType } from '../../types';

interface TypeForm {
  name: string;
  icon: string;
  color: string;
  sort_order: number;
}

const DEFAULT_ICONS = ['🔧', '⚡', '💨', '💧', '🔌', '🛢️', '🔩', '🧹', '❓', '🔥', '⚙️', '🪛', '🔄', '📦', '🪤'];
const EMPTY_FORM: TypeForm = { name: '', icon: '🔧', color: '#388bfd', sort_order: 0 };

export default function InterventionTypeSettings() {
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [selectedEqId, setSelectedEqId] = useState<string>('');
  const [types, setTypes] = useState<InterventionType[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState<TypeForm>(EMPTY_FORM);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<TypeForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchEquipment().then(setEquipment).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedEqId) { setTypes([]); return; }
    setLoading(true);
    api.get(`/api/settings/intervention-types/?equipment_id=${selectedEqId}`)
      .then((r) => setTypes(r.data.items.filter((t: InterventionType) => t.is_active)))
      .catch(() => setTypes([]))
      .finally(() => setLoading(false));
  }, [selectedEqId]);

  const reload = () => {
    if (!selectedEqId) return;
    api.get(`/api/settings/intervention-types/?equipment_id=${selectedEqId}`)
      .then((r) => setTypes(r.data.items.filter((t: InterventionType) => t.is_active)))
      .catch(() => {});
  };

  const handleAdd = async () => {
    if (!addForm.name.trim() || !selectedEqId) return;
    setSaving(true);
    try {
      await api.post('/api/settings/intervention-types/', {
        equipment_id: selectedEqId,
        name: addForm.name.trim(),
        icon: addForm.icon,
        color: addForm.color,
        sort_order: addForm.sort_order,
      });
      setShowAdd(false);
      setAddForm(EMPTY_FORM);
      reload();
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
      reload();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Désactiver ce type?')) return;
    await api.delete(`/api/settings/intervention-types/${id}`);
    reload();
  };

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-white">Types d'intervention</h1>
        <p className="text-gray-500 text-sm mt-0.5">Configurer les types par équipement</p>
      </div>

      {/* Equipment selector */}
      <div className="max-w-sm">
        <label className="text-xs text-gray-500 uppercase tracking-wider mb-1 block">Équipement</label>
        <select
          value={selectedEqId}
          onChange={(e) => setSelectedEqId(e.target.value)}
          className="w-full bg-[#0d1421] border border-white/[0.06] rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500/50"
        >
          <option value="">— Sélectionner un équipement —</option>
          {equipment.map((eq) => (
            <option key={eq.id} value={eq.id}>{eq.name} ({eq.code})</option>
          ))}
        </select>
      </div>

      {selectedEqId && (
        <>
          {/* Type list */}
          <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl overflow-hidden">
            {loading ? (
              <div className="p-8 text-center text-gray-500 text-sm">Chargement...</div>
            ) : types.length === 0 ? (
              <div className="p-8 text-center text-gray-500 text-sm">Aucun type configuré</div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/[0.04]">
                    <th className="px-4 py-3 text-left text-xs text-gray-600 uppercase tracking-wider">Icône</th>
                    <th className="px-4 py-3 text-left text-xs text-gray-600 uppercase tracking-wider">Nom</th>
                    <th className="px-4 py-3 text-left text-xs text-gray-600 uppercase tracking-wider">Couleur</th>
                    <th className="px-4 py-3 text-left text-xs text-gray-600 uppercase tracking-wider">Ordre</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {types.map((t) => (
                    <tr key={t.id} className="border-b border-white/[0.03] last:border-0">
                      {editId === t.id ? (
                        <>
                          <td className="px-4 py-2">
                            <select value={editForm.icon} onChange={(e) => setEditForm({ ...editForm, icon: e.target.value })}
                              className="bg-[#111318] border border-white/[0.08] rounded px-2 py-1 text-sm text-white w-20">
                              {DEFAULT_ICONS.map((ic) => <option key={ic} value={ic}>{ic}</option>)}
                            </select>
                          </td>
                          <td className="px-4 py-2">
                            <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                              className="bg-[#111318] border border-white/[0.08] rounded px-2 py-1 text-sm text-white w-36" />
                          </td>
                          <td className="px-4 py-2">
                            <input type="color" value={editForm.color}
                              onChange={(e) => setEditForm({ ...editForm, color: e.target.value })}
                              className="w-8 h-8 rounded cursor-pointer border-0 bg-transparent" />
                          </td>
                          <td className="px-4 py-2">
                            <input type="number" value={editForm.sort_order}
                              onChange={(e) => setEditForm({ ...editForm, sort_order: Number(e.target.value) })}
                              className="bg-[#111318] border border-white/[0.08] rounded px-2 py-1 text-sm text-white w-16" />
                          </td>
                          <td className="px-4 py-2">
                            <div className="flex gap-1">
                              <button onClick={() => handleEdit(t.id)} disabled={saving}
                                className="p-1 rounded text-green-400 hover:bg-green-900/20 transition-colors">
                                <Check size={14} />
                              </button>
                              <button onClick={() => setEditId(null)}
                                className="p-1 rounded text-gray-500 hover:bg-gray-800 transition-colors">
                                <X size={14} />
                              </button>
                            </div>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-4 py-3 text-xl">{t.icon}</td>
                          <td className="px-4 py-3 text-sm text-gray-200">{t.name}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-4 h-4 rounded-full" style={{ background: t.color }} />
                              <span className="text-xs text-gray-500 font-mono">{t.color}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500">{t.sort_order}</td>
                          <td className="px-4 py-3">
                            <div className="flex gap-1">
                              <button onClick={() => { setEditId(t.id); setEditForm({ name: t.name, icon: t.icon, color: t.color, sort_order: t.sort_order }); }}
                                className="p-1 rounded text-gray-500 hover:text-blue-400 hover:bg-blue-900/20 transition-colors">
                                <Pencil size={14} />
                              </button>
                              <button onClick={() => handleDelete(t.id)}
                                className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-red-900/20 transition-colors">
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Add form */}
          {showAdd ? (
            <div className="bg-[#0d1421] border border-blue-500/30 rounded-xl p-4">
              <p className="text-sm font-semibold text-white mb-3">Nouveau type</p>
              <div className="flex flex-wrap gap-3 items-end">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Icône</label>
                  <select value={addForm.icon} onChange={(e) => setAddForm({ ...addForm, icon: e.target.value })}
                    className="bg-[#111318] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white">
                    {DEFAULT_ICONS.map((ic) => <option key={ic} value={ic}>{ic}</option>)}
                  </select>
                </div>
                <div className="flex-1 min-w-[160px]">
                  <label className="text-xs text-gray-500 mb-1 block">Nom</label>
                  <input value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                    placeholder="Ex: Convoyeur..."
                    className="w-full bg-[#111318] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500/50" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Couleur</label>
                  <input type="color" value={addForm.color}
                    onChange={(e) => setAddForm({ ...addForm, color: e.target.value })}
                    className="h-9 w-12 rounded-lg cursor-pointer border border-white/[0.08] bg-transparent" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Ordre</label>
                  <input type="number" value={addForm.sort_order}
                    onChange={(e) => setAddForm({ ...addForm, sort_order: Number(e.target.value) })}
                    className="w-16 bg-[#111318] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white" />
                </div>
                <div className="flex gap-2">
                  <button onClick={handleAdd} disabled={saving || !addForm.name.trim()}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
                    Ajouter
                  </button>
                  <button onClick={() => { setShowAdd(false); setAddForm(EMPTY_FORM); }}
                    className="px-4 py-2 bg-[#111318] border border-white/[0.06] text-gray-400 text-sm rounded-lg hover:text-white transition-colors">
                    Annuler
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowAdd(true)}
              className="flex items-center gap-2 px-4 py-2 bg-[#0d1421] border border-white/[0.06] hover:border-blue-500/40 text-gray-400 hover:text-blue-400 text-sm rounded-lg transition-colors">
              <Plus size={16} /> Ajouter un type
            </button>
          )}
        </>
      )}
    </div>
  );
}
