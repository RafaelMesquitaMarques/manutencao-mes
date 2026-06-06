import api from './axios';
import type {
  WorkOrder,
  WorkOrderCreate,
  DashboardStats,
  Equipment,
  Technician,
  TechnicianFull,
  TechnicianCreate,
  LaborRecord,
  WOPart,
  WOCost,
  WOCostSummary,
  WOAction,
  User,
  MaintenancePlan,
  KPISummary,
  BacklogData,
  MTTRItem,
  CostItem,
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

export const updateWorkOrder = async (id: string, payload: Partial<WorkOrderCreate & { status: string; executor_id: string | null }>): Promise<WorkOrder> => {
  const { data } = await api.patch<WorkOrder>(`/api/wo/${id}`, payload);
  return data;
};

export const startWorkOrder = async (id: string): Promise<WorkOrder> => {
  const { data } = await api.post<WorkOrder>(`/api/wo/${id}/start`);
  return data;
};

export const completeWorkOrder = async (id: string, repairHours?: number): Promise<WorkOrder> => {
  const params: Record<string, string> = {};
  if (repairHours != null) params.repair_hours = String(repairHours);
  const { data } = await api.post<WorkOrder>(`/api/wo/${id}/complete`, null, { params });
  return data;
};

export const assignWorkOrder = async (
  id: string,
  executor_id: string
): Promise<WorkOrder> => {
  const { data } = await api.patch<WorkOrder>(`/api/wo/${id}/assign`, { executor_id });
  return data;
};

export const scheduleWorkOrder = async (
  id: string,
  payload: {
    executor_id: string;
    scheduled_date: string;
    scheduled_start_time?: string;
    scheduled_end_time?: string;
  }
): Promise<WorkOrder> => {
  const { data } = await api.post<WorkOrder>(`/api/wo/${id}/schedule`, payload);
  return data;
};

export const updateWorkOrderStatus = async (
  id: string,
  status: string,
  repairHours?: number
): Promise<WorkOrder> => {
  const { data } = await api.patch<WorkOrder>(`/api/wo/${id}`, {
    status,
    repair_hours: repairHours,
  });
  return data;
};

export const fetchDashboardStats = async (): Promise<DashboardStats> => {
  const { data } = await api.get<DashboardStats>('/api/wo/dashboard');
  return data;
};

// ─── Equipment ────────────────────────────────────────────────────────────────

export const fetchEquipment = async (params?: Record<string, string>): Promise<Equipment[]> => {
  const { data } = await api.get<PaginatedResponse<Equipment> | Equipment[]>('/api/equipment/', { params });
  return Array.isArray(data) ? data : (data.items ?? []);
};

export const fetchEquipmentById = async (id: string): Promise<Equipment> => {
  const { data } = await api.get<Equipment>(`/api/equipment/${id}`);
  return data;
};

// ─── Technicians ─────────────────────────────────────────────────────────────

export const fetchTechnicians = async (): Promise<Technician[]> => {
  try {
    const { data } = await api.get<PaginatedResponse<TechnicianFull>>('/api/technicians/');
    return (data.items ?? []).map((t) => ({
      id: t.id,
      full_name: t.full_name ?? '',
      email: t.email ?? '',
    }));
  } catch {
    return [];
  }
};

export const fetchTechniciansFull = async (): Promise<TechnicianFull[]> => {
  const { data } = await api.get<PaginatedResponse<TechnicianFull>>('/api/technicians/');
  return data.items ?? [];
};

export const createTechnician = async (payload: TechnicianCreate): Promise<TechnicianFull> => {
  const { data } = await api.post<TechnicianFull>('/api/technicians/', payload);
  return data;
};

export const fetchUsers = async (): Promise<User[]> => {
  const { data } = await api.get<PaginatedResponse<User> | User[]>('/api/users/');
  return Array.isArray(data) ? data : (data.items ?? []);
};

// ─── WO sub-resources ─────────────────────────────────────────────────────────

export const fetchWOLabor = async (id: string): Promise<LaborRecord[]> => {
  const { data } = await api.get<PaginatedResponse<LaborRecord>>(`/api/wo/${id}/labor`);
  return data.items ?? [];
};

export const addWOLabor = async (
  id: string,
  payload: {
    technician_id: string;
    date: string;
    hours_worked: number;
    hourly_rate?: number;
    activity?: string;
    notes?: string;
  }
): Promise<LaborRecord> => {
  const { data } = await api.post<LaborRecord>(`/api/wo/${id}/labor`, payload);
  return data;
};

export const fetchWOParts = async (id: string): Promise<WOPart[]> => {
  const { data } = await api.get<PaginatedResponse<WOPart>>(`/api/wo/${id}/parts`);
  return data.items ?? [];
};

export const addWOPart = async (
  id: string,
  payload: {
    description: string;
    part_number?: string;
    quantity: number;
    unit?: string;
    unit_cost?: number;
    supplier?: string;
  }
): Promise<WOPart> => {
  const { data } = await api.post<WOPart>(`/api/wo/${id}/parts`, payload);
  return data;
};

export const fetchWOCosts = async (id: string): Promise<WOCost[]> => {
  const { data } = await api.get<PaginatedResponse<WOCost>>(`/api/wo/${id}/costs`);
  return data.items ?? [];
};

export const addWOCost = async (
  id: string,
  payload: {
    transaction_type: string;
    description: string;
    amount: number;
    currency?: string;
    date: string;
    reference?: string;
  }
): Promise<WOCost> => {
  const { data } = await api.post<WOCost>(`/api/wo/${id}/costs`, payload);
  return data;
};

export const fetchWOCostSummary = async (id: string): Promise<WOCostSummary> => {
  const { data } = await api.get<WOCostSummary>(`/api/wo/${id}/costs/summary`);
  return data;
};

export const fetchWOActions = async (id: string): Promise<WOAction[]> => {
  const { data } = await api.get<PaginatedResponse<WOAction>>(`/api/wo/${id}/actions`);
  return data.items ?? [];
};

export const addWOAction = async (
  id: string,
  payload: { action_type: string; content?: string }
): Promise<WOAction> => {
  const { data } = await api.post<WOAction>(`/api/wo/${id}/actions`, payload);
  return data;
};

// ─── Maintenance Plans ────────────────────────────────────────────────────────

export const fetchMaintenancePlans = async (equipment_id?: string): Promise<MaintenancePlan[]> => {
  const params = equipment_id ? { equipment_id } : undefined;
  const { data } = await api.get<MaintenancePlan[]>('/api/plans/', { params });
  return Array.isArray(data) ? data : [];
};

export const createMaintenancePlan = async (payload: {
  equipment_id: string;
  name: string;
  description?: string;
  trigger_type?: string;
  interval_days?: number;
  next_execution_at?: string;
}): Promise<MaintenancePlan> => {
  const { data } = await api.post<MaintenancePlan>('/api/plans/', payload);
  return data;
};

// ─── KPIs ─────────────────────────────────────────────────────────────────────

export const fetchKPISummary = async (period_days = 30): Promise<KPISummary> => {
  const { data } = await api.get<KPISummary>('/api/kpis/summary', { params: { period_days } });
  return data;
};

export const fetchBacklog = async (): Promise<BacklogData> => {
  const { data } = await api.get<BacklogData>('/api/kpis/backlog');
  return data;
};

export const fetchMTTR = async (period_days = 90): Promise<MTTRItem[]> => {
  const { data } = await api.get<MTTRItem[]>('/api/kpis/mttr', { params: { period_days } });
  return Array.isArray(data) ? data : [];
};

export const fetchCostByType = async (period_days = 30): Promise<CostItem[]> => {
  const { data } = await api.get<CostItem[]>('/api/kpis/cost', { params: { period_days } });
  return Array.isArray(data) ? data : [];
};
