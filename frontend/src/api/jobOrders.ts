import api from './axios';
import axios from 'axios';
import type { JobOrder, JobOrderRun, JobOrderCost, JobOrderCostReport } from '../types';

export const fetchJobOrders = async (params?: {
  machine_id?: string;
  job_number?: string;
  status?: string;
  department?: string;
}): Promise<JobOrder[]> => {
  const { data } = await api.get<JobOrder[]>('/api/job-orders/', { params });
  return data;
};

export const lookupJobOrder = async (
  jobNumber: string,
  machineId?: string,   // OF numbers are unique per plant — pass the machine to disambiguate
): Promise<JobOrder | null> => {
  const { data } = await axios.get<JobOrder | null>('/api/job-orders/lookup', {
    params: { job_number: jobNumber, machine_id: machineId },
  });
  return data;
};

export const createJobOrderKiosk = async (payload: {
  job_number: string;
  machine_id?: string;
  product_name?: string;
  target_quantity?: number;
}): Promise<JobOrder> => {
  const { data } = await axios.post<JobOrder>('/api/job-orders/kiosk', payload);
  return data;
};

export const updateJobOrder = async (
  jobId: string,
  payload: Partial<Pick<JobOrder, 'status' | 'product_name' | 'target_quantity' | 'machine_id' | 'scheduled_date'>>,
): Promise<JobOrder> => {
  const { data } = await api.patch<JobOrder>(`/api/job-orders/${jobId}`, payload);
  return data;
};

export const fetchJobOrder = async (jobId: string): Promise<JobOrder> => {
  const { data } = await api.get<JobOrder>(`/api/job-orders/${jobId}`);
  return data;
};

export const fetchJobOrderRuns = async (jobId: string): Promise<JobOrderRun[]> => {
  const { data } = await api.get<JobOrderRun[]>(`/api/job-orders/${jobId}/runs`);
  return data;
};

export const fetchJobOrderCost = async (jobId: string): Promise<JobOrderCost> => {
  const { data } = await api.get<JobOrderCost>(`/api/job-orders/${jobId}/cost`);
  return data;
};

export const fetchJobOrderCostReport = async (params?: {
  status?: string;
  department?: string;
  date_from?: string;
  date_to?: string;
}): Promise<JobOrderCostReport> => {
  const { data } = await api.get<JobOrderCostReport>('/api/job-orders/cost-report', { params });
  return data;
};
