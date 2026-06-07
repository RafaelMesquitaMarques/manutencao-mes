import api from './axios';
import type {
  Machine,
  MaintenanceAlert,
  AlertCreate,
  MaintenanceTicket,
  TicketComment,
  MaintenanceDashboardData,
  SupervisorOverview,
} from '../types';
import type { WorkOrder } from '../types';

interface Paginated<T> {
  total: number;
  items: T[];
}

// ── Machines ──────────────────────────────────────────────────────────────────

export const fetchMachines = async (): Promise<Machine[]> => {
  const { data } = await api.get<Paginated<Machine>>('/api/alerts/machines');
  return data.items ?? [];
};

// ── Alerts ────────────────────────────────────────────────────────────────────

export const fetchAlerts = async (
  params?: Record<string, string | boolean>
): Promise<{ total: number; items: MaintenanceAlert[] }> => {
  const { data } = await api.get<Paginated<MaintenanceAlert>>('/api/alerts/', { params });
  return { total: data.total, items: data.items ?? [] };
};

export const fetchAlert = async (id: string): Promise<MaintenanceAlert> => {
  const { data } = await api.get<MaintenanceAlert>(`/api/alerts/${id}`);
  return data;
};

export const createAlert = async (payload: AlertCreate): Promise<MaintenanceAlert> => {
  const { data } = await api.post<MaintenanceAlert>('/api/alerts/', payload);
  return data;
};

export const assignAlert = async (id: string): Promise<MaintenanceAlert> => {
  const { data } = await api.patch<MaintenanceAlert>(`/api/alerts/${id}/assign`);
  return data;
};

export const convertAlertToTicket = async (
  id: string
): Promise<{ ticket_id: string; ticket_number: string }> => {
  const { data } = await api.patch<{ ticket_id: string; ticket_number: string }>(
    `/api/alerts/${id}/convert`
  );
  return data;
};

// ── Tickets ───────────────────────────────────────────────────────────────────

export const fetchTickets = async (
  params?: Record<string, string>
): Promise<{ total: number; items: MaintenanceTicket[] }> => {
  const { data } = await api.get<Paginated<MaintenanceTicket>>('/api/tickets/', { params });
  return { total: data.total, items: data.items ?? [] };
};

export const fetchTicket = async (id: string): Promise<MaintenanceTicket> => {
  const { data } = await api.get<MaintenanceTicket>(`/api/tickets/${id}`);
  return data;
};

export const updateTicketStatus = async (
  id: string,
  payload: {
    status?: string;
    assigned_to_id?: string | null;
    diagnosis?: string;
    corrective_action?: string;
    parts_used?: object[];
    estimated_downtime_minutes?: number;
    total_intervention_minutes?: number;
  }
): Promise<MaintenanceTicket> => {
  const { data } = await api.patch<MaintenanceTicket>(`/api/tickets/${id}/status`, payload);
  return data;
};

export const closeTicket = async (
  id: string,
  payload: {
    diagnosis: string;
    corrective_action: string;
    total_intervention_minutes: number;
    parts_used?: object[];
    estimated_downtime_minutes?: number;
  }
): Promise<MaintenanceTicket> => {
  const { data } = await api.patch<MaintenanceTicket>(`/api/tickets/${id}/close`, payload);
  return data;
};

export const addTicketComment = async (
  id: string,
  payload: { author: string; comment: string }
): Promise<TicketComment> => {
  const { data } = await api.post<TicketComment>(`/api/tickets/${id}/comments`, payload);
  return data;
};

// ── Ticket field actions ──────────────────────────────────────────────────────

export const openTicketField = async (id: string): Promise<MaintenanceTicket> => {
  const { data } = await api.patch<MaintenanceTicket>(`/api/tickets/${id}/open-field`);
  return data;
};

// ── WO generation from ticket ─────────────────────────────────────────────────

export const generateWorkOrder = async (
  ticketId: string
): Promise<{ ticket: MaintenanceTicket; work_order: WorkOrder }> => {
  const { data } = await api.post<{ ticket: MaintenanceTicket; work_order: WorkOrder }>(
    `/api/tickets/${ticketId}/generate-wo`
  );
  return data;
};

export const assignTicket = async (
  ticketId: string,
  technicianId: string
): Promise<{ ticket: MaintenanceTicket; work_order: WorkOrder }> => {
  const { data } = await api.patch<{ ticket: MaintenanceTicket; work_order: WorkOrder }>(
    `/api/tickets/${ticketId}/assign`,
    { technician_id: technicianId }
  );
  return data;
};

export const createTicket = async (payload: {
  machine_id: string;
  priority: string;
  problem_type?: string;
  description?: string;
  estimated_downtime_minutes?: number;
}): Promise<MaintenanceTicket> => {
  const { data } = await api.post<MaintenanceTicket>('/api/tickets/', payload);
  return data;
};

export const fetchTicketWorkOrder = async (ticketId: string): Promise<WorkOrder> => {
  const { data } = await api.get<WorkOrder>(`/api/tickets/${ticketId}/work-order`);
  return data;
};

// ── Dashboard ─────────────────────────────────────────────────────────────────

export const fetchMaintenanceDashboard =
  async (): Promise<MaintenanceDashboardData> => {
    const { data } = await api.get<MaintenanceDashboardData>('/api/maintenance/dashboard');
    return data;
  };

export const fetchSupervisorOverview = async (): Promise<SupervisorOverview> => {
  const { data } = await api.get<SupervisorOverview>('/api/maintenance/supervisor');
  return data;
};
