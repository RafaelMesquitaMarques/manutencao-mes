import api from './axios';
import axios from 'axios';
import type { JobOrder } from '../types';

export const fetchJobOrders = async (params?: {
  machine_id?: string;
  job_number?: string;
  status?: string;
}): Promise<JobOrder[]> => {
  const { data } = await api.get<JobOrder[]>('/api/job-orders/', { params });
  return data;
};

export const lookupJobOrder = async (jobNumber: string): Promise<JobOrder | null> => {
  const { data } = await axios.get<JobOrder | null>('/api/job-orders/lookup', {
    params: { job_number: jobNumber },
  });
  return data;
};

export const createJobOrderKiosk = async (payload: {
  job_number: string;
  machine_id?: string;
  description?: string;
  target_quantity?: number;
}): Promise<JobOrder> => {
  const { data } = await axios.post<JobOrder>('/api/job-orders/kiosk', payload);
  return data;
};

export const updateJobOrder = async (
  jobId: string,
  payload: Partial<Pick<JobOrder, 'status' | 'description' | 'target_quantity' | 'machine_id'>>,
): Promise<JobOrder> => {
  const { data } = await api.patch<JobOrder>(`/api/job-orders/${jobId}`, payload);
  return data;
};
