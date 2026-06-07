// frontend/src/pages/Inventory/InventoryDetail.tsx
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Package, AlertTriangle, Edit2, Save, X,
  MapPin, Tag, Layers, DollarSign, Hash, CircleAlert,
  CheckCircle2, Minus, Plus,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  fetchStockItem,
  updateStockItem,
  adjustQuantity,
  fetchSuppliers,
} from '../../api/inventory';
import type { StockItem, Supplier } from '../../types';

export default function InventoryDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [item, setItem] = useState<StockItem | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Partial<StockItem>>({});
  const [qtyDelta, setQtyDelta] = useState('');
  const [adjusting, setAdjusting] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([fetchStockItem(id), fetchSuppliers()]).then(([item, sup]) => {
      setItem(item);
      setDraft(item);
      setSuppliers(sup.items);
      setLoading(false);
    });
  }, [id]);

  const startEdit = () => { setDraft({ ...item }); setEditing(true); };
  const cancelEdit = () => { setDraft({ ...item }); setEditing(false); };

  const saveEdit = async () => {
    if (!item || !id) return;
    setSaving(true);
    try {
      const updated = await updateStockItem(id, draft);
      setItem(updated);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const applyDelta = async (sign: 1 | -1) => {
    if (!id || !qtyDelta) return;
    setAdjusting(true);
    try {
      const updated = await adjustQuantity(id, { delta: sign * parseFloat(qtyDelta) });
      setItem(updated);
      setQtyDelta('');
    } finally {
      setAdjusting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-950 text-gray-400">
        Chargement…
      </div>
    );
  }
  if (!item) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-950 text-gray-400">
        Pièce introuvable.
      </div>
    );
  }

  const isLow = item.is_low_stock;
  const isZero = item.quantity <= 0;

  return (
    <div className="min-h-full bg-gray-950 text-gray-100 pb-12">
      {/* ── Top bar ── */}
      <div className="sticky top-0 z-10 bg-gray-950/95 backdrop-blur border-b border-gray-800 px-6 py-3 flex items-center gap-3">
        <button
          onClick={() => navigate('/inventory')}
          className="p-1.5 hover:bg-gray-800 rounded-lg transition-colors text-gray-400 hover:text-gray-200"
        >
          <ArrowLeft size={18} />
        </button>
        <span className="text-gray-500">/</span>
        <span className="text-sm text-gray-300 font-medium">{t('nav.inventory', 'Inventaire')}</span>
        <span className="text-gray-500">/</span>
        <span className="text-sm font-mono text-indigo-300">{item.code}</span>

        <div className="ml-auto flex items-center gap-2">
          {editing ? (
            <>
              <button
                onClick={cancelEdit}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-300 bg-gray-800 border border-gray-700 hover:bg-gray-700 rounded-lg transition-colors"
              >
                <X size={14} /> Annuler
              </button>
              <button
                onClick={saveEdit}
                disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors disabled:opacity-50"
              >
                <Save size={14} /> {saving ? 'Sauvegarde…' : 'Enregistrer'}
              </button>
            </>
          ) : (
            <button
              onClick={startEdit}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-300 bg-gray-800 border border-gray-700 hover:bg-gray-700 rounded-lg transition-colors"
            >
              <Edit2 size={14} /> Modifier
            </button>
          )}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 pt-6 space-y-6">

        {/* ── Hero block ── */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-mono text-sm text-indigo-400 bg-indigo-950/50 border border-indigo-800 px-2 py-0.5 rounded">
                  {item.code}
                </span>
                {item.interal_product_id && (
                  <span className="text-xs text-gray-500 font-mono">
                    ID: {item.interal_product_id}
                  </span>
                )}
              </div>
              {editing ? (
                <textarea
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-lg text-white focus:outline-none focus:border-indigo-500 resize-none"
                  rows={2}
                  value={draft.description ?? ''}
                  onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
                />
              ) : (
                <h2 className="text-xl font-semibold text-white leading-snug">
                  {item.description || <span className="text-gray-500 italic">Sans description</span>}
                </h2>
              )}
            </div>

            {/* Stock status badge */}
            <div className={`flex-shrink-0 flex flex-col items-center justify-center w-28 h-20 rounded-xl border-2 ${
              isZero
                ? 'bg-red-950/40 border-red-700 text-red-400'
                : isLow
                ? 'bg-amber-950/40 border-amber-700 text-amber-400'
                : 'bg-emerald-950/40 border-emerald-700 text-emerald-400'
            }`}>
              {isZero ? <CircleAlert size={22} /> : isLow ? <AlertTriangle size={22} /> : <CheckCircle2 size={22} />}
              <span className="text-3xl font-bold mt-1">{item.quantity}</span>
              <span className="text-xs opacity-70">{item.unit}</span>
            </div>
          </div>
        </div>

        {/* ── Quick quantity adjustment ── */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
            <Layers size={14} className="text-indigo-400" />
            {t('inventory.adjustQty', 'Ajuster le stock')}
          </h3>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2">
              <span className="text-2xl font-bold text-white font-mono">{item.quantity}</span>
              {item.min_quantity != null && (
                <span className="text-xs text-gray-500">/ min: {item.min_quantity}</span>
              )}
            </div>
            <input
              type="number"
              min="0"
              step="1"
              value={qtyDelta}
              onChange={e => setQtyDelta(e.target.value)}
              placeholder="Quantité"
              className="w-28 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            />
            <button
              onClick={() => applyDelta(-1)}
              disabled={adjusting || !qtyDelta}
              className="flex items-center gap-1 px-3 py-2 bg-red-900/40 border border-red-700 text-red-300 hover:bg-red-900/60 rounded-lg text-sm transition-colors disabled:opacity-40"
            >
              <Minus size={14} /> Sortie
            </button>
            <button
              onClick={() => applyDelta(1)}
              disabled={adjusting || !qtyDelta}
              className="flex items-center gap-1 px-3 py-2 bg-emerald-900/40 border border-emerald-700 text-emerald-300 hover:bg-emerald-900/60 rounded-lg text-sm transition-colors disabled:opacity-40"
            >
              <Plus size={14} /> Entrée
            </button>
          </div>
          {isLow && (
            <div className="mt-3 flex items-center gap-2 text-sm text-amber-400 bg-amber-950/30 border border-amber-800/50 rounded-lg px-3 py-2">
              <AlertTriangle size={14} />
              Stock inférieur ou égal au seuil minimum ({item.min_quantity} {item.unit})
            </div>
          )}
        </div>

        {/* ── Details grid ── */}
        <div className="grid grid-cols-2 gap-4">
          {/* Classification */}
          <DetailCard title="Classification" icon={<Tag size={14} className="text-indigo-400" />}>
            <Field label="Catégorie">
              {editing ? (
                <input className={inputCls} value={draft.category ?? ''} onChange={e => setDraft(d => ({ ...d, category: e.target.value }))} />
              ) : (
                <span>{item.category || '—'}</span>
              )}
            </Field>
            <Field label="Classe de pièce">
              {editing ? (
                <input className={inputCls} value={draft.part_class ?? ''} onChange={e => setDraft(d => ({ ...d, part_class: e.target.value }))} />
              ) : (
                <span>{item.part_class || '—'}</span>
              )}
            </Field>
            <Field label="Unité">
              {editing ? (
                <select className={inputCls} value={draft.unit ?? 'Unitaire'} onChange={e => setDraft(d => ({ ...d, unit: e.target.value }))}>
                  {['Unitaire', 'Metre', 'Pied', 'Kg', 'L'].map(u => <option key={u}>{u}</option>)}
                </select>
              ) : (
                <span>{item.unit}</span>
              )}
            </Field>
          </DetailCard>

          {/* Location */}
          <DetailCard title="Emplacement" icon={<MapPin size={14} className="text-emerald-400" />}>
            <Field label="Entrepôt">
              {editing ? (
                <input className={inputCls} value={draft.warehouse ?? ''} onChange={e => setDraft(d => ({ ...d, warehouse: e.target.value }))} />
              ) : (
                <span className="font-mono">{item.warehouse || '—'}</span>
              )}
            </Field>
            <Field label="Localisation">
              {editing ? (
                <input className={inputCls} value={draft.location ?? ''} onChange={e => setDraft(d => ({ ...d, location: e.target.value }))} />
              ) : (
                <span className="font-mono">{item.location || '—'}</span>
              )}
            </Field>
          </DetailCard>

          {/* Reorder */}
          <DetailCard title="Réapprovisionnement" icon={<AlertTriangle size={14} className="text-amber-400" />}>
            <Field label="Stock minimum (seuil)">
              {editing ? (
                <input type="number" className={inputCls} value={draft.min_quantity ?? ''} onChange={e => setDraft(d => ({ ...d, min_quantity: e.target.value ? parseFloat(e.target.value) : null }))} />
              ) : (
                <span className={item.min_quantity != null ? 'font-semibold' : 'text-gray-500'}>{item.min_quantity ?? 'Non défini'}</span>
              )}
            </Field>
            <Field label="Coût unitaire">
              {editing ? (
                <input type="number" step="0.01" className={inputCls} value={draft.unit_cost ?? ''} onChange={e => setDraft(d => ({ ...d, unit_cost: e.target.value ? parseFloat(e.target.value) : null }))} />
              ) : (
                <span>{item.unit_cost != null ? `$${item.unit_cost.toFixed(2)}` : '—'}</span>
              )}
            </Field>
          </DetailCard>

          {/* Supplier */}
          <DetailCard title="Fournisseur" icon={<DollarSign size={14} className="text-purple-400" />}>
            <Field label="Fournisseur">
              {editing ? (
                <select
                  className={inputCls}
                  value={draft.supplier_id ?? ''}
                  onChange={e => setDraft(d => ({ ...d, supplier_id: e.target.value || null }))}
                >
                  <option value="">— Aucun —</option>
                  {suppliers.map(s => (
                    <option key={s.id} value={s.id}>{s.code ? `${s.code} · ` : ''}{s.name}</option>
                  ))}
                </select>
              ) : (
                <span>
                  {suppliers.find(s => s.id === item.supplier_id)?.name ?? '—'}
                </span>
              )}
            </Field>
          </DetailCard>
        </div>

        {/* Notes */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
            <Hash size={14} className="text-gray-400" />
            Notes
          </h3>
          {editing ? (
            <textarea
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500 resize-none"
              rows={4}
              value={draft.notes ?? ''}
              onChange={e => setDraft(d => ({ ...d, notes: e.target.value }))}
              placeholder="Notes internes…"
            />
          ) : (
            <p className="text-sm text-gray-400 whitespace-pre-wrap">
              {item.notes || <span className="italic text-gray-600">Aucune note</span>}
            </p>
          )}
        </div>

      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const inputCls =
  'w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-indigo-500';

function DetailCard({ title, icon, children }: {
  title: string; icon: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
      <h3 className="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">
        {icon} {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-xs text-gray-500 whitespace-nowrap pt-0.5 min-w-32">{label}</span>
      <div className="flex-1 text-sm text-gray-200 text-right">{children}</div>
    </div>
  );
}
