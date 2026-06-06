import api from './axios';
import axios from 'axios';
import type {
  Machine,
  MachinePageData,
  MachineStatus,
  MaintenanceRequestCreate,
  MESData,
} from '../types';

interface Paginated<T> { total: number; items: T[] }

export const fetchMachinesAll = async (): Promise<Machine[]> => {
  const { data } = await api.get<Paginated<Machine>>('/api/machines/');
  return data.items ?? [];
};

export const fetchMachinePage = async (ref: string): Promise<MachinePageData> => {
  const { data } = await axios.get<MachinePageData>(`/api/machines/${ref}/page`);
  return data;
};

export const updateMachineStatus = async (
  ref: string,
  payload: { status: MachineStatus; current_operator?: string; current_shift?: string }
): Promise<void> => {
  await axios.patch(`/api/machines/${ref}/status`, payload);
};

export const fetchMESData = async (ref: string): Promise<MESData> => {
  const { data } = await axios.get<MESData>(`/api/machines/${ref}/mes-data`);
  return data;
};

export const requestMaintenance = async (
  ref: string,
  payload: MaintenanceRequestCreate
): Promise<{ ticket_id: string; ticket_number: string; machine_name: string }> => {
  const { data } = await axios.post(`/api/machines/${ref}/request-maintenance`, payload);
  return data;
};
