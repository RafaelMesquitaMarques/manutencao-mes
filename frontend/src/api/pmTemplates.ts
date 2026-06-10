import api from './axios';
import type { PmTemplate, PmTemplateListResponse, PmTemplateTask, PmFrequency } from '../types';

export interface PmTemplateFilters {
  equipment_id?: string;
  plant_id?: string;
  is_active?: boolean;
}

export const fetchPmTemplates = async (params?: PmTemplateFilters): Promise<PmTemplate[]> => {
  const { data } = await api.get<PmTemplateListResponse>('/api/settings/pm-templates/', { params });
  return data.items ?? [];
};

export const fetchPmTemplate = async (id: string): Promise<PmTemplate> => {
  const { data } = await api.get<PmTemplate>(`/api/settings/pm-templates/${id}`);
  return data;
};

export interface PmTemplateTaskInput {
  description: string;
  sort_order?: number;
  is_required?: boolean;
}

export interface PmTemplateCreatePayload {
  equipment_id: string;
  frequency_type: PmFrequency;
  name: string;
  description?: string;
  estimated_hours?: number;
  sort_order?: number;
  tasks?: PmTemplateTaskInput[];
}

export const createPmTemplate = async (payload: PmTemplateCreatePayload): Promise<PmTemplate> => {
  const { data } = await api.post<PmTemplate>('/api/settings/pm-templates/', payload);
  return data;
};

export interface PmTemplateUpdatePayload {
  frequency_type?: PmFrequency;
  name?: string;
  description?: string;
  estimated_hours?: number;
  is_active?: boolean;
  sort_order?: number;
}

export const updatePmTemplate = async (id: string, payload: PmTemplateUpdatePayload): Promise<PmTemplate> => {
  const { data } = await api.patch<PmTemplate>(`/api/settings/pm-templates/${id}`, payload);
  return data;
};

export const deletePmTemplate = async (id: string): Promise<void> => {
  await api.delete(`/api/settings/pm-templates/${id}`);
};

// ─── Template tasks ─────────────────────────────────────────────────────────────

export const addPmTemplateTask = async (templateId: string, payload: PmTemplateTaskInput): Promise<PmTemplateTask> => {
  const { data } = await api.post<PmTemplateTask>(`/api/settings/pm-templates/${templateId}/tasks`, payload);
  return data;
};

export const updatePmTemplateTask = async (
  templateId: string,
  taskId: string,
  payload: Partial<PmTemplateTaskInput>
): Promise<PmTemplateTask> => {
  const { data } = await api.patch<PmTemplateTask>(`/api/settings/pm-templates/${templateId}/tasks/${taskId}`, payload);
  return data;
};

export const deletePmTemplateTask = async (templateId: string, taskId: string): Promise<void> => {
  await api.delete(`/api/settings/pm-templates/${templateId}/tasks/${taskId}`);
};
