// frontend/src/pages/Inventory/NewInventoryItem.tsx
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { createStockItem, fetchSuppliers } from '../../api/inventory';
import type { Supplier } from '../../types';

export default function NewInventoryItem() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [form, setForm] = useState({
    code: '',
    description: '',
    category: '',
    part_class: '',
    unit: 'Unitaire',
    quantity: '0',
    min_quantity: '',
    unit_cost: '',
    warehouse: '',
    location: '',
    supplier_id: '',
    notes: '',
  });

  useEffect(() => {
    fetchSuppliers().then(r => setSuppliers(r.items));
  }, []);

  const set = (key: string, val: string) => setForm(f => ({ ...f, [key]: val }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const item = await createStockItem({
        code: form.code,
        description: form.description,
        category: form.category || undefined,
        part_class: form.part_class || undefined,
        unit: form.unit,
        quantity: parseFloat(form.quantity) || 0,
        min_quantity: form.min_quantity ? parseFloat(form.min_quantity) : null,
        unit_cost: form.unit_cost ? parseFloat(form.unit_cost) : null,
        warehouse: form.warehouse || undefined,
        location: form.location || undefined,
        supplier_id: form.supplier_id || undefined,
        notes: form.notes || undefined,
      });
      navigate(`/inventory/${item.id}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-full bg-gray-950 text-gray-100 pb-12">
      <div className="sticky top-0 z-10 bg-gray-950/95 backdrop-blur border-b border-gray-800 px-6 py-3 flex items-center gap-3">
        <button onClick={() => navigate('/inventory')} className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-gray-200">
          <ArrowLeft size={18} />
        </button>
        <span className="text-sm text-gray-300 font-medium">{t('inventory.newItem', 'New item')}</span>
      </div>

      <div className="max-w-2xl mx-auto px-6 pt-8">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-2">Identification</h2>
            <FormField label={`${t('inventory.code', 'Part No.')} *`}>
              <input required value={form.code} onChange={e => set('code', e.target.value)}
                placeholder="PA-XXXXXXX" className={cls} />
            </FormField>
            <FormField label={t('inventory.description', 'Description')}>
              <textarea value={form.description} onChange={e => set('description', e.target.value)}
                rows={2} className={cls} placeholder="Full part description" />
            </FormField>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-2">Classification</h2>
            <div className="grid grid-cols-2 gap-4">
              <FormField label={t('inventory.category', 'Category')}>
                <input value={form.category} onChange={e => set('category', e.target.value)} className={cls} placeholder="mecanique, electrique…" />
              </FormField>
              <FormField label={t('inventory.partClass', 'Part Class')}>
                <input value={form.part_class} onChange={e => set('part_class', e.target.value)} className={cls} placeholder="bearing/roulement…" />
              </FormField>
            </div>
            <FormField label={t('inventory.unit', 'Unit')}>
              <select value={form.unit} onChange={e => set('unit', e.target.value)} className={cls}>
                {['Unitaire', 'Metre', 'Pied', 'Kg', 'L'].map(u => <option key={u}>{u}</option>)}
              </select>
            </FormField>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-2">Stock & Cost</h2>
            <div className="grid grid-cols-3 gap-4">
              <FormField label={t('inventory.quantity', 'Qty in stock')}>
                <input type="number" value={form.quantity} onChange={e => set('quantity', e.target.value)} className={cls} min="0" step="1" />
              </FormField>
              <FormField label={t('inventory.minQty', 'Min qty')}>
                <input type="number" value={form.min_quantity} onChange={e => set('min_quantity', e.target.value)} className={cls} min="0" placeholder="—" />
              </FormField>
              <FormField label={`${t('inventory.cost', 'Unit cost')} ($)`}>
                <input type="number" value={form.unit_cost} onChange={e => set('unit_cost', e.target.value)} className={cls} min="0" step="0.01" placeholder="—" />
              </FormField>
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-2">Location & Supplier</h2>
            <div className="grid grid-cols-2 gap-4">
              <FormField label={t('inventory.warehouse', 'Warehouse')}>
                <input value={form.warehouse} onChange={e => set('warehouse', e.target.value)} className={cls} placeholder="Mag1, A1…" />
              </FormField>
              <FormField label={t('inventory.location', 'Location')}>
                <input value={form.location} onChange={e => set('location', e.target.value)} className={cls} placeholder="Z4C, M3G…" />
              </FormField>
            </div>
            <FormField label="Supplier">
              <select value={form.supplier_id} onChange={e => set('supplier_id', e.target.value)} className={cls}>
                <option value="">— None —</option>
                {suppliers.map(s => (
                  <option key={s.id} value={s.id}>{s.code ? `${s.code} · ` : ''}{s.name}</option>
                ))}
              </select>
            </FormField>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
            <FormField label="Notes">
              <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={3} className={cls} placeholder="Internal notes…" />
            </FormField>
          </div>

          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => navigate('/inventory')} className="px-4 py-2 text-sm text-gray-300 bg-gray-800 border border-gray-700 hover:bg-gray-700 rounded-lg">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg disabled:opacity-50">
              <Save size={14} /> {saving ? 'Saving…' : 'Create item'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const cls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500';

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1.5">{label}</label>
      {children}
    </div>
  );
}
