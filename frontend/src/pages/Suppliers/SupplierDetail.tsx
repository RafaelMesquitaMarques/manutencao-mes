import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Building2, Edit2, Save, X, Star,
  Package, ShoppingCart, AlertTriangle, CheckCircle2,
  Phone, Mail, Globe, MapPin, Clock, CreditCard, Hash,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  fetchSupplierById, updateSupplier, deactivateSupplier,
  fetchSupplierItems, fetchSupplierOrders,
} from '../../api/suppliers';
import type { Supplier, StockItem, PurchaseOrder } from '../../types';

const PO_STATUS_STYLE: Record<string, string> = {
  draft:     'bg-gray-800 text-gray-300 border-gray-600',
  sent:      'bg-blue-900/50 text-blue-300 border-blue-700',
  confirmed: 'bg-green-900/50 text-green-300 border-green-700',
  received:  'bg-teal-900/50 text-teal-300 border-teal-700',
  cancelled: 'bg-red-900/50 text-red-400 border-red-700',
};

function RatingStars({ value, onChange }: { value: number | null; onChange?: (n: number) => void }) {
  return (
    <span className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(n => (
        <Star
          key={n}
          size={14}
          onClick={() => onChange?.(n)}
          className={`${n <= (value ?? 0) ? 'text-amber-400 fill-amber-400' : 'text-gray-600'} ${onChange ? 'cursor-pointer hover:text-amber-300' : ''}`}
        />
      ))}
    </span>
  );
}

const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-purple-500';
const CATEGORIES = ['Parts', 'Tools', 'Raw Materials', 'Electrical', 'Safety', 'Services', 'Other'];
const CURRENCIES = ['CAD', 'USD', 'EUR'];
const TERMS      = ['Net 30', 'Net 60', 'Net 90', 'Prepaid', 'COD'];

