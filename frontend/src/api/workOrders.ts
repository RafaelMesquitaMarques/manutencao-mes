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
  KPISummary,
  BacklogData,
  MTTRItem,
  CostItem,
  DowntimeParetoItem,
  OEETrendPoint,
  OEEByMachineItem,
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

/**
 * Fetches every work order (backend caps a page at 200). The first page also
 * reports the total, so the remaining pages are fetched concurrently instead of
 * one-after-another — turning ~42 serial round-trips into a few parallel waves.
 */
export const fetchAllWorkOrders = async (
  params?: Record<string, string>
): Promise<WorkOrder[]> => {
  const pageSize = 200;
  const getPage = (skip: number) =>
    api
      .get<PaginatedResponse<WorkOrder>>('/api/wo/', {
        params: { ...params, limit: String(pageSize), skip: String(skip) },
      })
      .then((r) => r.data);

  const first = await getPage(0);
  const firstItems = first.items ?? [];
  const total = first.total ?? firstItems.length;
  if (firstItems.length >= total) return firstItems;

  const skips: number[] = [];
  for (let skip = pageSize; skip < total; skip += pageSize) skips.push(skip);
  const rest = await Promise.all(skips.map((skip) => getPage(skip).then((d) => d.items ?? [])));
  return [firstItems, ...rest].flat();
};

