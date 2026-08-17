import api from './axios';
import type { Supplier, SupplierDashboard, PurchaseOrder, PurchaseOrderItem, POAttachment, StockItem } from '../types';

// ── Suppliers ────────────────────────────────────────────────────────────────

export interface SupplierFilters {
  search?: string;
  category?: string;
  active_only?: boolean;
  skip?: number;
  limit?: number;
}

export async function fetchSupplierList(filters: SupplierFilters = {}): Promise<{ total: number; items: Supplier[] }> {
  const p = new URLSearchParams();
  if (filters.search)      p.set('search', filters.search);
  if (filters.category)    p.set('category', filters.category);
  if (filters.active_only) p.set('active_only', 'true');
  if (filters.skip != null) p.set('skip', String(filters.skip));
  if (filters.limit != null) p.set('limit', String(filters.limit));
  const { data } = await api.get(`/api/suppliers?${p}`);
  return data;
}

export async function fetchSupplierDashboard(): Promise<SupplierDashboard> {
  const { data } = await api.get('/api/suppliers/dashboard');
  return data;
}

export async function fetchSupplierById(id: string): Promise<Supplier> {
  const { data } = await api.get(`/api/suppliers/${id}`);
  return data;
}

export async function createSupplier(body: Partial<Supplier>): Promise<Supplier> {
  const { data } = await api.post('/api/suppliers', body);
  return data;
}

export async function updateSupplier(id: string, body: Partial<Supplier>): Promise<Supplier> {
  const { data } = await api.patch(`/api/suppliers/${id}`, body);
  return data;
}

export async function deactivateSupplier(id: string): Promise<void> {
  await api.delete(`/api/suppliers/${id}`);
}

export async function fetchSupplierItems(id: string, skip = 0, limit = 100): Promise<{ total: number; items: StockItem[] }> {
  const { data } = await api.get(`/api/suppliers/${id}/items?skip=${skip}&limit=${limit}`);
  return data;
}

export async function fetchSupplierOrders(id: string): Promise<{ total: number; items: PurchaseOrder[] }> {
  const { data } = await api.get(`/api/suppliers/${id}/orders`);
  return data;
}

// ── Purchase Orders ──────────────────────────────────────────────────────────

export interface POFilters {
  status?: string;
  supplier_id?: string;
  date_from?: string;
  date_to?: string;
  skip?: number;
  limit?: number;
}

export async function fetchPurchaseOrders(filters: POFilters = {}): Promise<{ total: number; items: PurchaseOrder[] }> {
  const p = new URLSearchParams();
  if (filters.status)      p.set('status', filters.status);
  if (filters.supplier_id) p.set('supplier_id', filters.supplier_id);
  if (filters.date_from)   p.set('date_from', filters.date_from);
  if (filters.date_to)     p.set('date_to', filters.date_to);
  if (filters.skip != null) p.set('skip', String(filters.skip));
  if (filters.limit != null) p.set('limit', String(filters.limit));
  const { data } = await api.get(`/api/supplier-orders?${p}`);
  return data;
}

export async function fetchPurchaseOrder(id: string): Promise<PurchaseOrder> {
  const { data } = await api.get(`/api/supplier-orders/${id}`);
  return data;
}

export async function createPurchaseOrder(body: {
  supplier_id: string;
  order_date?: string;
  expected_date?: string;
  currency?: string;
  cost_center?: string;
  scope?: 'opex' | 'capex';
  notes?: string;
  status?: string;
  items?: { stock_item_id?: string; description: string; quantity: number; unit_cost: number; notes?: string }[];
}): Promise<PurchaseOrder> {
  const { data } = await api.post('/api/supplier-orders', body);
  return data;
}

export interface POCostCenter { name: string; code: string | null }

export async function fetchPOCostCenters(): Promise<POCostCenter[]> {
  const { data } = await api.get('/api/supplier-orders/cost-centers');
  return Array.isArray(data) ? data : [];
}

