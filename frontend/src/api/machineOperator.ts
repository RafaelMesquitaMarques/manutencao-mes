import api from './axios';
import type { MachineOperatorState, InterventionType } from '../types';

export const fetchMachineOperatorState = (id: string): Promise<MachineOperatorState> =>
  api.get(`/api/machine-operator/${id}`).then((r) => r.data);

export const fetchInterventionTypes = (id: string): Promise<{ items: InterventionType[] }> =>
  api.get(`/api/machine-operator/${id}/intervention-types`).then((r) => r.data);

export const callMaintenance = (id: string, operator_note?: string) =>
  api.post(`/api/machine-operator/${id}/call`, { operator_note }).then((r) => r.data);

export const startIntervention = (id: string, mechanic_note?: string) =>
  api.post(`/api/machine-operator/${id}/start`, { mechanic_note }).then((r) => r.data);

export interface KioskTechnician {
  id: string;
  name: string;
  specialty: string | null;
}

export const fetchKioskTechnicians = (id: string): Promise<{ items: KioskTechnician[] }> =>
  api.get(`/api/machine-operator/${id}/technicians`).then((r) => r.data);

export const checkInTechnician = (id: string, technician_id: string) =>
  api.post(`/api/machine-operator/${id}/checkin`, { technician_id }).then((r) => r.data);

export const checkOutTechnician = (id: string, technician_id: string) =>
  api.post(`/api/machine-operator/${id}/checkout`, { technician_id }).then((r) => r.data);

export const completeIntervention = (
  id: string,
  payload: { mechanic_note?: string; intervention_type_id?: string }
) => api.post(`/api/machine-operator/${id}/complete`, payload).then((r) => r.data);

// Auth-free kiosk twin of workOrders.organizeNote — tidies a dictated closing
// note. ai_used=false means the AI was offline and only basic formatting ran.
export const organizeKioskNote = (
  id: string,
  text: string,
  language: string,
): Promise<{ text: string; ai_used: boolean }> =>
  api.post(`/api/machine-operator/${id}/notes/organize`, { text, language }).then((r) => r.data);

export interface ChecklistItem {
  id: string;
  text: string;
  sort_order: number;
  is_required: boolean;
}

export interface ChecklistResponse {
  checklist_id: string | null;
  name: string | null;
  items: ChecklistItem[];
}

export const fetchChecklist = (id: string): Promise<ChecklistResponse> =>
  api.get(`/api/machine-operator/${id}/checklist`).then((r) => r.data);

export const submitChecklist = (
  id: string,
  intervention_id: string,
  responses: { item_id: string; item_text: string; checked: boolean }[]
) =>
  api
    .post(`/api/machine-operator/${id}/checklist/submit`, { intervention_id, responses })
    .then((r) => r.data);

export interface InterventionPartItem {
  id: string;
  intervention_id: string;
  stock_item_id: string | null;
  item_code: string | null;
  item_description: string | null;
  quantity_used: number;
  unit: string | null;
  approval_status: string;
  added_at: string | null;
}

export const fetchInterventionParts = (
  machineId: string,
  interventionId: string
): Promise<{ items: InterventionPartItem[] }> =>
  api
    .get(`/api/machine-operator/${machineId}/parts`, {
      params: { intervention_id: interventionId },
    })
    .then((r) => r.data);

export const addInterventionPart = (
  machineId: string,
  payload: {
    intervention_id: string;
    stock_item_id?: string;
    item_code?: string;
    item_description?: string;
    quantity_used: number;
    unit?: string;
  }
): Promise<InterventionPartItem> =>
  api.post(`/api/machine-operator/${machineId}/parts`, payload).then((r) => r.data);

export const removeInterventionPart = (machineId: string, partId: string): Promise<void> =>
  api.delete(`/api/machine-operator/${machineId}/parts/${partId}`).then((r) => r.data);

export interface InventorySearchItem {
  id: string;
  code: string;
  name: string;
  description: string;
  unit: string;
  quantity: number;
}

export const searchInventory = (
  q: string,
  limit = 10
): Promise<{ items: InventorySearchItem[] }> =>
  api.get('/api/inventory/search', { params: { q, limit } }).then((r) => r.data);
