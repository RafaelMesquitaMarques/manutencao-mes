import api from './axios';
import type {
  ShiftTemplate, ShiftBreak, TechnicianUnavailability, UnavailabilityType,
} from '../types';

// ─── Shift templates & breaks ────────────────────────────────────────────────
// These drive effective LABOR time and technician availability only — never
// machine downtime, ticket duration, or MTTR.

export const fetchShiftTemplates = async (): Promise<ShiftTemplate[]> => {
  const { data } = await api.get<ShiftTemplate[]>('/api/shift-templates/');
  return data;
};

export interface ShiftTemplatePayload {
  key: string;
  name?: string;
  start_time: string;
  end_time: string;
  active?: boolean;
  breaks?: Omit<ShiftBreak, 'id'>[];
}

export const createShiftTemplate = async (payload: ShiftTemplatePayload): Promise<ShiftTemplate> => {
  const { data } = await api.post<ShiftTemplate>('/api/shift-templates/', payload);
  return data;
};

export const updateShiftTemplate = async (
  id: string, payload: Partial<ShiftTemplatePayload>,
): Promise<ShiftTemplate> => {
  const { data } = await api.patch<ShiftTemplate>(`/api/shift-templates/${id}`, payload);
  return data;
};

export const deleteShiftTemplate = async (id: string): Promise<void> => {
  await api.delete(`/api/shift-templates/${id}`);
};

// ─── Technician unavailability (vacation / absence / …) ───────────────────────

export const fetchAllUnavailability = async (params?: {
  technician_id?: string; date_from?: string; date_to?: string;
}): Promise<TechnicianUnavailability[]> => {
  const { data } = await api.get<TechnicianUnavailability[]>(
    '/api/technicians/unavailability', { params },
  );
  return data;
};

export const fetchTechnicianUnavailability = async (
  technicianId: string,
): Promise<TechnicianUnavailability[]> => {
  const { data } = await api.get<TechnicianUnavailability[]>(
    `/api/technicians/${technicianId}/unavailability`,
  );
  return data;
};

export const addTechnicianUnavailability = async (
  technicianId: string,
  payload: { type: UnavailabilityType; start_date: string; end_date: string; notes?: string },
): Promise<TechnicianUnavailability> => {
  const { data } = await api.post<TechnicianUnavailability>(
    `/api/technicians/${technicianId}/unavailability`, payload,
  );
  return data;
};

export const deleteTechnicianUnavailability = async (
  technicianId: string, unavailabilityId: string,
): Promise<void> => {
  await api.delete(`/api/technicians/${technicianId}/unavailability/${unavailabilityId}`);
};
