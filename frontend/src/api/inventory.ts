import api from './axios';
import type { StockItem, InventoryMovement } from '../types';

interface Paginated<T> { total: number; items: T[] }

export const fetchInventory = async (params?: {
  plant_id?: string;
  search?: string;
  low_stock?: boolean;
  skip?: number;
  limit?: number;
}): Promise<{ total: number; items: StockItem[] }> => {
  const { data } = await api.get<Paginated<StockItem>>('/api/inventory/', { params });
  return { total: data.total, items: data.items ?? [] };
};

export const fetchStockItem = async (id: string): Promise<StockItem> => {
  const { data } = await api.get<StockItem>(`/api/inventory/${id}`);
  return data;
};

export const createStockItem = async (payload: {
  plant_id: string;
  name: string;
  code?: string;
  description?: string;
  unit?: string;
  quantity?: number;
  min_quantity?: number;
  location?: string;
  unit_cost?: number;
  supplier?: string;
}): Promise<StockItem> => {
  const { data } = await api.post<StockItem>('/api/inventory/', payload);
  return data;
};

export const updateStockItem = async (id: string, payload: Partial<{
  name: string;
  code: string;
  description: string;
  unit: string;
  quantity: number;
  min_quantity: number;
  location: string;
  unit_cost: number;
  supplier: string;
}>): Promise<StockItem> => {
  const { data } = await api.patch<StockItem>(`/api/inventory/${id}`, payload);
  return data;
};

export const deleteStockItem = async (id: string): Promise<void> => {
  await api.delete(`/api/inventory/${id}`);
};

export const addStock = async (id: string, quantity: number, notes?: string): Promise<StockItem> => {
  const { data } = await api.post<StockItem>(`/api/inventory/${id}/add`, { quantity, notes });
  return data;
};

export const adjustStock = async (id: string, quantity: number, notes?: string): Promise<StockItem> => {
  const { data } = await api.post<StockItem>(`/api/inventory/${id}/adjust`, { quantity, notes });
  return data;
};

export const fetchMovements = async (
  itemId: string,
  params?: { skip?: number; limit?: number }
): Promise<{ total: number; items: InventoryMovement[] }> => {
  const { data } = await api.get<Paginated<InventoryMovement>>(
    `/api/inventory/${itemId}/movements`,
    { params }
  );
  return { total: data.total, items: data.items ?? [] };
};
