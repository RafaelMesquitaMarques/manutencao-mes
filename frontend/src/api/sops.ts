import api from './axios';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SopCategory = 'operation' | 'maintenance' | 'safety' | 'quality' | 'setup';
export type SopStatus = 'draft' | 'published' | 'archived';

export interface SopStepMedia {
  id: string;
  step_id: string;
  media_type: 'image' | 'video' | 'link';
  url: string;
  caption?: string | null;
  sort_order: number;
}

export interface SopStep {
  id: string;
  sop_id: string;
  title?: string | null;
  instruction: string;
  expected_result?: string | null;
  warning?: string | null;
  sort_order: number;
  is_required: boolean;
  media: SopStepMedia[];
}

export interface SopEquipmentRef {
  equipment_id: string;
  equipment_name?: string | null;
  equipment_code?: string | null;
}

export interface Sop {
  id: string;
  plant_id?: string | null;
  sop_number: string;
  title: string;
  category: SopCategory;
  description?: string | null;
  status: SopStatus;
  version: number;
  estimated_minutes?: number | null;
  created_by_name?: string | null;
  published_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  step_count: number;
  equipment: SopEquipmentRef[];
  steps: SopStep[];
}

export interface SopExecutionStepState {
  step_id: string;
  checked: boolean;
  checked_at?: string | null;
}

export interface SopExecution {
  id: string;
  sop_id: string;
  equipment_id?: string | null;
  machine_id?: string | null;
  machine_name?: string | null;
  user_id?: string | null;
  operator_name?: string | null;
  sop_version?: number | null;
  source: 'app' | 'kiosk';
  status: 'in_progress' | 'completed' | 'abandoned';
  started_at?: string | null;
  completed_at?: string | null;
  duration_seconds?: number | null;
  notes?: string | null;
  steps: SopExecutionStepState[];
}

export interface SopListFilters {
  category?: SopCategory;
  status?: SopStatus;
  equipment_id?: string;
  search?: string;
}

// ─── Library CRUD (authenticated) ─────────────────────────────────────────────

export const fetchSops = async (filters?: SopListFilters): Promise<Sop[]> => {
  const { data } = await api.get<{ total: number; items: Sop[] }>('/api/sops/', { params: filters });
  return data.items ?? [];
};

export const fetchSop = async (id: string): Promise<Sop> => {
  const { data } = await api.get<Sop>(`/api/sops/${id}`);
  return data;
};

export const createSop = async (payload: {
  title: string;
  category: SopCategory;
  description?: string;
  estimated_minutes?: number | null;
  equipment_ids?: string[];
}): Promise<Sop> => {
  const { data } = await api.post<Sop>('/api/sops/', payload);
  return data;
};

export const updateSop = async (id: string, payload: Partial<{
  title: string;
  category: SopCategory;
  description: string | null;
  estimated_minutes: number | null;
  equipment_ids: string[];
}>): Promise<Sop> => {
  const { data } = await api.patch<Sop>(`/api/sops/${id}`, payload);
  return data;
};

export const publishSop = async (id: string): Promise<Sop> => {
  const { data } = await api.post<Sop>(`/api/sops/${id}/publish`);
  return data;
};

export const archiveSop = async (id: string): Promise<Sop> => {
  const { data } = await api.post<Sop>(`/api/sops/${id}/archive`);
  return data;
};

export const restoreSop = async (id: string): Promise<Sop> => {
  const { data } = await api.post<Sop>(`/api/sops/${id}/restore`);
  return data;
};

export const duplicateSop = async (id: string): Promise<Sop> => {
  const { data } = await api.post<Sop>(`/api/sops/${id}/duplicate`);
  return data;
};

export const deleteSop = async (id: string): Promise<void> => {
  await api.delete(`/api/sops/${id}`);
};

// ─── Steps ────────────────────────────────────────────────────────────────────

export const addSopStep = async (sopId: string, payload: {
  title?: string | null;
  instruction: string;
  expected_result?: string | null;
  warning?: string | null;
  sort_order?: number;
  is_required?: boolean;
}): Promise<SopStep> => {
  const { data } = await api.post<SopStep>(`/api/sops/${sopId}/steps`, payload);
  return data;
};

