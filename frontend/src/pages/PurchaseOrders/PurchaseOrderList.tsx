import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, RefreshCw, Package } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchPurchaseOrders, fetchPurchaseOrder, fetchSupplierList, receivePurchaseOrder } from '../../api/suppliers';
import type { PurchaseOrder, PurchaseOrderItem, Supplier } from '../../types';

const STATUS_STYLE: Record<string, string> = {
  draft:     'bg-gray-800 text-gray-300 border-gray-600',
  sent:      'bg-blue-900/50 text-blue-300 border-blue-700',
  confirmed: 'bg-green-900/50 text-green-300 border-green-700',
  received:  'bg-teal-900/50 text-teal-300 border-teal-700',
  cancelled: 'bg-red-900/50 text-red-400 border-red-700',
};
const ALL_STATUSES = ['draft', 'sent', 'confirmed', 'received', 'cancelled'];
const selectCls = 'bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 focus:outline-none focus:border-purple-500';
const inputCls  = 'bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 focus:outline-none focus:border-purple-500';

interface ReceiveModal {
  po: PurchaseOrder;
  quantities: Record<string, string>;
}

export default function PurchaseOrderList() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();

  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [receiving, setReceiving] = useState(false);
  const [receiveModal, setReceiveModal] = useState<ReceiveModal | null>(null);

  const [filters, setFilters] = useState({
    status:      searchParams.get('status') || '',
    supplier_id: searchParams.get('supplier_id') || '',
    date_from:   '',
    date_to:     '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ordRes, supRes] = await Promise.all([
        fetchPurchaseOrders({
          status:      filters.status      || undefined,
          supplier_id: filters.supplier_id || undefined,
          date_from:   filters.date_from   || undefined,
          date_to:     filters.date_to     || undefined,
          limit: 200,
        }),
        fetchSupplierList({ limit: 200 }),
      ]);
      setOrders(ordRes.items);
      setTotal(ordRes.total);
      setSuppliers(supRes.items);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  const set = (k: string, v: string) => setFilters(f => ({ ...f, [k]: v }));

  const openReceive = async (po: PurchaseOrder) => {
    const full = await fetchPurchaseOrder(po.id);
    const quantities: Record<string, string> = {};
    (full.items ?? []).forEach(item => { quantities[item.id] = String(item.quantity - item.received_quantity); });
    setReceiveModal({ po: full, quantities });
  };

  const handleReceive = async () => {
    if (!receiveModal) return;
    setReceiving(true);
    try {
      const items = (receiveModal.po.items ?? []).map(item => ({
        id: item.id,
        received_quantity: parseFloat(receiveModal.quantities[item.id] ?? '0') || 0,
      }));
      await receivePurchaseOrder(receiveModal.po.id, items);
      setReceiveModal(null);
      load();
    } finally {
      setReceiving(false);
    }
  };

  return (
    <div className="flex flex-col bg-gray-950 text-gray-100">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5 border-b border-gray-800">
        <div>
          <h1 className="text-xl font-semibold text-white">{t('purchaseOrders.title', 'Purchase Orders')}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{total} {t('purchaseOrders.orders', 'orders')}</p>
        </div>
        <button onClick={() => navigate('/supplier-orders/new')} className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded-xl">
          <Plus size={16} /> {t('purchaseOrders.newOrder', 'New Order')}
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-800 flex-wrap">
        <select value={filters.status} onChange={e => set('status', e.target.value)} className={selectCls}>
          <option value="">{t('purchaseOrders.allStatuses', 'All statuses')}</option>
          {ALL_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={filters.supplier_id} onChange={e => set('supplier_id', e.target.value)} className={selectCls}>
          <option value="">{t('suppliers.allSuppliers', 'All suppliers')}</option>
          {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input type="date" value={filters.date_from} onChange={e => set('date_from', e.target.value)} className={inputCls} title="From date" />
        <span className="text-gray-600 text-sm">→</span>
        <input type="date" value={filters.date_to} onChange={e => set('date_to', e.target.value)} className={inputCls} title="To date" />
        <button onClick={() => setFilters({ status: '', supplier_id: '', date_from: '', date_to: '' })} className="text-xs text-gray-500 hover:text-gray-300 px-2 py-2">
          {t('common.clearFilters', 'Clear')}
        </button>
        <button onClick={load} className="ml-auto p-2 text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded-lg">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        {loading && orders.length === 0 ? (
          <div className="py-24 text-center text-gray-500">{t('common.loading', 'Loading…')}</div>
        ) : orders.length === 0 ? (
          <div className="py-24 text-center text-gray-500">{t('purchaseOrders.noOrders', 'No purchase orders found')}</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3 text-left">PO #</th>
                <th className="px-4 py-3 text-left">{t('suppliers.supplier', 'Supplier')}</th>
                <th className="px-4 py-3 text-center">{t('purchaseOrders.status', 'Status')}</th>
                <th className="px-4 py-3 text-left">{t('purchaseOrders.orderDate', 'Order date')}</th>
                <th className="px-4 py-3 text-left">{t('purchaseOrders.expectedDate', 'Expected')}</th>
                <th className="px-4 py-3 text-center">{t('purchaseOrders.items', 'Items')}</th>
                <th className="px-4 py-3 text-right">{t('purchaseOrders.total', 'Total')}</th>
                <th className="px-4 py-3 text-center">{t('common.actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(po => (
                <tr key={po.id} className="border-b border-gray-800/60 hover:bg-gray-900/40 group">
                  <td className="px-4 py-3">
                    <button onClick={() => navigate(`/supplier-orders/${po.id}`)} className="font-mono text-xs text-blue-300 hover:text-blue-200 hover:underline">
                      {po.order_number}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-gray-200 text-sm">{po.supplier_name || '—'}</div>
                    {po.supplier_code && <div className="text-xs text-gray-500 font-mono">{po.supplier_code}</div>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2.5 py-0.5 rounded border text-xs font-medium ${STATUS_STYLE[po.status] ?? STATUS_STYLE.draft}`}>
                      {po.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{po.order_date}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{po.expected_date || '—'}</td>
                  <td className="px-4 py-3 text-center text-gray-400">{po.item_count}</td>
                  <td className="px-4 py-3 text-right text-gray-200 font-mono text-xs">
                    {po.total_amount != null ? `${po.currency} $${po.total_amount.toFixed(2)}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {(po.status === 'confirmed' || po.status === 'sent') && (
                      <button
                        onClick={() => openReceive(po)}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs text-teal-300 bg-teal-900/30 border border-teal-800 hover:bg-teal-900/50 rounded-lg mx-auto"
                      >
                        <Package size={12} /> {t('purchaseOrders.receive', 'Receive')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Receive modal */}
      {receiveModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
              <div>
                <h2 className="font-semibold text-white">{t('purchaseOrders.receiveOrder', 'Receive Order')}</h2>
                <p className="text-xs text-gray-500 mt-0.5 font-mono">{receiveModal.po.order_number}</p>
              </div>
              <button onClick={() => setReceiveModal(null)} className="text-gray-500 hover:text-gray-300 text-xl leading-none">×</button>
            </div>
            <div className="px-5 py-4 space-y-3 max-h-72 overflow-y-auto">
              {(receiveModal.po.items ?? []).length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-4">{t('purchaseOrders.loadingItems', 'Loading items…')}</p>
              ) : (
                (receiveModal.po.items ?? []).map(item => (
                  <div key={item.id} className="flex items-center gap-3 bg-gray-800/50 rounded-lg p-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-200 truncate">{item.description}</p>
                      <p className="text-xs text-gray-500">Ordered: {item.quantity} | Already received: {item.received_quantity}</p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <label className="text-xs text-gray-500">Qty:</label>
                      <input
                        type="number"
                        min="0"
                        max={item.quantity - item.received_quantity}
                        step="0.01"
                        value={receiveModal.quantities[item.id] ?? ''}
                        onChange={e => setReceiveModal(m => m ? { ...m, quantities: { ...m.quantities, [item.id]: e.target.value } } : null)}
                        className="w-20 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-teal-500"
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="px-5 py-4 border-t border-gray-800 flex justify-end gap-3">
              <button onClick={() => setReceiveModal(null)} className="px-3 py-1.5 text-sm text-gray-300 bg-gray-800 border border-gray-700 hover:bg-gray-700 rounded-lg">
                {t('common.cancel')}
              </button>
              <button onClick={handleReceive} disabled={receiving} className="flex items-center gap-1.5 px-4 py-1.5 text-sm text-white bg-teal-600 hover:bg-teal-500 rounded-lg disabled:opacity-50">
                <Package size={14} /> {receiving ? t('common.saving', 'Saving…') : t('purchaseOrders.confirmReceive', 'Confirm Receipt')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
