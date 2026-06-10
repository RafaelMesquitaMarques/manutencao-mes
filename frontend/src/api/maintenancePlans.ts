import api from './axios';
import type {
  MaintenancePlan,
  MaintenancePlanListResponse,
  PlanOccurrence,
  PlanOccurrenceListResponse,
  PlanCalendarItem,
  PmDashboard,
  PmFrequency,
  RecurrenceEndType,
  OccurrenceStatus,
} from '../types';

// ─── Maintenance Plans ──────────────────────────────────────────────────────────

export interface PlanFilters {
  equipment_id?: string;
  plant_id?: string;
  plan_type?: string;
  frequency_type?: PmFrequency;
  is_active?: boolean;
  search?: string;
  skip?: number;
  limit?: number;
}

export const fetchMaintenancePlans = async (params?: PlanFilters): Promise<MaintenancePlanListResponse> => {
  const { data } = await api.get<MaintenancePlanListResponse>('/api/plans/', { params });
  return data;
};

export const fetchMaintenancePlan = async (id: string): Promise<MaintenancePlan> => {
  const { data } = await api.get<MaintenancePlan>(`/api/plans/${id}`);
  return data;
};

export interface RecommendedPartInput {
  stock_item_id?: string;
  item_code?: string;
  item_description?: string;
  quantity_recommended?: number;
  unit?: string;
}

export interface MaintenancePlanCreatePayload {
  equipment_id: string;
  name: string;
  description?: string;
  pm_template_id?: string;
  plan_type?: string;

  frequency_type: PmFrequency;
  frequency_value?: number;
  frequency_days?: number;
  frequency_hours?: number;
  weekdays?: string;
  start_date: string;

  recurrence_end_type?: RecurrenceEndType;
  recurrence_end_value?: number;
  recurrence_end_date?: string;

  lead_time_days?: number;
  assigned_technician_id?: string;
  priority?: string;
  estimated_hours?: number;

  recommended_parts?: RecommendedPartInput[];
}

export const createMaintenancePlan = async (payload: MaintenancePlanCreatePayload): Promise<MaintenancePlan> => {
  const { data } = await api.post<MaintenancePlan>('/api/plans/', payload);
  return data;
};

export type MaintenancePlanUpdatePayload = Partial<Omit<MaintenancePlanCreatePayload, 'equipment_id' | 'recommended_parts'>> & {
  is_active?: boolean;
};

export const updateMaintenancePlan = async (id: string, payload: MaintenancePlanUpdatePayload): Promise<MaintenancePlan> => {
  const { data } = await api.patch<MaintenancePlan>(`/api/plans/${id}`, payload);
  return data;
};

export const deleteMaintenancePlan = async (id: string): Promise<void> => {
  await api.delete(`/api/plans/${id}`);
};

// ─── Occurrences ─────────────────────────────────────────────────────────────────

export const fetchPlanOccurrences = async (planId: string, status?: OccurrenceStatus): Promise<PlanOccurrence[]> => {
  const params = status ? { status } : undefined;
  const { data } = await api.get<PlanOccurrenceListResponse>(`/api/plans/${planId}/occurrences`, { params });
  return data.items ?? [];
};

export const fetchOccurrence = async (occurrenceId: string): Promise<PlanOccurrence> => {
  const { data } = await api.get<PlanOccurrence>(`/api/plans/occurrences/${occurrenceId}`);
  return data;
};

export const overrideOccurrence = async (
  occurrenceId: string,
  payload: { override_date?: string; override_note?: string }
): Promise<PlanOccurrence> => {
  const { data } = await api.patch<PlanOccurrence>(`/api/plans/occurrences/${occurrenceId}`, payload);
  return data;
};

export const cancelOccurrence = async (
  occurrenceId: string,
  payload?: { cancel_reason?: string }
): Promise<PlanOccurrence> => {
  const { data } = await api.post<PlanOccurrence>(`/api/plans/occurrences/${occurrenceId}/cancel`, payload ?? {});
  return data;
};

export const generateOccurrenceWO = async (occurrenceId: string): Promise<PlanOccurrence> => {
  const { data } = await api.post<PlanOccurrence>(`/api/plans/occurrences/${occurrenceId}/generate-wo`);
  return data;
};

// ─── Calendar / Dashboard ──────────────────────────────────────────────────────────

export const fetchPmCalendar = async (
  start: string,
  end: string,
  params?: { plant_id?: string; equipment_id?: string }
): Promise<PlanCalendarItem[]> => {
  const { data } = await api.get<PlanCalendarItem[]>('/api/plans/calendar', {
    params: { start, end, ...params },
  });
  return Array.isArray(data) ? data : [];
};

export const fetchPmDashboard = async (plant_id?: string): Promise<PmDashboard> => {
  const params = plant_id ? { plant_id } : undefined;
  const { data } = await api.get<PmDashboard>('/api/plans/dashboard', { params });
  return data;
};
