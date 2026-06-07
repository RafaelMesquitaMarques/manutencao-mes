import api from './axios';
import type { Supplier, SupplierDashboard, PurchaseOrder, PurchaseOrderItem, StockItem } from '../types';

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
  notes?: string;
  status?: string;
  items?: { stock_item_id?: string; description: string; quantity: number; unit_cost: number; notes?: string }[];
}): Promise<PurchaseOrder> {
  const { data } = await api.post('/api/supplier-orders', body);
  return data;
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

export async function receivePurchaseOrder(orderId: string, items: { id: string; received_quantity: number }[]): Promise<PurchaseOrder> {
  const { data } = await api.patch(`/api/supplier-orders/${orderId}/receive`, { items });
  return data;
}
