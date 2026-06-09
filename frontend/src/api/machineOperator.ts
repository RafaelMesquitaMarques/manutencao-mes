import api from './axios';
import type { MachineOperatorState } from '../types';

export const fetchMachineOperatorState = (id: string): Promise<MachineOperatorState> =>
  api.get(`/api/machine-operator/${id}`).then((r) => r.data);

export const callMaintenance = (id: string, operator_note?: string) =>
  api.post(`/api/machine-operator/${id}/call`, { operator_note }).then((r) => r.data);

export const startIntervention = (id: string, mechanic_note?: string) =>
  api.post(`/api/machine-operator/${id}/start`, { mechanic_note }).then((r) => r.data);

export const completeIntervention = (id: string, mechanic_note?: string) =>
  api.post(`/api/machine-operator/${id}/complete`, { mechanic_note }).then((r) => r.data);
