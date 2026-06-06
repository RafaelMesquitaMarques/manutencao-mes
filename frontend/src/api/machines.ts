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

export const fetchTodayStops = async (ref: string): Promise<MachineStopOut[]> => {
  const { data } = await axios.get<MachineStopOut[]>(`/api/machines/${ref}/stops/today`);
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

export const requestMaintenance = async (
  ref: string,
  payload: MaintenanceRequestCreate,
): Promise<{ ticket_id: string; ticket_number: string; machine_name: string }> => {
  const { data } = await axios.post(`/api/machines/${ref}/request-maintenance`, payload);
  return data;
};