export default function SupplierDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [draft, setDraft] = useState<Partial<Supplier>>({});
  const [items, setItems] = useState<StockItem[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'info' | 'items' | 'orders'>('info');

  useEffect(() => {
    if (!id) return;
    Promise.all([
      fetchSupplierById(id),
      fetchSupplierItems(id),
      fetchSupplierOrders(id),
    ]).then(([sup, its, ords]) => {
      setSupplier(sup);
      setDraft(sup);
      setItems(its.items);
      setOrders(ords.items);
      setLoading(false);
    });
  }, [id]);

  const startEdit = () => { setDraft({ ...supplier }); setEditing(true); };
  const cancelEdit = () => { setDraft({ ...supplier }); setEditing(false); };
  const set = (k: keyof Supplier, v: unknown) => setDraft(d => ({ ...d, [k]: v }));

  const saveEdit = async () => {
    if (!id || !supplier) return;
    setSaving(true);
    try {
      const updated = await updateSupplier(id, draft);
      setSupplier(updated);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = async () => {
    if (!id) return;
    if (!confirm('Deactivate this supplier?')) return;
    await deactivateSupplier(id);
    navigate('/suppliers');
  };

  if (loading) return <div className="flex items-center justify-center h-full bg-gray-950 text-gray-400">Loading…</div>;
  if (!supplier) return <div className="flex items-center justify-center h-full bg-gray-950 text-gray-400">Supplier not found.</div>;

  return (
    <div className="flex flex-col bg-gray-950 text-gray-100 pb-12">
      {/* Top bar */}
      <div className="sticky top-0 z-10 bg-gray-950/95 backdrop-blur border-b border-gray-800 px-6 py-3 flex items-center gap-3">
        <button onClick={() => navigate('/suppliers')} className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-gray-200">
          <ArrowLeft size={18} />
        </button>
        <span className="text-gray-500">/</span>
        <span className="text-sm text-gray-300 font-medium">{t('suppliers.title', 'Suppliers')}</span>
        <span className="text-gray-500">/</span>
        <span className="font-mono text-sm text-purple-300">{supplier.code || supplier.name}</span>
        <div className="ml-auto flex items-center gap-2">
          {editing ? (
            <>
              <button onClick={cancelEdit} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-300 bg-gray-800 border border-gray-700 hover:bg-gray-700 rounded-lg">
                <X size={14} /> {t('common.cancel')}
              </button>
              <button onClick={saveEdit} disabled={saving} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white bg-purple-600 hover:bg-purple-500 rounded-lg disabled:opacity-50">
                <Save size={14} /> {saving ? t('common.save') + '…' : t('common.save')}
              </button>
            </>
          ) : (
            <>
              <button onClick={startEdit} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-300 bg-gray-800 border border-gray-700 hover:bg-gray-700 rounded-lg">
                <Edit2 size={14} /> {t('common.edit')}
              </button>
              {supplier.is_active && (
                <button onClick={handleDeactivate} className="px-3 py-1.5 text-sm text-red-400 hover:text-red-300 hover:bg-red-950/30 rounded-lg border border-red-900/50">
                  {t('suppliers.deactivate', 'Deactivate')}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Hero */}
      <div className="px-6 pt-5 pb-4">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              {supplier.code && <span className="font-mono text-xs text-purple-400 bg-purple-950/50 border border-purple-800 px-2 py-0.5 rounded">{supplier.code}</span>}
              {supplier.category && <span className="text-xs text-gray-400 bg-gray-800 border border-gray-700 px-2 py-0.5 rounded">{supplier.category}</span>}
              <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${supplier.is_active ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800' : 'bg-gray-800 text-gray-500 border-gray-700'}`}>
                {supplier.is_active ? t('suppliers.active', 'Active') : t('suppliers.inactive', 'Inactive')}
              </span>
            </div>
            {editing ? (
              <input className="text-xl font-semibold bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white focus:outline-none focus:border-purple-500 w-96 mt-1"
                value={draft.name ?? ''} onChange={e => set('name', e.target.value)} />
            ) : (
              <h2 className="text-xl font-semibold text-white mt-1">{supplier.name}</h2>
            )}
            <RatingStars value={editing ? (draft.rating ?? null) : supplier.rating} onChange={editing ? n => set('rating', n) : undefined} />
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <Stat label="Items" value={String(supplier.item_count ?? 0)} icon={<Package size={14} className="text-indigo-400" />} />
            <Stat label="Orders" value={String(supplier.order_count ?? 0)} icon={<ShoppingCart size={14} className="text-blue-400" />} />
            <Stat label="Open POs" value={String(supplier.open_order_count ?? 0)} icon={<AlertTriangle size={14} className="text-amber-400" />} />
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-6 border-b border-gray-800 flex gap-0">
        {(['info', 'items', 'orders'] as const).map(tk => (
          <button key={tk} onClick={() => setTab(tk)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === tk ? 'text-purple-300 border-purple-500' : 'text-gray-500 border-transparent hover:text-gray-300'}`}
          >
            {tk === 'info' ? t('suppliers.tabInfo', 'Info') : tk === 'items' ? `${t('suppliers.tabItems', 'Items')} (${items.length})` : `${t('suppliers.tabOrders', 'Orders')} (${orders.length})`}
          </button>
        ))}
      </div>

      <div className="px-6 pt-5">
        {/* ── Info Tab ── */}
        {tab === 'info' && (
          <div className="grid grid-cols-2 gap-4">
            {/* Contact */}
            <DetailCard title={t('suppliers.contactInfo', 'Contact')} icon={<Phone size={14} className="text-purple-400" />}>
              <Field label={t('suppliers.contact', 'Contact name')}>
                {editing ? <input className={inputCls} value={draft.contact_name ?? ''} onChange={e => set('contact_name', e.target.value)} /> : <span>{supplier.contact_name || '—'}</span>}
              </Field>
              <Field label={t('suppliers.email', 'Email')}>
                {editing ? <input className={inputCls} value={draft.email ?? ''} onChange={e => set('email', e.target.value)} /> : <span>{supplier.email || '—'}</span>}
              </Field>
              <Field label={t('suppliers.phone', 'Phone')}>
                {editing ? <input className={inputCls} value={draft.phone ?? ''} onChange={e => set('phone', e.target.value)} /> : <span>{supplier.phone || '—'}</span>}
              </Field>
              <Field label="Fax">
                {editing ? <input className={inputCls} value={draft.fax ?? ''} onChange={e => set('fax', e.target.value)} /> : <span>{supplier.fax || '—'}</span>}
              </Field>
              <Field label="Website">
                {editing ? <input className={inputCls} value={draft.website ?? ''} onChange={e => set('website', e.target.value)} /> : (
                  supplier.website ? <a href={supplier.website} target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300 text-xs">{supplier.website}</a> : <span>—</span>
                )}
              </Field>
            </DetailCard>

            {/* Classification */}
            <DetailCard title={t('suppliers.classification', 'Classification')} icon={<Hash size={14} className="text-indigo-400" />}>
              <Field label="Code">
                {editing ? <input className={inputCls} value={draft.code ?? ''} onChange={e => set('code', e.target.value)} placeholder="SUP-XXX" /> : <span className="font-mono">{supplier.code || '—'}</span>}
              </Field>
              <Field label={t('suppliers.category', 'Category')}>
                {editing ? (
                  <select className={inputCls} value={draft.category ?? ''} onChange={e => set('category', e.target.value)}>
                    <option value="">— None —</option>
                    {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                  </select>
                ) : <span>{supplier.category || '—'}</span>}
              </Field>
              <Field label={t('suppliers.currency', 'Currency')}>
                {editing ? (
                  <select className={inputCls} value={draft.currency ?? 'CAD'} onChange={e => set('currency', e.target.value)}>
                    {CURRENCIES.map(c => <option key={c}>{c}</option>)}
                  </select>
                ) : <span>{supplier.currency}</span>}
              </Field>
              <Field label={t('suppliers.paymentTerms', 'Payment terms')}>
                {editing ? (
                  <select className={inputCls} value={draft.payment_terms ?? ''} onChange={e => set('payment_terms', e.target.value)}>
                    <option value="">— None —</option>
                    {TERMS.map(t => <option key={t}>{t}</option>)}
                  </select>
                ) : <span>{supplier.payment_terms || '—'}</span>}
              </Field>
              <Field label={t('suppliers.leadTime', 'Lead time (days)')}>
                {editing ? <input type="number" min="0" className={inputCls} value={draft.lead_time_days ?? ''} onChange={e => set('lead_time_days', e.target.value ? parseInt(e.target.value) : null)} /> : <span>{supplier.lead_time_days != null ? `${supplier.lead_time_days} days` : '—'}</span>}
              </Field>
            </DetailCard>

            {/* Address */}
            <DetailCard title={t('suppliers.address', 'Address')} icon={<MapPin size={14} className="text-emerald-400" />}>
              <Field label={t('suppliers.addressLine', 'Address')}>
                {editing ? <textarea className={inputCls} rows={2} value={draft.address ?? ''} onChange={e => set('address', e.target.value)} /> : <span>{supplier.address || '—'}</span>}
              </Field>
              <Field label={t('suppliers.city', 'City')}>
                {editing ? <input className={inputCls} value={draft.city ?? ''} onChange={e => set('city', e.target.value)} /> : <span>{supplier.city || '—'}</span>}
              </Field>
              <Field label={t('suppliers.country', 'Country')}>
                {editing ? <input className={inputCls} value={draft.country ?? ''} onChange={e => set('country', e.target.value)} /> : <span>{supplier.country || '—'}</span>}
              </Field>
            </DetailCard>

            {/* Notes */}
            <DetailCard title={t('common.notes', 'Notes')} icon={<CreditCard size={14} className="text-gray-400" />}>
              {editing ? (
                <textarea className={inputCls + ' resize-none'} rows={5} value={draft.notes ?? ''} onChange={e => set('notes', e.target.value)} placeholder="Internal notes…" />
              ) : (
                <p className="text-sm text-gray-400 whitespace-pre-wrap">{supplier.notes || <span className="italic text-gray-600">No notes</span>}</p>
              )}
            </DetailCard>
          </div>
        )}

        {/* ── Items Tab ── */}
        {tab === 'items' && (
          <div>
            {items.length === 0 ? (
              <div className="py-16 text-center text-gray-500">{t('suppliers.noItems', 'No inventory items linked to this supplier')}</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                    <th className="px-3 py-3 text-left">Code</th>
                    <th className="px-3 py-3 text-left">Description</th>
                    <th className="px-3 py-3 text-left">Category</th>
                    <th className="px-3 py-3 text-center">Stock</th>
                    <th className="px-3 py-3 text-center">Min</th>
                    <th className="px-3 py-3 text-right">Unit cost</th>
                    <th className="px-3 py-3 text-left">Supplier code</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => (
                    <tr key={item.id} onClick={() => navigate(`/inventory/${item.id}`)} className="border-b border-gray-800/50 hover:bg-gray-900/50 cursor-pointer">
                      <td className="px-3 py-2.5 font-mono text-xs text-indigo-300">{item.code}</td>
                      <td className="px-3 py-2.5 text-gray-200 max-w-xs truncate">{item.description || item.name || '—'}</td>
                      <td className="px-3 py-2.5 text-gray-400 text-xs">{item.category || '—'}</td>
                      <td className="px-3 py-2.5 text-center">
                        <span className={`font-mono text-sm font-semibold ${item.is_low_stock ? 'text-red-400' : 'text-emerald-400'}`}>{item.quantity}</span>
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-500 text-xs">{item.min_quantity ?? '—'}</td>
                      <td className="px-3 py-2.5 text-right text-gray-400 text-xs">{item.unit_cost != null ? `$${item.unit_cost.toFixed(2)}` : '—'}</td>
                      <td className="px-3 py-2.5 font-mono text-xs text-gray-500">{item.supplier_code || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── Orders Tab ── */}
        {tab === 'orders' && (
          <div>
            <div className="flex justify-end mb-4">
              <button
                onClick={() => navigate(`/supplier-orders/new?supplier_id=${supplier.id}`)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded-lg"
              >
                <Plus size={14} /> {t('suppliers.newPO', 'New Purchase Order')}
              </button>
            </div>
            {orders.length === 0 ? (
              <div className="py-16 text-center text-gray-500">{t('suppliers.noOrders', 'No purchase orders yet')}</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                    <th className="px-3 py-3 text-left">PO #</th>
                    <th className="px-3 py-3 text-left">Date</th>
                    <th className="px-3 py-3 text-center">Status</th>
                    <th className="px-3 py-3 text-center">Items</th>
                    <th className="px-3 py-3 text-right">Total</th>
                    <th className="px-3 py-3 text-left">Expected</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map(po => (
                    <tr key={po.id} onClick={() => navigate(`/supplier-orders/${po.id}`)} className="border-b border-gray-800/50 hover:bg-gray-900/50 cursor-pointer">
                      <td className="px-3 py-2.5 font-mono text-xs text-blue-300">{po.order_number}</td>
                      <td className="px-3 py-2.5 text-gray-400 text-xs">{po.order_date}</td>
                      <td className="px-3 py-2.5 text-center">
                        <span className={`px-2 py-0.5 rounded border text-xs font-medium ${PO_STATUS_STYLE[po.status] ?? 'bg-gray-800 text-gray-300 border-gray-600'}`}>{po.status}</span>
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-400">{po.item_count}</td>
                      <td className="px-3 py-2.5 text-right text-gray-200 font-mono text-xs">{po.total_amount != null ? `$${po.total_amount.toFixed(2)}` : '—'}</td>
                      <td className="px-3 py-2.5 text-gray-400 text-xs">{po.expected_date || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Plus({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 5v14M5 12h14"/></svg>;
}

function Stat({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-xl px-4 py-3 min-w-[80px]">
      <div className="flex items-center justify-center gap-1 mb-1">{icon}<span className="text-xs text-gray-500">{label}</span></div>
      <div className="text-xl font-bold text-white text-center">{value}</div>
    </div>
  );
}

function DetailCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
      <h3 className="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">{icon}{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-xs text-gray-500 whitespace-nowrap pt-0.5 min-w-28">{label}</span>
      <div className="flex-1 text-sm text-gray-200 text-right">{children}</div>
    </div>
  );
}
