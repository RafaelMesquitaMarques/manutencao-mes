import api from './axios';
import axios from 'axios';
import type {
  Machine,
  MachinePageData,
  MachineStatus,
  MaintenanceRequestCreate,
  MESDataExtended,
  StopCategoryOut,
  MachineStopOut,
  MachineOperatorOut,
  StopCreateRequest,
  MachineConfigUpdate,
  MachineOperatorCreate,
  RejectCategoryOut,
  RejectLogCreate,
} from '../types';

interface Paginated<T> { total: number; items: T[] }

// ── Admin endpoints (authenticated) ──────────────────────────────────────────

export const fetchMachinesAll = async (): Promise<Machine[]> => {
  const { data } = await api.get<Paginated<Machine>>('/api/machines/');
  return data.items ?? [];
};

export const updateMachineConfig = async (
  ref: string,
  payload: MachineConfigUpdate,
): Promise<void> => {
  await api.patch(`/api/machines/${ref}/config`, payload);
};

export const addMachineOperator = async (
  ref: string,
  payload: MachineOperatorCreate,
): Promise<MachineOperatorOut> => {
  const { data } = await api.post<MachineOperatorOut>(`/api/machines/${ref}/operators`, payload);
  return data;
};

export const updateMachineOperatorRecord = async (
  opId: string,
  payload: Partial<MachineOperatorCreate & { is_active: boolean }>,
): Promise<MachineOperatorOut> => {
  const { data } = await api.patch<MachineOperatorOut>(`/api/machines/operators/${opId}`, payload);
  return data;
};

// ── Kiosk endpoints (no auth) ─────────────────────────────────────────────────

export const fetchMachinePage = async (ref: string): Promise<MachinePageData> => {
  const { data } = await axios.get<MachinePageData>(`/api/machines/${ref}/page`);
  return data;
};

export const updateMachineStatus = async (
  ref: string,
  payload: { status: MachineStatus; current_operator?: string; current_shift?: string },
): Promise<void> => {
  await axios.patch(`/api/machines/${ref}/status`, payload);
};

export const updateMachineJob = async (
  ref: string,
  job_number: string | null,
): Promise<void> => {
  await axios.patch(`/api/machines/${ref}/job`, { job_number });
};

export const updateMachineOperator = async (
  ref: string,
  payload: { operator_name?: string; operator_id?: string },
): Promise<void> => {
  await axios.patch(`/api/machines/${ref}/operator`, payload);
};

export const fetchMachineOperators = async (
  ref: string,
  shift?: string,
): Promise<MachineOperatorOut[]> => {
  const params = shift ? { shift } : {};
  const { data } = await axios.get<MachineOperatorOut[]>(`/api/machines/${ref}/operators`, { params });
  return data;
};

export const createMachineStop = async (
  ref: string,
  payload: StopCreateRequest,
): Promise<{ id: string; started_at: string; ticket_number: string | null; triggers_maintenance: boolean }> => {
  const { data } = await axios.post(`/api/machines/${ref}/stops`, payload);
  return data;
};

export const closeMachineStop = async (
  ref: string,
  stopId: string,
  payload: StopCreateRequest = {},
): Promise<void> => {
  await axios.patch(`/api/machines/${ref}/stops/${stopId}/close`, payload);
};

export const fetchTodayStops = async (
  ref: string,
  range?: { start: string; end: string },
): Promise<MachineStopOut[]> => {
  const { data } = await axios.get<MachineStopOut[]>(`/api/machines/${ref}/stops/today`, {
    params: range ? { start: range.start, end: range.end } : undefined,
  });
  return data;
};

export const reclassifyStop = async (
  ref: string,
  stopId: string,
  body: { stop_category_id?: string | null; stop_subcategory_id?: string | null; comments?: string },
): Promise<{ status: string }> => {
  const { data } = await axios.patch(`/api/machines/${ref}/stops/${stopId}/reclassify`, body);
  return data;
};

export const fetchMESData = async (ref: string): Promise<MESDataExtended> => {
  const { data } = await axios.get<MESDataExtended>(`/api/machines/${ref}/mes-data`);
  return data;
};

export const addRejects = async (
  ref: string,
  delta: number,
): Promise<{ reject_count: number }> => {
  const { data } = await axios.post(`/api/machines/${ref}/rejects`, { delta });
  return data;
};

export const fetchStopCategories = async (): Promise<StopCategoryOut[]> => {
  const { data } = await axios.get<StopCategoryOut[]>('/api/stop-categories/');
  return data;
};

export const fetchMachineStopCategories = async (ref: string): Promise<StopCategoryOut[]> => {
  const { data } = await axios.get<StopCategoryOut[]>(`/api/machines/${ref}/stop-categories`);
  return data;
};

