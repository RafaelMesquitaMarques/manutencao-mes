import { useState, useEffect } from 'react';
import {
  Package, Search, Plus, AlertTriangle, ArrowUp, ArrowDown,
  RefreshCw, X, Edit3, History,
} from 'lucide-react';
import { fetchInventory, createStockItem, updateStockItem, deleteStockItem, addStock, adjustStock, fetchMovements } from '../../api/inventory';
import type { StockItem, InventoryMovement } from '../../types';
import Spinner from '../../components/ui/Spinner';
import { useAuthStore } from '../../store/authStore';

export default function InventoryList() {
  const { user } = useAuthStore();
  const [items, setItems]     = useState<StockItem[]>([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [lowStock, setLowStock] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editItem, setEditItem]     = useState<StockItem | null>(null);
  const [movItem, setMovItem]       = useState<StockItem | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetchInventory({
        search: search || undefined,
        low_stock: lowStock || undefined,
      });
      setItems(res.items);
      setTotal(res.total);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [search, lowStock]);

  const plantId = user?.id ?? '';

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Package size={22} className="text-green-400" />
            Inventory
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">{total} items · Spare parts and consumables</p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} disabled={loading} className="btn-secondary py-1.5 px-3">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button onClick={() => setShowCreate(true)} className="btn-primary py-1.5 px-3 flex items-center gap-1.5">
            <Plus size={14} /> Add Item
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search parts, codes…"
            className="input-field pl-9 w-full text-sm"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-300">
              <X size={14} />
            </button>
          )}
        </div>
        <button
          onClick={() => setLowStock(!lowStock)}
          className={`px-3 py-2 text-sm rounded flex items-center gap-1.5 border transition-colors ${
            lowStock
              ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
              : 'border-white/10 text-gray-500 hover:text-gray-300'
          }`}
        >
          <AlertTriangle size={13} /> Low Stock
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48"><Spinner size="lg" /></div>
      ) : items.length === 0 ? (
        <div className="glass-card p-12 text-center space-y-3">
          <Package size={40} className="text-gray-700 mx-auto opacity-50" />
          <p className="text-gray-500">{search ? 'No items match your search' : 'No inventory items yet'}</p>
          {!search && (
            <button onClick={() => setShowCreate(true)} className="btn-primary px-4 py-2 text-sm">
              Add First Item
            </button>
          )}
        </div>
      ) : (
        <div className="glass-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="text-left p-3 text-xs text-gray-600 uppercase tracking-wider">Item</th>
                <th className="text-right p-3 text-xs text-gray-600 uppercase tracking-wider">Stock</th>
                <th className="text-right p-3 text-xs text-gray-600 uppercase tracking-wider hidden md:table-cell">Min</th>
                <th className="text-right p-3 text-xs text-gray-600 uppercase tracking-wider hidden lg:table-cell">Unit Cost</th>
                <th className="text-right p-3 text-xs text-gray-600 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const isLow = item.quantity <= item.min_quantity;
                return (
                  <tr key={item.id} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02]">
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        {isLow && <AlertTriangle size={12} className="text-amber-400 flex-shrink-0" />}
                        <div>
                          <p className="text-gray-200 font-medium">{item.name}</p>
                          <div className="flex gap-2 mt-0.5">
                            {item.code && <span className="text-xs text-gray-600 font-mono">{item.code}</span>}
                            {item.location && <span className="text-xs text-gray-700">{item.location}</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="p-3 text-right">
                      <span className={`font-semibold ${isLow ? 'text-amber-400' : 'text-gray-300'}`}>
                        {item.quantity}
                      </span>
                      {item.unit && <span className="text-gray-600 ml-1">{item.unit}</span>}
                    </td>
                    <td className="p-3 text-right text-gray-600 hidden md:table-cell">{item.min_quantity}</td>
                    <td className="p-3 text-right text-gray-500 hidden lg:table-cell">
                      {item.unit_cost != null ? `$${item.unit_cost.toFixed(2)}` : '—'}
                    </td>
                    <td className="p-3 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => setMovItem(item)}
                          title="Movement history"
                          className="p-1.5 text-gray-600 hover:text-gray-300 transition-colors"
                        >
                          <History size={14} />
                        </button>
                        <button
                          onClick={() => setEditItem(item)}
                          title="Edit"
                          className="p-1.5 text-gray-600 hover:text-gray-300 transition-colors"
                        >
                          <Edit3 size={14} />
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

      {showCreate && (
        <CreateItemModal
          plantId={plantId}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}

      {editItem && (
        <EditItemModal
          item={editItem}
          onClose={() => setEditItem(null)}
          onSaved={() => { setEditItem(null); load(); }}
          onDeleted={() => { setEditItem(null); load(); }}
        />
      )}

      {movItem && (
        <MovementsModal item={movItem} onClose={() => setMovItem(null)} />
      )}
    </div>
  );
}

// ── Create Modal ──────────────────────────────────────────────────────────────

function CreateItemModal({ plantId, onClose, onCreated }: {
  plantId: string; onClose: () => void; onCreated: () => void;
}) {
  const { user } = useAuthStore();
  const [form, setForm] = useState({ name: '', code: '', description: '', unit: 'un', quantity: '0', min_quantity: '0', location: '', unit_cost: '', supplier: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState('');

  const save = async () => {
    if (!form.name.trim()) { setErr('Name is required'); return; }
    setSaving(true); setErr('');
    try {
      await createStockItem({
        plant_id: plantId || user?.id || '',
        name: form.name,
        code: form.code || undefined,
        description: form.description || undefined,
        unit: form.unit || undefined,
        quantity: parseFloat(form.quantity) || 0,
        min_quantity: parseFloat(form.min_quantity) || 0,
        location: form.location || undefined,
        unit_cost: parseFloat(form.unit_cost) || undefined,
        supplier: form.supplier || undefined,
      });
      onCreated();
    } catch (e: unknown) {
      setErr((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Error');
    } finally { setSaving(false); }
  };

  return (
    <ModalWrapper title="Add Inventory Item" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="label">Name *</label>
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="input-field w-full" />
          </div>
          <div>
            <label className="label">Code / Part #</label>
            <input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} className="input-field w-full" />
          </div>
          <div>
            <label className="label">Unit</label>
            <input value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} className="input-field w-full" />
          </div>
          <div>
            <label className="label">Current Stock</label>
            <input type="number" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} className="input-field w-full" />
          </div>
          <div>
            <label className="label">Minimum Stock</label>
            <input type="number" value={form.min_quantity} onChange={(e) => setForm((f) => ({ ...f, min_quantity: e.target.value }))} className="input-field w-full" />
          </div>
          <div>
            <label className="label">Unit Cost ($)</label>
            <input type="number" step="0.01" value={form.unit_cost} onChange={(e) => setForm((f) => ({ ...f, unit_cost: e.target.value }))} className="input-field w-full" />
          </div>
          <div>
            <label className="label">Location</label>
            <input value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} className="input-field w-full" />
          </div>
          <div className="col-span-2">
            <label className="label">Supplier</label>
            <input value={form.supplier} onChange={(e) => setForm((f) => ({ ...f, supplier: e.target.value }))} className="input-field w-full" />
          </div>
        </div>
        {err && <p className="text-red-400 text-sm">{err}</p>}
        <div className="flex gap-2 pt-2">
          <button onClick={onClose} className="btn-secondary flex-1 py-2">Cancel</button>
          <button onClick={save} disabled={saving} className="btn-primary flex-1 py-2 font-semibold">
            {saving ? 'Saving…' : 'Add Item'}
          </button>
        </div>
      </div>
    </ModalWrapper>
  );
}

// ── Edit Modal ────────────────────────────────────────────────────────────────

function EditItemModal({ item, onClose, onSaved, onDeleted }: {
  item: StockItem; onClose: () => void; onSaved: () => void; onDeleted: () => void;
}) {
  const [tab, setTab] = useState<'edit' | 'stock'>('edit');
  const [form, setForm] = useState({
    name: item.name, code: item.code ?? '', unit: item.unit ?? 'un',
    min_quantity: String(item.min_quantity), unit_cost: String(item.unit_cost ?? ''),
    location: item.location ?? '', supplier: item.supplier ?? '',
  });
  const [adjQty, setAdjQty]   = useState('');
  const [adjNotes, setAdjNotes] = useState('');
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState('');

  const saveEdit = async () => {
    setSaving(true); setErr('');
    try {
      await updateStockItem(item.id, {
        name: form.name, code: form.code || undefined,
        unit: form.unit || undefined, min_quantity: parseFloat(form.min_quantity) || 0,
        unit_cost: parseFloat(form.unit_cost) || undefined,
        location: form.location || undefined, supplier: form.supplier || undefined,
      });
      onSaved();
    } catch (e: unknown) {
      setErr((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Error');
    } finally { setSaving(false); }
  };

  const doAddStock = async () => {
    const qty = parseFloat(adjQty);
    if (!qty || qty <= 0) { setErr('Enter a valid quantity'); return; }
    setSaving(true); setErr('');
    try {
      await addStock(item.id, qty, adjNotes || undefined);
      onSaved();
    } catch { setErr('Error updating stock'); } finally { setSaving(false); }
  };

  const doAdjust = async () => {
    const qty = parseFloat(adjQty);
    if (qty == null || isNaN(qty)) { setErr('Enter a quantity'); return; }
    setSaving(true); setErr('');
    try {
      await adjustStock(item.id, qty, adjNotes || undefined);
      onSaved();
    } catch { setErr('Error adjusting stock'); } finally { setSaving(false); }
  };

  const doDelete = async () => {
    if (!confirm(`Delete "${item.name}"?`)) return;
    try { await deleteStockItem(item.id); onDeleted(); } catch { setErr('Error deleting'); }
  };

  return (
    <ModalWrapper title={`Edit: ${item.name}`} onClose={onClose}>
      <div className="flex gap-2 mb-4 border-b border-white/[0.08]">
        <button onClick={() => setTab('edit')} className={`pb-2 px-2 text-sm border-b-2 transition-colors ${tab === 'edit' ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-500'}`}>Details</button>
        <button onClick={() => setTab('stock')} className={`pb-2 px-2 text-sm border-b-2 transition-colors ${tab === 'stock' ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-500'}`}>
          Update Stock (current: {item.quantity} {item.unit})
        </button>
      </div>

      {tab === 'edit' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="label">Name</label>
              <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="input-field w-full" />
            </div>
            <div>
              <label className="label">Code</label>
              <input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} className="input-field w-full" />
            </div>
            <div>
              <label className="label">Unit</label>
              <input value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} className="input-field w-full" />
            </div>
            <div>
              <label className="label">Min Stock</label>
              <input type="number" value={form.min_quantity} onChange={(e) => setForm((f) => ({ ...f, min_quantity: e.target.value }))} className="input-field w-full" />
            </div>
            <div>
              <label className="label">Unit Cost ($)</label>
              <input type="number" step="0.01" value={form.unit_cost} onChange={(e) => setForm((f) => ({ ...f, unit_cost: e.target.value }))} className="input-field w-full" />
            </div>
          </div>
          {err && <p className="text-red-400 text-sm">{err}</p>}
          <div className="flex gap-2 pt-1">
            <button onClick={doDelete} className="btn-secondary py-2 px-3 text-red-400 hover:text-red-300">Delete</button>
            <button onClick={onClose} className="btn-secondary flex-1 py-2">Cancel</button>
            <button onClick={saveEdit} disabled={saving} className="btn-primary flex-1 py-2 font-semibold">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {tab === 'stock' && (
        <div className="space-y-3">
          <div>
            <label className="label">Quantity</label>
            <input type="number" step="0.01" placeholder="e.g. 5" value={adjQty}
              onChange={(e) => setAdjQty(e.target.value)} className="input-field w-full" />
          </div>
          <div>
            <label className="label">Notes</label>
            <input value={adjNotes} onChange={(e) => setAdjNotes(e.target.value)} className="input-field w-full" placeholder="Reason for change…" />
          </div>
          {err && <p className="text-red-400 text-sm">{err}</p>}
          <div className="flex gap-2 pt-1">
            <button onClick={doAddStock} disabled={saving} className="btn-primary flex-1 py-2 flex items-center justify-center gap-1 text-sm">
              <ArrowUp size={14} /> Add Stock
            </button>
            <button onClick={doAdjust} disabled={saving} className="btn-secondary flex-1 py-2 flex items-center justify-center gap-1 text-sm">
              <ArrowDown size={14} /> Set Exact
            </button>
          </div>
        </div>
      )}
    </ModalWrapper>
  );
}

// ── Movements Modal ───────────────────────────────────────────────────────────

function MovementsModal({ item, onClose }: { item: StockItem; onClose: () => void }) {
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMovements(item.id).then((r) => setMovements(r.items)).catch(() => {}).finally(() => setLoading(false));
  }, [item.id]);

  const mtCls: Record<string, string> = {
    deduction:  'text-red-400',
    addition:   'text-green-400',
    adjustment: 'text-blue-400',
  };

  return (
    <ModalWrapper title={`Movements: ${item.name}`} onClose={onClose}>
      {loading ? (
        <div className="flex items-center justify-center h-24"><Spinner size="lg" /></div>
      ) : movements.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-6">No movements recorded</p>
      ) : (
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {movements.map((m) => (
            <div key={m.id} className="flex items-center justify-between py-1.5 border-b border-white/[0.04]">
              <div>
                <span className={`text-xs font-medium ${mtCls[m.movement_type] ?? 'text-gray-400'}`}>
                  {m.movement_type}
                </span>
                {m.notes && <p className="text-xs text-gray-600">{m.notes}</p>}
                <p className="text-xs text-gray-700">{new Date(m.created_at).toLocaleString()}</p>
              </div>
              <div className="text-right">
                <p className={`text-sm font-semibold ${m.quantity >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {m.quantity >= 0 ? '+' : ''}{m.quantity}
                </p>
                <p className="text-xs text-gray-600">{m.quantity_before} → {m.quantity_after}</p>
              </div>
            </div>
          ))}
        </div>
      )}
      <button onClick={onClose} className="btn-secondary w-full mt-4 py-2">Close</button>
    </ModalWrapper>
  );
}

// ── Shared Modal Wrapper ──────────────────────────────────────────────────────

function ModalWrapper({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-4">
      <div className="bg-[#0d1421] border border-white/10 rounded-2xl p-6 w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-bold text-lg">{title}</h2>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-300"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
