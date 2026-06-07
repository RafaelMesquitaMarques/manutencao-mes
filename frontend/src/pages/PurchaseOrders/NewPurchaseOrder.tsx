import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { createPurchaseOrder, fetchSupplierList } from '../../api/suppliers';
import { fetchStockItems } from '../../api/inventory';
import type { Supplier, StockItem } from '../../types';

const inputCls  = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500';
const selectCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500';
const ALL_STATUSES = ['draft', 'sent', 'confirmed'];

interface LineItem {
  _key:         number;
  stock_item_id: string;
  description:  string;
  quantity:     string;
  unit_cost:    string;
  notes:        string;
}

function FormField({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1.5">
        {label}{required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

let keyCounter = 0;
function newLine(): LineItem {
  return { _key: ++keyCounter, stock_item_id: '', description: '', quantity: '1', unit_cost: '0', notes: '' };
}

export default function NewPurchaseOrder() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [stockItems, setStockItems] = useState<StockItem[]>([]);
  const [saving, setSaving] = useState(false);

  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    supplier_id:   searchParams.get('supplier_id') || '',
    order_date:    today,
    expected_date: '',
    currency:      'CAD',
    status:        'draft',
    notes:         '',
  });
  const [lines, setLines] = useState<LineItem[]>([newLine()]);

  useEffect(() => {
    Promise.all([
      fetchSupplierList({ active_only: true, limit: 200 }),
      fetchStockItems({ limit: 5500 }),
    ]).then(([supRes, stockRes]) => {
      setSuppliers(supRes.items);
      setStockItems(stockRes.items);
    });
  }, []);

  const setF = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const updateLine = (key: number, field: keyof LineItem, value: string) => {
    setLines(ls => ls.map(l => {
      if (l._key !== key) return l;
      const updated = { ...l, [field]: value };
      if (field === 'stock_item_id' && value) {
        const si = stockItems.find(s => s.id === value);
        if (si) {
          updated.description = si.description || si.name || si.code;
          updated.unit_cost   = si.unit_cost != null ? String(si.unit_cost) : l.unit_cost;
        }
      }
      return updated;
    }));
  };

  const removeLine = (key: number) => setLines(ls => ls.filter(l => l._key !== key));
  const addLine    = () => setLines(ls => [...ls, newLine()]);

  const lineTotal  = (l: LineItem) => (parseFloat(l.quantity) || 0) * (parseFloat(l.unit_cost) || 0);
  const grandTotal = lines.reduce((acc, l) => acc + lineTotal(l), 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.supplier_id) return;
    setSaving(true);
    try {
      const po = await createPurchaseOrder({
        supplier_id:   form.supplier_id,
        order_date:    form.order_date || undefined,
        expected_date: form.expected_date || undefined,
        currency:      form.currency,
        status:        form.status,
        notes:         form.notes || undefined,
        items: lines
          .filter(l => l.description.trim())
          .map(l => ({
            stock_item_id: l.stock_item_id || undefined,
            description:   l.description,
            quantity:      parseFloat(l.quantity) || 1,
            unit_cost:     parseFloat(l.unit_cost) || 0,
            notes:         l.notes || undefined,
          })),
      });
      navigate(`/supplier-orders/${po.id}`);
    } finally {
      setSaving(false);
    }
  };

  // Pre-select supplier if passed via query params
  const preItemId = searchParams.get('item_id');
  useEffect(() => {
    if (!preItemId || stockItems.length === 0) return;
    const si = stockItems.find(s => s.id === preItemId);
    if (!si) return;
    setLines([{
      _key: ++keyCounter,
      stock_item_id: si.id,
      description:   si.description || si.name || si.code,
      quantity:      '1',
      unit_cost:     si.unit_cost != null ? String(si.unit_cost) : '0',
      notes:         '',
    }]);
  }, [preItemId, stockItems]);

  return (
    <div className="bg-gray-950 text-gray-100 pb-12">
      <div className="sticky top-0 z-10 bg-gray-950/95 backdrop-blur border-b border-gray-800 px-6 py-3 flex items-center gap-3">
        <button onClick={() => navigate('/supplier-orders')} className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-gray-200">
          <ArrowLeft size={18} />
        </button>
        <span className="text-gray-500">/</span>
        <span className="text-sm text-gray-300 font-medium">{t('purchaseOrders.title', 'Purchase Orders')}</span>
        <span className="text-gray-500">/</span>
        <span className="text-sm text-gray-300">{t('purchaseOrders.newOrder', 'New Order')}</span>
      </div>

      <div className="max-w-3xl mx-auto px-6 pt-8">
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Header info */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-2">{t('purchaseOrders.orderDetails', 'Order Details')}</h2>
            <FormField label={t('suppliers.supplier', 'Supplier')} required>
              <select required value={form.supplier_id} onChange={e => setF('supplier_id', e.target.value)} className={selectCls}>
                <option value="">— {t('suppliers.selectSupplier', 'Select a supplier')} —</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.code ? `${s.code} · ` : ''}{s.name}</option>)}
              </select>
            </FormField>
            <div className="grid grid-cols-3 gap-4">
              <FormField label={t('purchaseOrders.orderDate', 'Order date')} required>
                <input required type="date" value={form.order_date} onChange={e => setF('order_date', e.target.value)} className={inputCls} />
              </FormField>
              <FormField label={t('purchaseOrders.expectedDate', 'Expected date')}>
                <input type="date" value={form.expected_date} onChange={e => setF('expected_date', e.target.value)} className={inputCls} />
              </FormField>
              <FormField label={t('purchaseOrders.status', 'Initial status')}>
                <select value={form.status} onChange={e => setF('status', e.target.value)} className={selectCls}>
                  {ALL_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </FormField>
            </div>
            <div className="grid grid-cols-4 gap-4">
              <FormField label={t('suppliers.currency', 'Currency')}>
                <select value={form.currency} onChange={e => setF('currency', e.target.value)} className={selectCls}>
                  {['CAD', 'USD', 'EUR'].map(c => <option key={c}>{c}</option>)}
                </select>
              </FormField>
              <div className="col-span-3">
                <FormField label={t('common.notes', 'Notes')}>
                  <input value={form.notes} onChange={e => setF('notes', e.target.value)} placeholder="Internal notes…" className={inputCls} />
                </FormField>
              </div>
            </div>
          </div>

          {/* Line items */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-gray-300">{t('purchaseOrders.items', 'Items')}</h2>
              <button type="button" onClick={addLine} className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-blue-300 bg-blue-900/30 border border-blue-800 hover:bg-blue-900/50 rounded-lg">
                <Plus size={12} /> {t('purchaseOrders.addLine', 'Add line')}
              </button>
            </div>

            <div className="space-y-3">
              {/* Column headers */}
              <div className="grid grid-cols-12 gap-2 text-xs text-gray-500 uppercase tracking-wider px-1">
                <div className="col-span-4">{t('purchaseOrders.stockItem', 'Stock item')}</div>
                <div className="col-span-4">{t('common.description', 'Description')} *</div>
                <div className="col-span-1 text-right">{t('purchaseOrders.qty', 'Qty')}</div>
                <div className="col-span-2 text-right">{t('purchaseOrders.unitCost', 'Unit cost')}</div>
                <div className="col-span-1"></div>
              </div>

              {lines.map((line, idx) => (
                <div key={line._key} className="grid grid-cols-12 gap-2 items-center bg-gray-800/30 border border-gray-700/50 rounded-lg px-3 py-2">
                  <div className="col-span-4">
                    <select
                      value={line.stock_item_id}
                      onChange={e => updateLine(line._key, 'stock_item_id', e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
                    >
                      <option value="">— Optional —</option>
                      {stockItems.map(s => <option key={s.id} value={s.id}>{s.code} — {(s.description || s.name || '').slice(0, 30)}</option>)}
                    </select>
                  </div>
                  <div className="col-span-4">
                    <input
                      required
                      value={line.description}
                      onChange={e => updateLine(line._key, 'description', e.target.value)}
                      placeholder="Description *"
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div className="col-span-1">
                    <input
                      type="number" min="0.01" step="0.01" required
                      value={line.quantity}
                      onChange={e => updateLine(line._key, 'quantity', e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 text-right focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div className="col-span-2">
                    <input
                      type="number" min="0" step="0.01" required
                      value={line.unit_cost}
                      onChange={e => updateLine(line._key, 'unit_cost', e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 text-right focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div className="col-span-1 flex items-center justify-end gap-1">
                    <span className="text-xs text-gray-500 font-mono min-w-14 text-right">${lineTotal(line).toFixed(2)}</span>
                    {lines.length > 1 && (
                      <button type="button" onClick={() => removeLine(line._key)} className="p-1 text-gray-600 hover:text-red-400">
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Total */}
            <div className="flex justify-end mt-4 pt-4 border-t border-gray-800">
              <div className="text-right">
                <div className="text-xs text-gray-500">{t('purchaseOrders.orderTotal', 'Order total')}</div>
                <div className="text-lg font-bold text-white font-mono">{form.currency} ${grandTotal.toFixed(2)}</div>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3 pb-4">
            <button type="button" onClick={() => navigate('/supplier-orders')} className="px-4 py-2 text-sm text-gray-300 bg-gray-800 border border-gray-700 hover:bg-gray-700 rounded-lg">
              {t('common.cancel')}
            </button>
            <button type="submit" disabled={saving || !form.supplier_id} className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded-lg disabled:opacity-50">
              <Save size={14} /> {saving ? t('common.saving', 'Saving…') : t('purchaseOrders.createOrder', 'Create Order')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
