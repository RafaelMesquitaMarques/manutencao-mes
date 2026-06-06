import api from './axios';
import type { StopCategoryOut, StopSubcategoryOut } from '../types';

export const fetchAllCategories = async (): Promise<StopCategoryOut[]> => {
  const { data } = await api.get<StopCategoryOut[]>('/api/stop-categories/');
  return data;
};

export const createCategory = async (payload: {
  name: string; type: string; icon: string; color: string; sort_order: number;
}): Promise<StopCategoryOut> => {
  const { data } = await api.post<StopCategoryOut>('/api/stop-categories/', payload);
  return data;
};

export const updateCategory = async (
  id: string,
  payload: Partial<{ name: string; type: string; icon: string; color: string; is_active: boolean; sort_order: number }>,
): Promise<StopCategoryOut> => {
  const { data } = await api.patch<StopCategoryOut>(`/api/stop-categories/${id}`, payload);
  return data;
};

export const reorderCategories = async (
  items: { id: string; sort_order: number }[],
): Promise<StopCategoryOut[]> => {
  const { data } = await api.patch<StopCategoryOut[]>('/api/stop-categories/reorder', items);
  return data;
};

export const fetchSubcategories = async (catId: string): Promise<StopSubcategoryOut[]> => {
  const { data } = await api.get<StopSubcategoryOut[]>(`/api/stop-categories/${catId}/subcategories`);
  return data;
};

export const createSubcategory = async (
  catId: string,
  payload: { name: string; icon: string; color?: string; triggers_maintenance: boolean; sort_order: number },
): Promise<StopSubcategoryOut> => {
  const { data } = await api.post<StopSubcategoryOut>(`/api/stop-categories/${catId}/subcategories`, payload);
  return data;
};

export const updateSubcategory = async (
  subId: string,
  payload: Partial<{ name: string; icon: string; color: string; triggers_maintenance: boolean; is_active: boolean; sort_order: number }>,
): Promise<StopSubcategoryOut> => {
  const { data } = await api.patch<StopSubcategoryOut>(`/api/stop-categories/subcategories/${subId}`, payload);
  return data;
};