export const createMachineStopCategory = async (
  ref: string,
  payload: Partial<StopCategoryOut>,
): Promise<StopCategoryOut> => {
  const { data } = await api.post<StopCategoryOut>(`/api/machines/${ref}/stop-categories`, payload);
  return data;
};

export const updateMachineStopCategory = async (
  ref: string,
  catId: string,
  payload: Partial<StopCategoryOut>,
): Promise<StopCategoryOut> => {
  const { data } = await api.patch<StopCategoryOut>(`/api/machines/${ref}/stop-categories/${catId}`, payload);
  return data;
};

export const deleteMachineStopCategory = async (ref: string, catId: string): Promise<void> => {
  await api.delete(`/api/machines/${ref}/stop-categories/${catId}`);
};

export const reorderMachineStopCategories = async (
  ref: string,
  items: { id: string; sort_order: number }[],
): Promise<void> => {
  await api.patch(`/api/machines/${ref}/stop-categories/reorder`, items);
};

export const addStopSubcategory = async (
  ref: string,
  catId: string,
  payload: Record<string, unknown>,
) => {
  const { data } = await api.post(`/api/machines/${ref}/stop-categories/${catId}/subcategories`, payload);
  return data;
};

export const updateStopSubcategory = async (
  ref: string,
  subId: string,
  payload: Record<string, unknown>,
) => {
  const { data } = await api.patch(`/api/machines/${ref}/stop-subcategories/${subId}`, payload);
  return data;
};

export const deleteStopSubcategory = async (ref: string, subId: string): Promise<void> => {
  await api.delete(`/api/machines/${ref}/stop-subcategories/${subId}`);
};

// ── Reject categories ─────────────────────────────────────────────────────────

export const fetchMachineRejectCategories = async (ref: string): Promise<RejectCategoryOut[]> => {
  const { data } = await axios.get<RejectCategoryOut[]>(`/api/machines/${ref}/reject-categories`);
  return data;
};

export const createMachineRejectCategory = async (
  ref: string,
  payload: Partial<RejectCategoryOut>,
): Promise<RejectCategoryOut> => {
  const { data } = await api.post<RejectCategoryOut>(`/api/machines/${ref}/reject-categories`, payload);
  return data;
};

export const updateMachineRejectCategory = async (
  ref: string,
  catId: string,
  payload: Partial<RejectCategoryOut>,
): Promise<RejectCategoryOut> => {
  const { data } = await api.patch<RejectCategoryOut>(`/api/machines/${ref}/reject-categories/${catId}`, payload);
  return data;
};

export const deleteMachineRejectCategory = async (ref: string, catId: string): Promise<void> => {
  await api.delete(`/api/machines/${ref}/reject-categories/${catId}`);
};

export const addRejectSubcategory = async (
  ref: string,
  catId: string,
  payload: Record<string, unknown>,
) => {
  const { data } = await api.post(`/api/machines/${ref}/reject-categories/${catId}/subcategories`, payload);
  return data;
};

export const updateRejectSubcategory = async (
  ref: string,
  subId: string,
  payload: Record<string, unknown>,
) => {
  const { data } = await api.patch(`/api/machines/${ref}/reject-subcategories/${subId}`, payload);
  return data;
};

export const deleteRejectSubcategory = async (ref: string, subId: string): Promise<void> => {
  await api.delete(`/api/machines/${ref}/reject-subcategories/${subId}`);
};

// ── Reject logs (kiosk) ───────────────────────────────────────────────────────

export const logReject = async (
  ref: string,
  payload: RejectLogCreate,
): Promise<{ id: string; reject_count: number }> => {
  const { data } = await axios.post(`/api/machines/${ref}/reject-logs`, payload);
  return data;
};

export const fetchTodayRejects = async (
  ref: string,
): Promise<{ total: number; by_category: Record<string, number> }> => {
  const { data } = await axios.get(`/api/machines/${ref}/rejects/today`);
  return data;
};

// ── Operator management ───────────────────────────────────────────────────────

export const deleteOperator = async (opId: string): Promise<void> => {
  await api.delete(`/api/machines/operators/${opId}`);
};

// ── Clone categories ──────────────────────────────────────────────────────────

export const cloneCategories = async (payload: {
  source_machine_id: string;
  target_machine_ids: string[];
  category_type: 'stop' | 'reject';
}): Promise<{ status: string; cloned_to: number }> => {
  const { data } = await api.post('/api/machines/clone-categories', payload);
  return data;
};

export const requestMaintenance = async (
  ref: string,
  payload: MaintenanceRequestCreate,
): Promise<{ ticket_id: string; ticket_number: string; machine_name: string }> => {
  const { data } = await axios.post(`/api/machines/${ref}/request-maintenance`, payload);
  return data;
};
