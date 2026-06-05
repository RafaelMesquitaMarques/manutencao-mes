import api from './axios';
import type {
  WorkOrder,
  WorkOrderCreate,
  DashboardStats,
  Equipment,
  Technician,
} from '../types';

interface PaginatedResponse<T> {
  total: number;
  items: T[];
}

export const fetchWorkOrders = async (
  params?: Record<string, string>
): Promise<WorkOrder[]> => {
  const { data } = await api.get<PaginatedResponse<WorkOrder> | WorkOrder[]>('/api/wo/', { params });
  return Array.isArray(data) ? data : (data.items ?? []);
};

export const fetchWorkOrder = async (id: string): Promise<WorkOrder> => {
  const { data } = await api.get<WorkOrder>(`/api/wo/${id}`);
  return data;
};

export const createWorkOrder = async (payload: WorkOrderCreate): Promise<WorkOrder> => {
  const { data } = await api.post<WorkOrder>('/api/wo/', payload);
  return data;
};

export const updateWorkOrderStatus = async (
  id: string,
  status: string,
  repairHours?: number
): Promise<WorkOrder> => {
  const { data } = await api.patch<WorkOrder>(`/api/wo/${id}`, {
    status,
    tempo_reparo_h: repairHours,
  });
  return data;
};

export const fetchDashboardStats = async (): Promise<DashboardStats> => {
  const { data } = await api.get<DashboardStats>('/api/wo/dashboard');
  return data;
};

export const fetchEquipment = async (): Promise<Equipment[]> => {
  const { data } = await api.get<PaginatedResponse<Equipment> | Equipment[]>('/api/equipment/');
  return Array.isArray(data) ? data : (data.items ?? []);
};

export const fetchTechnicians = async (): Promise<Technician[]> => {
  try {
    const { data } = await api.get<{ id: string; nome: string; email: string }[]>('/api/users/');
    return data.map((u) => ({ id: u.id, full_name: u.nome, email: u.email }));
  } catch {
    return [];
  }
};
