// frontend/src/api/inventory.ts
import api from './axios';
import type {
  StockItem,
  StockItemListResponse,
  Supplier,
  InventoryCategories,
  InventoryDashboard,
} from '../types';

// ── Stock Items ──────────────────────────────────────────────────────────────

export interface StockItemFilters {
  search?: string;
  category?: string;
  part_class?: string;
  warehouse?: string;
  low_stock_only?: boolean;
  out_of_stock_only?: boolean;
  below_min_only?: boolean;
  /** true = carried on stock, false = bought on demand, undefined = either. */
  stockable?: boolean;
  /** Products retired in Interal are out of the catalogue unless asked for. */
  include_archived?: boolean;
  archived_only?: boolean;
  supplier_id?: string;
  skip?: number;
  limit?: number;
}

export async function fetchStockItems(
  filters: StockItemFilters = {}
): Promise<StockItemListResponse> {
  const params = new URLSearchParams();
  if (filters.search)        params.set('search', filters.search);
  if (filters.category)      params.set('category', filters.category);
  if (filters.part_class)    params.set('part_class', filters.part_class);
  if (filters.warehouse)     params.set('warehouse', filters.warehouse);
  if (filters.low_stock_only)    params.set('low_stock_only', 'true');
  if (filters.out_of_stock_only) params.set('out_of_stock_only', 'true');
  if (filters.below_min_only)    params.set('below_min_only', 'true');
  if (filters.stockable != null) params.set('stockable', String(filters.stockable));
  if (filters.include_archived)  params.set('include_archived', 'true');
  if (filters.archived_only)     params.set('archived_only', 'true');
  if (filters.supplier_id)   params.set('supplier_id', filters.supplier_id);
  if (filters.skip != null)  params.set('skip', String(filters.skip));
  if (filters.limit != null) params.set('limit', String(filters.limit));

  const { data } = await api.get(`/api/inventory/items?${params.toString()}`);
  return data;
}

export async function fetchStockItem(id: string): Promise<StockItem> {
  const { data } = await api.get(`/api/inventory/items/${id}`);
  return data;
}

export async function createStockItem(body: Partial<StockItem>): Promise<StockItem> {
  const { data } = await api.post('/api/inventory/items', body);
  return data;
}

export async function updateStockItem(id: string, body: Partial<StockItem>): Promise<StockItem> {
  const { data } = await api.patch(`/api/inventory/items/${id}`, body);
  return data;
}

export async function adjustQuantity(
  id: string,
  payload: { quantity?: number; delta?: number }
): Promise<StockItem> {
  const { data } = await api.patch(`/api/inventory/items/${id}/quantity`, payload);
  return data;
}

export async function deleteStockItem(id: string): Promise<void> {
  await api.delete(`/api/inventory/items/${id}`);
}

export async function fetchInventoryCategories(
  includeArchived = false
): Promise<InventoryCategories> {
  const suffix = includeArchived ? '?include_archived=true' : '';
  const { data } = await api.get(`/api/inventory/items/categories${suffix}`);
  return data;
}

export async function fetchInventoryDashboard(
  includeArchived = false
): Promise<InventoryDashboard> {
  const suffix = includeArchived ? '?include_archived=true' : '';
  const { data } = await api.get(`/api/inventory/dashboard${suffix}`);
  return data;
}

// ── Suppliers ────────────────────────────────────────────────────────────────

export async function fetchSuppliers(search?: string): Promise<{ total: number; items: Supplier[] }> {
  const params = search ? `?search=${encodeURIComponent(search)}` : '';
  const { data } = await api.get(`/api/inventory/suppliers${params}`);
  return data;
}

export async function createSupplier(body: Partial<Supplier>): Promise<Supplier> {
  const { data } = await api.post('/api/inventory/suppliers', body);
  return data;
}

export async function updateSupplier(id: string, body: Partial<Supplier>): Promise<Supplier> {
  const { data } = await api.patch(`/api/inventory/suppliers/${id}`, body);
  return data;
}