export const updateSopStep = async (sopId: string, stepId: string, payload: Partial<{
  title: string | null;
  instruction: string;
  expected_result: string | null;
  warning: string | null;
  sort_order: number;
  is_required: boolean;
}>): Promise<SopStep> => {
  const { data } = await api.patch<SopStep>(`/api/sops/${sopId}/steps/${stepId}`, payload);
  return data;
};

export const deleteSopStep = async (sopId: string, stepId: string): Promise<void> => {
  await api.delete(`/api/sops/${sopId}/steps/${stepId}`);
};

export const reorderSopSteps = async (sopId: string, stepIds: string[]): Promise<void> => {
  await api.post(`/api/sops/${sopId}/steps/reorder`, { step_ids: stepIds });
};

export const addSopStepMedia = async (sopId: string, stepId: string, payload: {
  media_type: 'image' | 'video' | 'link';
  url: string;
  caption?: string | null;
  sort_order?: number;
}): Promise<SopStepMedia> => {
  const { data } = await api.post<SopStepMedia>(`/api/sops/${sopId}/steps/${stepId}/media`, payload);
  return data;
};

export const deleteSopStepMedia = async (sopId: string, stepId: string, mediaId: string): Promise<void> => {
  await api.delete(`/api/sops/${sopId}/steps/${stepId}/media/${mediaId}`);
};

// ─── Executions (authenticated app) ───────────────────────────────────────────

export const fetchSopExecutions = async (sopId: string): Promise<SopExecution[]> => {
  const { data } = await api.get<{ total: number; items: SopExecution[] }>(`/api/sops/${sopId}/executions`);
  return data.items ?? [];
};

export const startSopExecution = async (sopId: string, equipmentId?: string): Promise<SopExecution> => {
  const { data } = await api.post<SopExecution>('/api/sop-executions/', {
    sop_id: sopId, equipment_id: equipmentId ?? null,
  });
  return data;
};

export const setSopExecutionStep = async (
  executionId: string, stepId: string, checked: boolean,
): Promise<SopExecution> => {
  const { data } = await api.patch<SopExecution>(
    `/api/sop-executions/${executionId}/steps/${stepId}`, { checked },
  );
  return data;
};

export const completeSopExecution = async (executionId: string, notes?: string): Promise<SopExecution> => {
  const { data } = await api.post<SopExecution>(`/api/sop-executions/${executionId}/complete`, { notes: notes ?? null });
  return data;
};

export const abandonSopExecution = async (executionId: string): Promise<SopExecution> => {
  const { data } = await api.post<SopExecution>(`/api/sop-executions/${executionId}/abandon`);
  return data;
};

// ─── Kiosk (machine page — no login) ──────────────────────────────────────────

export const fetchKioskSops = async (ref: string, category?: SopCategory): Promise<Sop[]> => {
  const { data } = await api.get<{ total: number; items: Sop[] }>(
    `/api/machines/${ref}/sops`, { params: category ? { category } : undefined },
  );
  return data.items ?? [];
};

export const startKioskSopExecution = async (
  ref: string, sopId: string, operatorName?: string,
): Promise<SopExecution> => {
  const { data } = await api.post<SopExecution>(
    `/api/machines/${ref}/sops/${sopId}/executions`, { operator_name: operatorName ?? null },
  );
  return data;
};

export const setKioskSopExecutionStep = async (
  ref: string, executionId: string, stepId: string, checked: boolean,
): Promise<SopExecution> => {
  const { data } = await api.patch<SopExecution>(
    `/api/machines/${ref}/sop-executions/${executionId}/steps/${stepId}`, { checked },
  );
  return data;
};

export const completeKioskSopExecution = async (
  ref: string, executionId: string, notes?: string,
): Promise<SopExecution> => {
  const { data } = await api.post<SopExecution>(
    `/api/machines/${ref}/sop-executions/${executionId}/complete`, { notes: notes ?? null },
  );
  return data;
};

export const abandonKioskSopExecution = async (ref: string, executionId: string): Promise<SopExecution> => {
  const { data } = await api.post<SopExecution>(`/api/machines/${ref}/sop-executions/${executionId}/abandon`);
  return data;
};
