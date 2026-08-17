import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Paperclip, Plus, Trash2, Save, Package, Send, CheckCircle2, XCircle,
  RotateCcw, ExternalLink, Check, Download,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  fetchPurchaseOrder, updatePurchaseOrder, fetchSupplierList, fetchPOCostCenters,
  addPOItem, updatePOItem, deletePOItem, receivePurchaseOrder,
  uploadPOAttachment, deletePOAttachment, downloadPOAttachment, type POCostCenter,
} from '../../api/suppliers';
import { fetchStockItems } from '../../api/inventory';
import type { PurchaseOrder, POAttachment, Supplier, StockItem } from '../../types';
import { PO_ATTACHMENT_ACCEPT, formatBytes, FileTypeIcon } from './attachmentUtils';

const STATUS_STYLE: Record<string, string> = {
  draft:     'bg-gray-800 text-gray-300 border-gray-600',
  sent:      'bg-blue-900/50 text-blue-300 border-blue-700',
  confirmed: 'bg-green-900/50 text-green-300 border-green-700',
  received:  'bg-teal-900/50 text-teal-300 border-teal-700',
  cancelled: 'bg-red-900/50 text-red-400 border-red-700',
};

const inputCls  = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed';
const selectCls = inputCls;
const KNOWN_ERRORS = ['po_received_locked', 'po_status_invalid', 'po_use_receive_endpoint', 'po_supplier_change_draft_only', 'po_item_not_found'];

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

interface RowEdit { description: string; quantity: string; unit_cost: string }
interface NewLine { stock_item_id: string; description: string; quantity: string; unit_cost: string }

const EMPTY_LINE: NewLine = { stock_item_id: '', description: '', quantity: '1', unit_cost: '0' };

