import api from './axios';
import type { MachineReportData, MachineCompareResponse } from '../types';

export const fetchMachineReport = async (
  machineId: string,
  period_days = 30,
): Promise<MachineReportData> => {
  const { data } = await api.get<MachineReportData>(`/api/reports/machine/${machineId}`, {
    params: { period_days },
  });
  return data;
};

export const fetchMachineComparison = async (
  period_days = 30,
): Promise<MachineCompareResponse> => {
  const { data } = await api.get<MachineCompareResponse>('/api/reports/machines/compare', {
    params: { period_days },
  });
  return data;
};