export async function updatePurchaseOrder(id: string, body: Partial<PurchaseOrder>): Promise<PurchaseOrder> {
  const { data } = await api.patch(`/api/supplier-orders/${id}`, body);
  return data;
}

export async function addPOItem(orderId: string, item: {
  stock_item_id?: string;
  description: string;
  quantity: number;
  unit_cost: number;
  notes?: string;
}): Promise<PurchaseOrderItem> {
  const { data } = await api.post(`/api/supplier-orders/${orderId}/items`, item);
  return data;
}

export async function updatePOItem(orderId: string, itemId: string, body: {
  stock_item_id?: string | null;
  description?: string;
  quantity?: number;
  unit_cost?: number;
  notes?: string | null;
}): Promise<PurchaseOrderItem> {
  const { data } = await api.patch(`/api/supplier-orders/${orderId}/items/${itemId}`, body);
  return data;
}

export async function deletePOItem(orderId: string, itemId: string): Promise<void> {
  await api.delete(`/api/supplier-orders/${orderId}/items/${itemId}`);
}

export async function receivePurchaseOrder(orderId: string, items: { id: string; received_quantity: number }[]): Promise<PurchaseOrder> {
  const { data } = await api.patch(`/api/supplier-orders/${orderId}/receive`, { items });
  return data;
}

// ── PO attachments (quotes / estimates / invoices) ───────────────────────────

export async function fetchPOAttachments(orderId: string): Promise<POAttachment[]> {
  const { data } = await api.get(`/api/supplier-orders/${orderId}/attachments`);
  return Array.isArray(data) ? data : [];
}

export async function uploadPOAttachment(orderId: string, file: File): Promise<POAttachment> {
  const fd = new FormData();
  fd.append('file', file);
  // The api instance defaults Content-Type to application/json; multipart must
  // be explicit so the browser sets the boundary (same pattern as api/uploads.ts).
  const { data } = await api.post(`/api/supplier-orders/${orderId}/attachments`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export async function deletePOAttachment(orderId: string, attachmentId: string): Promise<void> {
  await api.delete(`/api/supplier-orders/${orderId}/attachments/${attachmentId}`);
}

/** Download through the authenticated endpoint, restoring the original filename. */
export async function downloadPOAttachment(orderId: string, attachment: Pick<POAttachment, 'id' | 'original_name'>): Promise<void> {
  const { data } = await api.get(
    `/api/supplier-orders/${orderId}/attachments/${attachment.id}/download`,
    { responseType: 'blob' },
  );
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = attachment.original_name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Auto-replenishment ───────────────────────────────────────────────────────

export interface ReplenishmentItem {
  stock_item_id: string;
  code: string;
  description: string;
  quantity_in_stock: number;
  min_quantity: number | null;
  unit: string;
  unit_cost: number | null;
  suggested_quantity: number;
  estimated_cost: number | null;
}

export interface ReplenishmentGroup {
  supplier_id: string;
  supplier_name: string;
  supplier_code: string | null;
  currency: string;
  lead_time_days: number | null;
  items: ReplenishmentItem[];
  estimated_total: number;
}

export interface ReplenishmentPreview {
  groups: ReplenishmentGroup[];
  low_stock_total: number;
  orderable: number;
  already_ordered: number;
  without_supplier: number;
  without_supplier_sample: { stock_item_id: string; code: string; description: string; quantity_in_stock: number }[];
}

export async function fetchReplenishmentPreview(): Promise<ReplenishmentPreview> {
  const { data } = await api.get('/api/supplier-orders/replenishment/preview');
  return data;
}

export async function generateReplenishment(
  items: { stock_item_id: string; quantity: number }[],
  notes?: string,
): Promise<{ created: PurchaseOrder[]; skipped_no_supplier: number; skipped_already_ordered: number }> {
  const { data } = await api.post('/api/supplier-orders/replenishment/generate', { items, notes });
  return data;
}