export default function PurchaseOrderDetail() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();

  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [stockItems, setStockItems] = useState<StockItem[]>([]);
  const [costCenters, setCostCenters] = useState<POCostCenter[]>([]);

  const [form, setForm] = useState({
    supplier_id: '', order_date: '', expected_date: '',
    cost_center: '', scope: 'opex', currency: 'CAD', notes: '',
  });
  const [rows, setRows] = useState<Record<string, RowEdit>>({});
  const [newLine, setNewLine] = useState<NewLine>(EMPTY_LINE);
  const [addingLine, setAddingLine] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveQty, setReceiveQty] = useState<Record<string, string>>({});
  const [receiving, setReceiving] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const errMsg = useCallback((e: unknown): string => {
    const d = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    if (typeof d === 'string' && KNOWN_ERRORS.includes(d)) return t(`purchaseOrders.err.${d}`);
    if (typeof d === 'string' && d) return d;
    return t('purchaseOrders.saveError', 'Failed to save');
  }, [t]);

  const applyPo = useCallback((data: PurchaseOrder) => {
    setPo(data);
    setForm({
      supplier_id:   data.supplier_id,
      order_date:    data.order_date || '',
      expected_date: data.expected_date || '',
      cost_center:   data.cost_center || '',
      scope:         data.scope || 'opex',
      currency:      data.currency || 'CAD',
      notes:         data.notes || '',
    });
    const r: Record<string, RowEdit> = {};
    (data.items ?? []).forEach(i => {
      r[i.id] = { description: i.description, quantity: String(i.quantity), unit_cost: String(i.unit_cost) };
    });
    setRows(r);
  }, []);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      applyPo(await fetchPurchaseOrder(id));
    } catch (e) {
      if ((e as { response?: { status?: number } })?.response?.status === 404) setNotFound(true);
    }
  }, [id, applyPo]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetchSupplierList({ limit: 200 }).then(r => setSuppliers(r.items)).catch(() => {});
    fetchStockItems({ limit: 5500 }).then(r => setStockItems(r.items)).catch(() => {});
    fetchPOCostCenters().then(setCostCenters).catch(() => {});
  }, []);

  useEffect(() => {
    if (!msg || msg.kind !== 'ok') return;
    const h = setTimeout(() => setMsg(null), 2500);
    return () => clearTimeout(h);
  }, [msg]);

  const editable = !!po && po.status !== 'received' && po.status !== 'cancelled';
  const isDraft  = po?.status === 'draft';

  const headerDirty = !!po && (
    form.supplier_id   !== po.supplier_id ||
    form.order_date    !== (po.order_date || '') ||
    form.expected_date !== (po.expected_date || '') ||
    form.cost_center   !== (po.cost_center || '') ||
    form.scope         !== (po.scope || 'opex') ||
    form.currency      !== (po.currency || 'CAD') ||
    form.notes         !== (po.notes || '')
  );

  const setF = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const saveHeader = async () => {
    if (!po) return;
    setSaving(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = {
        order_date:    form.order_date,
        expected_date: form.expected_date || null,
        cost_center:   form.cost_center || null,
        scope:         form.scope,
        currency:      form.currency,
        notes:         form.notes,
      };
      if (form.supplier_id !== po.supplier_id) body.supplier_id = form.supplier_id;
      applyPo(await updatePurchaseOrder(po.id, body));
      setMsg({ kind: 'ok', text: t('purchaseOrders.saved', 'Saved') });
    } catch (e) {
      setMsg({ kind: 'err', text: errMsg(e) });
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (status: string) => {
    if (!po) return;
    if (status === 'cancelled' && !window.confirm(t('purchaseOrders.confirmCancel', 'Cancel this purchase order?'))) return;
    setStatusBusy(true);
    setMsg(null);
    try {
      applyPo(await updatePurchaseOrder(po.id, { status } as Partial<PurchaseOrder>));
      setMsg({ kind: 'ok', text: t('purchaseOrders.saved', 'Saved') });
    } catch (e) {
      setMsg({ kind: 'err', text: errMsg(e) });
    } finally {
      setStatusBusy(false);
    }
  };

  const rowDirty = (itemId: string): boolean => {
    const item = po?.items?.find(i => i.id === itemId);
    const r = rows[itemId];
    if (!item || !r) return false;
    return r.description !== item.description
      || (parseFloat(r.quantity) || 0) !== item.quantity
      || (parseFloat(r.unit_cost) || 0) !== item.unit_cost;
  };

  const saveRow = async (itemId: string) => {
    if (!po) return;
    const r = rows[itemId];
    if (!r || !r.description.trim()) return;
    setMsg(null);
    try {
      await updatePOItem(po.id, itemId, {
        description: r.description,
        quantity:    parseFloat(r.quantity) || 0,
        unit_cost:   parseFloat(r.unit_cost) || 0,
      });
      await load();
      setMsg({ kind: 'ok', text: t('purchaseOrders.saved', 'Saved') });
    } catch (e) {
      setMsg({ kind: 'err', text: errMsg(e) });
    }
  };

  const removeRow = async (itemId: string) => {
    if (!po) return;
    if (!window.confirm(t('purchaseOrders.confirmRemoveLine', 'Remove this line?'))) return;
    setMsg(null);
    try {
      await deletePOItem(po.id, itemId);
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: errMsg(e) });
    }
  };

  const setRow = (itemId: string, field: keyof RowEdit, value: string) =>
    setRows(rs => ({ ...rs, [itemId]: { ...rs[itemId], [field]: value } }));

  const pickNewLineStock = (stockId: string) => {
    setNewLine(l => {
      const next = { ...l, stock_item_id: stockId };
      const si = stockItems.find(s => s.id === stockId);
      if (si) {
        next.description = si.description || si.name || si.code;
        if (si.unit_cost != null) next.unit_cost = String(si.unit_cost);
      }
      return next;
    });
  };

  const addLine = async () => {
    if (!po || !newLine.description.trim()) return;
    setAddingLine(true);
    setMsg(null);
    try {
      await addPOItem(po.id, {
        stock_item_id: newLine.stock_item_id || undefined,
        description:   newLine.description,
        quantity:      parseFloat(newLine.quantity) || 1,
        unit_cost:     parseFloat(newLine.unit_cost) || 0,
      });
      setNewLine(EMPTY_LINE);
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: errMsg(e) });
    } finally {
      setAddingLine(false);
    }
  };

  const openReceive = () => {
    if (!po) return;
    const q: Record<string, string> = {};
    (po.items ?? []).forEach(i => { q[i.id] = String(i.quantity - i.received_quantity); });
    setReceiveQty(q);
    setReceiveOpen(true);
  };

  const confirmReceive = async () => {
    if (!po) return;
    setReceiving(true);
    setMsg(null);
    try {
      const items = (po.items ?? []).map(i => ({
        id: i.id,
        received_quantity: parseFloat(receiveQty[i.id] ?? '0') || 0,
      }));
      applyPo(await receivePurchaseOrder(po.id, items));
      setReceiveOpen(false);
      setMsg({ kind: 'ok', text: t('purchaseOrders.receivedOk', 'Order received — stock updated') });
    } catch (e) {
      setMsg({ kind: 'err', text: errMsg(e) });
    } finally {
      setReceiving(false);
    }
  };

  // ── Attachments (quotes / estimates / invoices) ────────────────────────────

  const attachments: POAttachment[] = po?.attachments ?? [];

  const uploadErrorMessage = (e: unknown): string => {
    const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
    if (detail === 'po_attachment_type_not_allowed') return t('purchaseOrders.attachmentTypeNotAllowed');
    if (detail === 'po_attachment_too_large')        return t('purchaseOrders.attachmentTooLarge');
    return t('purchaseOrders.attachmentUploadFailed');
  };

  const handleFiles = async (files: FileList | null) => {
    if (!id || !files || files.length === 0) return;
    setUploading(true);
    setUploadError('');
    const errors: string[] = [];
    for (const file of Array.from(files)) {
      try {
        await uploadPOAttachment(id, file);
      } catch (e) {
        errors.push(`${file.name}: ${uploadErrorMessage(e)}`);
      }
    }
    if (errors.length) setUploadError(errors.join(' · '));
    await load();
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDeleteAttachment = async (att: POAttachment) => {
    if (!id) return;
    if (!window.confirm(t('purchaseOrders.attachmentDeleteConfirm'))) return;
    await deletePOAttachment(id, att.id);
    await load();
  };

  if (notFound) {
    return (
      <div className="bg-gray-950 text-gray-100 min-h-[60vh] flex flex-col items-center justify-center gap-4">
        <Package size={40} className="text-gray-700" />
        <p className="text-gray-400">{t('purchaseOrders.notFound', 'Purchase order not found')}</p>
        <button onClick={() => navigate('/supplier-orders')} className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded-lg">
          {t('purchaseOrders.backToList', 'Back to Purchase Orders')}
        </button>
      </div>
    );
  }

  if (!po) {
    return <div className="bg-gray-950 text-gray-100 min-h-[40vh] flex items-center justify-center text-gray-500">{t('common.loading', 'Loading…')}</div>;
  }

  const anyReceived = (po.items ?? []).some(i => i.received_quantity > 0);
  const showReceivedCol = anyReceived || po.status === 'received';
  const btnBase = 'flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border disabled:opacity-50';

  return (
    <div className="bg-gray-950 text-gray-100 pb-12">
      {/* Breadcrumb + status actions */}
      <div className="sticky top-0 z-10 bg-gray-950/95 backdrop-blur border-b border-gray-800 px-6 py-3 flex items-center gap-3 flex-wrap">
        <button onClick={() => navigate('/supplier-orders')} className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-gray-200" title={t('purchaseOrders.backToList', 'Back to Purchase Orders')}>
          <ArrowLeft size={18} />
        </button>
        <span className="text-gray-500">/</span>
        <span className="text-sm text-gray-300 font-medium">{t('purchaseOrders.title', 'Purchase Orders')}</span>
        <span className="text-gray-500">/</span>
        <span className="text-sm text-white font-mono">{po.order_number}</span>
        <span className={`px-2.5 py-0.5 rounded border text-xs font-medium ${STATUS_STYLE[po.status] ?? STATUS_STYLE.draft}`}>
          {t(`poStatus.${po.status}`, po.status)}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {po.status === 'draft' && (
            <button onClick={() => changeStatus('sent')} disabled={statusBusy} className={`${btnBase} text-blue-300 bg-blue-900/30 border-blue-800 hover:bg-blue-900/50`}>
              <Send size={14} /> {t('purchaseOrders.markSent', 'Mark as sent')}
            </button>
          )}
          {po.status === 'sent' && (
            <button onClick={() => changeStatus('confirmed')} disabled={statusBusy} className={`${btnBase} text-green-300 bg-green-900/30 border-green-800 hover:bg-green-900/50`}>
              <CheckCircle2 size={14} /> {t('purchaseOrders.confirmOrder', 'Confirm order')}
            </button>
          )}
          {(po.status === 'sent' || po.status === 'confirmed') && (
            <button onClick={openReceive} disabled={statusBusy} className={`${btnBase} text-teal-300 bg-teal-900/30 border-teal-800 hover:bg-teal-900/50`}>
              <Package size={14} /> {t('purchaseOrders.receive', 'Receive')}
            </button>
          )}
          {editable && (
            <button onClick={() => changeStatus('cancelled')} disabled={statusBusy} className={`${btnBase} text-red-300 bg-red-900/20 border-red-900 hover:bg-red-900/40`}>
              <XCircle size={14} /> {t('purchaseOrders.cancelOrder', 'Cancel order')}
            </button>
          )}
          {po.status === 'cancelled' && (
            <button onClick={() => changeStatus('draft')} disabled={statusBusy} className={`${btnBase} text-gray-300 bg-gray-800 border-gray-700 hover:bg-gray-700`}>
              <RotateCcw size={14} /> {t('purchaseOrders.reopenDraft', 'Reopen as draft')}
            </button>
          )}
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 pt-6 space-y-5">
        {/* Locked / cancelled banners + inline feedback */}
        {po.status === 'received' && (
          <div className="flex items-center gap-2 px-4 py-3 bg-teal-950/40 border border-teal-900 rounded-xl text-sm text-teal-200">
            <CheckCircle2 size={16} className="flex-shrink-0" />
            {t('purchaseOrders.receivedBanner', 'Received on {{date}} — this order is locked.', { date: po.received_date || '—' })}
          </div>
        )}
        {po.status === 'cancelled' && (
          <div className="flex items-center gap-2 px-4 py-3 bg-red-950/40 border border-red-900 rounded-xl text-sm text-red-300">
            <XCircle size={16} className="flex-shrink-0" />
            {t('purchaseOrders.cancelledBanner', 'This order is cancelled. Reopen it as draft to edit.')}
          </div>
        )}
        {msg && (
          <div className={`px-4 py-2.5 rounded-xl border text-sm ${msg.kind === 'ok' ? 'bg-green-950/40 border-green-900 text-green-300' : 'bg-red-950/40 border-red-900 text-red-300'}`}>
            {msg.text}
          </div>
        )}

        {/* Order details */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-300">{t('purchaseOrders.orderDetails', 'Order Details')}</h2>
            {editable && (
              <button
                onClick={saveHeader}
                disabled={!headerDirty || saving}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded-lg disabled:opacity-40"
              >
                <Save size={13} /> {saving ? t('common.saving', 'Saving…') : t('purchaseOrders.saveChanges', 'Save changes')}
              </button>
            )}
          </div>

          <FormField label={t('suppliers.supplier', 'Supplier')}>
            <div className="flex items-center gap-2">
              {isDraft ? (
                <select value={form.supplier_id} onChange={e => setF('supplier_id', e.target.value)} className={selectCls}>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.code ? `${s.code} · ` : ''}{s.name}</option>)}
                  {!suppliers.some(s => s.id === po.supplier_id) && (
                    <option value={po.supplier_id}>{po.supplier_code ? `${po.supplier_code} · ` : ''}{po.supplier_name}</option>
                  )}
                </select>
              ) : (
                <div className="flex-1 bg-gray-800/60 border border-gray-700/60 rounded-lg px-3 py-2 text-sm text-gray-200">
                  {po.supplier_code ? `${po.supplier_code} · ` : ''}{po.supplier_name || '—'}
                </div>
              )}
              <button
                onClick={() => navigate(`/suppliers/${form.supplier_id || po.supplier_id}`)}
                className="flex items-center gap-1 px-2.5 py-2 text-xs text-blue-300 hover:text-blue-200 bg-gray-800 border border-gray-700 rounded-lg whitespace-nowrap"
                title={t('purchaseOrders.viewSupplier', 'View supplier')}
              >
                <ExternalLink size={12} /> {t('purchaseOrders.viewSupplier', 'View supplier')}
              </button>
            </div>
          </FormField>

          <div className="grid grid-cols-3 gap-4">
            <FormField label={t('purchaseOrders.orderDate', 'Order date')}>
              <input type="date" disabled={!editable} value={form.order_date} onChange={e => setF('order_date', e.target.value)} className={inputCls} />
            </FormField>
            <FormField label={t('purchaseOrders.expectedDate', 'Expected date')}>
              <input type="date" disabled={!editable} value={form.expected_date} onChange={e => setF('expected_date', e.target.value)} className={inputCls} />
            </FormField>
            <FormField label={t('purchaseOrders.receivedDate', 'Received date')}>
              <div className="bg-gray-800/60 border border-gray-700/60 rounded-lg px-3 py-2 text-sm text-gray-400">{po.received_date || '—'}</div>
            </FormField>
          </div>

          <div className="grid grid-cols-4 gap-4">
            <FormField label={t('purchaseOrders.costCenter', 'Cost center')}>
              <select disabled={!editable} value={form.cost_center} onChange={e => setF('cost_center', e.target.value)} className={selectCls}>
                <option value="">— {t('purchaseOrders.selectCostCenter', 'Select a cost center')} —</option>
                {costCenters.map(cc => <option key={cc.name} value={cc.name}>{cc.code ? `${cc.code} · ${cc.name}` : cc.name}</option>)}
                {form.cost_center && !costCenters.some(cc => cc.name === form.cost_center) && (
                  <option value={form.cost_center}>{form.cost_center}</option>
                )}
              </select>
            </FormField>
            <FormField label={t('purchaseOrders.scope', 'Scope')}>
              <select disabled={!editable} value={form.scope} onChange={e => setF('scope', e.target.value)} className={selectCls}>
                <option value="opex">OPEX</option>
                <option value="capex">CAPEX</option>
              </select>
            </FormField>
            <FormField label={t('suppliers.currency', 'Currency')}>
              <select disabled={!editable} value={form.currency} onChange={e => setF('currency', e.target.value)} className={selectCls}>
                {['CAD', 'USD', 'EUR'].map(c => <option key={c}>{c}</option>)}
                {!['CAD', 'USD', 'EUR'].includes(form.currency) && <option value={form.currency}>{form.currency}</option>}
              </select>
            </FormField>
            <FormField label={t('common.notes', 'Notes')}>
              <input disabled={!editable} value={form.notes} onChange={e => setF('notes', e.target.value)} className={inputCls} />
            </FormField>
          </div>
        </div>

        {/* Items */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <h2 className="text-sm font-semibold text-gray-300 mb-4">
            {t('purchaseOrders.items', 'Items')} <span className="text-gray-600 font-normal">({(po.items ?? []).length})</span>
          </h2>

          <div className="space-y-2">
            {/* Column headers */}
            <div className="grid grid-cols-12 gap-2 text-xs text-gray-500 uppercase tracking-wider px-1">
              <div className="col-span-5">{t('common.description', 'Description')}</div>
              <div className="col-span-2 text-right">{t('purchaseOrders.qty', 'Qty')}</div>
              {showReceivedCol && <div className="col-span-1 text-right">{t('purchaseOrders.receivedQty', 'Received')}</div>}
              <div className="col-span-2 text-right">{t('purchaseOrders.unitCost', 'Unit cost')}</div>
              <div className="col-span-2 text-right">{t('purchaseOrders.total', 'Total')}</div>
              {!showReceivedCol && <div className="col-span-1"></div>}
            </div>

            {(po.items ?? []).length === 0 && (
              <div className="text-sm text-gray-500 text-center py-6">{t('purchaseOrders.noItems', 'No items on this order yet')}</div>
            )}

            {(po.items ?? []).map(item => {
              const r = rows[item.id] ?? { description: item.description, quantity: String(item.quantity), unit_cost: String(item.unit_cost) };
              const dirty = rowDirty(item.id);
              // A received order books the received value, not the ordered one.
              const lineTotal = po.status === 'received'
                ? item.received_quantity * item.unit_cost
                : (parseFloat(r.quantity) || 0) * (parseFloat(r.unit_cost) || 0);
              const stock = item.stock_item_id ? stockItems.find(s => s.id === item.stock_item_id) : null;
              return (
                <div key={item.id} className="grid grid-cols-12 gap-2 items-center bg-gray-800/30 border border-gray-700/50 rounded-lg px-3 py-2">
                  <div className="col-span-5">
                    {editable ? (
                      <input
                        value={r.description}
                        onChange={e => setRow(item.id, 'description', e.target.value)}
                        className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
                      />
                    ) : (
                      <span className="text-xs text-gray-200">{item.description}</span>
                    )}
                    {stock && (
                      <button
                        onClick={() => navigate(`/inventory/${stock.id}`)}
                        className="mt-0.5 block text-[11px] font-mono text-blue-400/80 hover:text-blue-300 hover:underline"
                      >
                        {stock.code}
                      </button>
                    )}
                  </div>
                  <div className="col-span-2">
                    {editable ? (
                      <input
                        type="number" min="0.01" step="0.01"
                        value={r.quantity}
                        onChange={e => setRow(item.id, 'quantity', e.target.value)}
                        className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 text-right focus:outline-none focus:border-blue-500"
                      />
                    ) : (
                      <div className="text-xs text-gray-300 text-right">{item.quantity}</div>
                    )}
                  </div>
                  {showReceivedCol && (
                    <div className="col-span-1 text-right text-xs text-teal-300 font-mono">{item.received_quantity}</div>
                  )}
                  <div className="col-span-2">
                    {editable ? (
                      <input
                        type="number" min="0" step="0.01"
                        value={r.unit_cost}
                        onChange={e => setRow(item.id, 'unit_cost', e.target.value)}
                        className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 text-right focus:outline-none focus:border-blue-500"
                      />
                    ) : (
                      <div className="text-xs text-gray-300 text-right font-mono">${item.unit_cost.toFixed(2)}</div>
                    )}
                  </div>
                  <div className="col-span-2 text-right text-xs text-gray-400 font-mono">
                    ${lineTotal.toFixed(2)}
                  </div>
                  {!showReceivedCol && (
                    <div className="col-span-1 flex items-center justify-end gap-1">
                      {editable && dirty && (
                        <button onClick={() => saveRow(item.id)} className="p-1 text-green-400 hover:text-green-300" title={t('common.save', 'Save')}>
                          <Check size={14} />
                        </button>
                      )}
                      {editable && (
                        <button onClick={() => removeRow(item.id)} className="p-1 text-gray-600 hover:text-red-400" title={t('purchaseOrders.removeLine', 'Remove line')}>
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Add line */}
            {editable && (
              <div className="grid grid-cols-12 gap-2 items-center border border-dashed border-gray-700 rounded-lg px-3 py-2 mt-2">
                <div className="col-span-3">
                  <select
                    value={newLine.stock_item_id}
                    onChange={e => pickNewLineStock(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
                  >
                    <option value="">— {t('purchaseOrders.optionalStockItem', 'Stock item (optional)')} —</option>
                    {stockItems.map(s => <option key={s.id} value={s.id}>{s.code} — {(s.description || s.name || '').slice(0, 30)}</option>)}
                  </select>
                </div>
                <div className="col-span-4">
                  <input
                    value={newLine.description}
                    onChange={e => setNewLine(l => ({ ...l, description: e.target.value }))}
                    placeholder={t('common.description', 'Description')}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div className="col-span-1">
                  <input
                    type="number" min="0.01" step="0.01"
                    value={newLine.quantity}
                    onChange={e => setNewLine(l => ({ ...l, quantity: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 text-right focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div className="col-span-2">
                  <input
                    type="number" min="0" step="0.01"
                    value={newLine.unit_cost}
                    onChange={e => setNewLine(l => ({ ...l, unit_cost: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 text-right focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div className="col-span-2 flex justify-end">
                  <button
                    onClick={addLine}
                    disabled={addingLine || !newLine.description.trim()}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-blue-300 bg-blue-900/30 border border-blue-800 hover:bg-blue-900/50 rounded-lg disabled:opacity-40"
                  >
                    <Plus size={12} /> {t('purchaseOrders.addLine', 'Add line')}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Total */}
          <div className="flex justify-end mt-4 pt-4 border-t border-gray-800">
            <div className="text-right">
              <div className="text-xs text-gray-500">{t('purchaseOrders.orderTotal', 'Order total')}</div>
              <div className="text-lg font-bold text-white font-mono">
                {po.currency} ${po.total_amount != null ? po.total_amount.toFixed(2) : '0.00'}
              </div>
            </div>
          </div>
        </div>

        {/* Attachments — quotes / estimates / invoices */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
              <Paperclip size={14} className="text-gray-500" />
              {t('purchaseOrders.attachments')}
              {attachments.length > 0 && <span className="text-xs text-gray-500 font-normal">({attachments.length})</span>}
            </h2>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-blue-300 bg-blue-900/30 border border-blue-800 hover:bg-blue-900/50 rounded-lg disabled:opacity-50"
            >
              <Plus size={12} /> {uploading ? t('common.saving', 'Saving…') : t('purchaseOrders.addFiles')}
            </button>
          </div>
          <p className="text-xs text-gray-500 mb-4">{t('purchaseOrders.attachmentsHint')}</p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={PO_ATTACHMENT_ACCEPT}
            className="hidden"
            onChange={e => handleFiles(e.target.files)}
          />

          {uploadError && <p className="text-xs text-red-400 mb-3">{uploadError}</p>}

          {attachments.length === 0 ? (
            <p className="text-sm text-gray-600 text-center py-6">{t('purchaseOrders.noAttachments')}</p>
          ) : (
            <div className="space-y-1.5">
              {attachments.map(att => (
                <div key={att.id} className="flex items-center gap-3 bg-gray-800/30 border border-gray-700/50 rounded-lg px-3 py-2 group">
                  <FileTypeIcon name={att.original_name} />
                  <div className="flex-1 min-w-0">
                    <button
                      onClick={() => downloadPOAttachment(po.id, att)}
                      className="text-sm text-gray-200 hover:text-blue-300 hover:underline truncate block max-w-full text-left"
                      title={att.original_name}
                    >
                      {att.original_name}
                    </button>
                    <p className="text-[11px] text-gray-500">
                      {formatBytes(att.size_bytes)}
                      {att.uploaded_by_name && <> · {att.uploaded_by_name}</>}
                      {att.created_at && <> · {new Date(att.created_at).toLocaleDateString()}</>}
                    </p>
                  </div>
                  <button
                    onClick={() => downloadPOAttachment(po.id, att)}
                    className="p-1.5 text-gray-500 hover:text-blue-300 hover:bg-gray-800 rounded"
                    title={t('purchaseOrders.download')}
                  >
                    <Download size={14} />
                  </button>
                  <button
                    onClick={() => handleDeleteAttachment(att)}
                    className="p-1.5 text-gray-600 hover:text-red-400 hover:bg-gray-800 rounded"
                    title={t('common.delete')}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Meta */}
        <p className="text-xs text-gray-600 px-1">
          {t('common.createdAt', 'Created')}: {po.created_at ? new Date(po.created_at).toLocaleString() : '—'}
          {po.updated_at && <> · {t('common.updatedAt', 'Updated')}: {new Date(po.updated_at).toLocaleString()}</>}
        </p>
      </div>

      {/* Receive modal */}
      {receiveOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
              <div>
                <h2 className="font-semibold text-white">{t('purchaseOrders.receiveOrder', 'Receive Order')}</h2>
                <p className="text-xs text-gray-500 mt-0.5 font-mono">{po.order_number}</p>
              </div>
              <button onClick={() => setReceiveOpen(false)} className="text-gray-500 hover:text-gray-300 text-xl leading-none">×</button>
            </div>
            <div className="px-5 py-4 space-y-3 max-h-72 overflow-y-auto">
              {(po.items ?? []).map(item => (
                <div key={item.id} className="flex items-center gap-3 bg-gray-800/50 rounded-lg p-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-200 truncate">{item.description}</p>
                    <p className="text-xs text-gray-500">
                      {t('purchaseOrders.orderedQty', 'Ordered')}: {item.quantity} · {t('purchaseOrders.receivedQty', 'Received')}: {item.received_quantity}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <label className="text-xs text-gray-500">{t('purchaseOrders.qty', 'Qty')}:</label>
                    <input
                      type="number" min="0" step="0.01"
                      max={item.quantity}
                      value={receiveQty[item.id] ?? ''}
                      onChange={e => setReceiveQty(q => ({ ...q, [item.id]: e.target.value }))}
                      className="w-20 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-teal-500"
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="px-5 py-4 border-t border-gray-800 flex justify-end gap-3">
              <button onClick={() => setReceiveOpen(false)} className="px-3 py-1.5 text-sm text-gray-300 bg-gray-800 border border-gray-700 hover:bg-gray-700 rounded-lg">
                {t('common.cancel', 'Cancel')}
              </button>
              <button onClick={confirmReceive} disabled={receiving} className="flex items-center gap-1.5 px-4 py-1.5 text-sm text-white bg-teal-600 hover:bg-teal-500 rounded-lg disabled:opacity-50">
                <Package size={14} /> {receiving ? t('common.saving', 'Saving…') : t('purchaseOrders.confirmReceive', 'Confirm Receipt')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