export const fetchMyWorkOrders = async (
  status?: string
): Promise<WorkOrder[]> => {
  const params: Record<string, string> = {};
  if (status) params.status = status;
  const { data } = await api.get<PaginatedResponse<WorkOrder>>('/api/wo/my', { params });
  return data.items ?? [];
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

export const deleteWorkOrder = async (id: string): Promise<void> => {
  await api.delete(`/api/wo/${id}`);
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

export const completeWorkOrderFull = async (
  id: string,
  payload: {
    root_cause?: string;
    solution_applied?: string;
  }
): Promise<WorkOrder> => {
  const params: Record<string, string> = {};
  if (payload.root_cause) params.root_cause = payload.root_cause;
  if (payload.solution_applied) params.solution_applied = payload.solution_applied;
  const { data } = await api.post<WorkOrder>(`/api/wo/${id}/complete`, null, { params });
  return data;
};

export const resumeWorkOrder = async (id: string): Promise<WorkOrder> => {
  const { data } = await api.post<WorkOrder>(`/api/wo/${id}/resume`);
  return data;
};

// Intervention check-in from the office — the logged-in technician joins the
// ACTIVE intervention on the WO's machine (same mechanism as the kiosk card).
export interface WOCheckinState {
  active: boolean;
  intervention_id: string | null;
  technicians: { id: string; technician_id: string | null; name: string; checked_in_at: string | null }[];
  me_checked_in: boolean;
  has_tech_profile: boolean;
}

export const fetchWOCheckin = async (id: string): Promise<WOCheckinState> => {
  const { data } = await api.get<WOCheckinState>(`/api/wo/${id}/checkin`);
  return data;
};

export const checkinWOIntervention = async (id: string): Promise<WOCheckinState> => {
  const { data } = await api.post<WOCheckinState>(`/api/wo/${id}/checkin`);
  return data;
};

export const checkoutWOIntervention = async (id: string): Promise<WOCheckinState> => {
  const { data } = await api.post<WOCheckinState>(`/api/wo/${id}/checkout`);
  return data;
};

// Token-free note tidy-up via the local LLM (Ollama). ai_used=false means the
// model was offline and a light local cleanup ran instead.
export const organizeNote = async (
  text: string,
  language: string,
): Promise<{ text: string; ai_used: boolean }> => {
  const { data } = await api.post<{ text: string; ai_used: boolean }>(
    '/api/wo/notes/organize',
    { text, language },
  );
  return data;
};

export const holdWorkOrder = async (id: string): Promise<WorkOrder> => {
  const { data } = await api.patch<WorkOrder>(`/api/wo/${id}`, { status: 'on_hold' });
  return data;
};

export const assignWorkOrder = async (
  id: string,
  technician_ids: string[]
): Promise<WorkOrder> => {
  const { data } = await api.patch<WorkOrder>(`/api/wo/${id}/assign`, { technician_ids });
  return data;
};

export const addWOTechnician = async (
  id: string,
  technicianId: string
): Promise<WorkOrder> => {
  const { data } = await api.post<WorkOrder>(`/api/wo/${id}/technicians/${technicianId}`);
  return data;
};

export const removeWOTechnician = async (
  id: string,
  technicianId: string
): Promise<WorkOrder> => {
  const { data } = await api.delete<WorkOrder>(`/api/wo/${id}/technicians/${technicianId}`);
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

// Toggle approved-overtime on a labor record → recomputes effective_hours /
// labor_cost server-side (off-shift time re-included; raw hours untouched).
export const setWOLaborOvertime = async (
  woId: string, laborId: string, overtime_approved: boolean,
): Promise<LaborRecord> => {
  const { data } = await api.patch<LaborRecord>(
    `/api/wo/${woId}/labor/${laborId}`, { overtime_approved },
  );
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

export const toggleWOAction = async (
  workOrderId: string,
  actionId: string,
  is_completed: boolean
): Promise<WOAction> => {
  const { data } = await api.patch<WOAction>(`/api/wo/${workOrderId}/actions/${actionId}/toggle`, { is_completed });
  return data;
};

export const reorderWorkOrders = async (woIds: string[]): Promise<void> => {
  await api.patch('/api/wo/board/reorder', { wo_ids: woIds });
};

export const setWOActionProof = async (
  workOrderId: string,
  actionId: string,
  url: string | null
): Promise<WOAction> => {
  const { data } = await api.patch<WOAction>(`/api/wo/${workOrderId}/actions/${actionId}/proof`, { url });
  return data;
};

// ─── KPIs ─────────────────────────────────────────────────────────────────────

// A custom calendar range (both ends, ISO YYYY-MM-DD) overrides period_days server-side.
export type KpiRange = { start?: string; end?: string };
const rangeParams = (r?: KpiRange) => (r?.start && r?.end ? { start: r.start, end: r.end } : {});

export const fetchKPISummary = async (period_days = 30, machine_id?: string, range?: KpiRange): Promise<KPISummary> => {
  const { data } = await api.get<KPISummary>('/api/kpis/summary', {
    params: { period_days, ...(machine_id ? { machine_id } : {}), ...rangeParams(range) },
  });
  return data;
};

export const fetchBacklog = async (machine_id?: string): Promise<BacklogData> => {
  const { data } = await api.get<BacklogData>('/api/kpis/backlog', {
    params: machine_id ? { machine_id } : {},
  });
  return data;
};

export const fetchMTTR = async (period_days = 90, machine_id?: string, range?: KpiRange): Promise<MTTRItem[]> => {
  const { data } = await api.get<MTTRItem[]>('/api/kpis/mttr', {
    params: { period_days, ...(machine_id ? { machine_id } : {}), ...rangeParams(range) },
  });
  return Array.isArray(data) ? data : [];
};

export const fetchCostByType = async (period_days = 30, machine_id?: string): Promise<CostItem[]> => {
  const { data } = await api.get<CostItem[]>('/api/kpis/cost', {
    params: { period_days, ...(machine_id ? { machine_id } : {}) },
  });
  return Array.isArray(data) ? data : [];
};

export const fetchDowntimePareto = async (period_days = 30, machine_id?: string, range?: KpiRange): Promise<DowntimeParetoItem[]> => {
  const { data } = await api.get<DowntimeParetoItem[]>('/api/kpis/downtime-pareto', {
    params: { period_days, ...(machine_id ? { machine_id } : {}), ...rangeParams(range) },
  });
  return Array.isArray(data) ? data : [];
};

export const fetchOEETrend = async (period_days = 30, machine_id?: string, range?: KpiRange): Promise<OEETrendPoint[]> => {
  const { data } = await api.get<OEETrendPoint[]>('/api/kpis/oee-trend', {
    params: { period_days, ...(machine_id ? { machine_id } : {}), ...rangeParams(range) },
  });
  return Array.isArray(data) ? data : [];
};

export const fetchOEEByMachine = async (period_days = 30, range?: KpiRange): Promise<OEEByMachineItem[]> => {
  const { data } = await api.get<OEEByMachineItem[]>('/api/kpis/oee-by-machine', {
    params: { period_days, ...rangeParams(range) },
  });
  return Array.isArray(data) ? data : [];
};
