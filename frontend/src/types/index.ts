export type WorkOrderStatus = 'open' | 'in_progress' | 'on_hold' | 'completed' | 'cancelled';
export type WorkOrderType = 'corrective' | 'preventive' | 'predictive' | 'inspection' | 'improvement';
export type Priority = 'low' | 'medium' | 'high' | 'critical';

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: string;
}

export interface Equipment {
  id: string;          // UUID
  usina_id: string;
  code: string;
  name: string;
  location?: string;
  description?: string;
  criticality: string;
  status: string;
  hour_meter: number;
  active: boolean;
  created_at: string;
}

export interface WorkOrder {
  id: string;                  // UUID
  wo_number: string;
  title: string;
  description?: string;
  status: WorkOrderStatus;
  type: WorkOrderType;
  priority: Priority;
  equipment_id: string;        // UUID
  equipment_name?: string;
  equipment_location?: string;
  assigned_to_id?: string;
  created_by_id?: string;
  root_cause?: string;
  solution?: string;
  opened_at: string;
  due_date?: string;
  started_at?: string;
  completed_at?: string;
  downtime_hours?: number;
  repair_hours?: number;
  total_cost?: number;
  from_iot: boolean;
}

export interface WorkOrderCreate {
  equipment_id: string;        // UUID
  type: WorkOrderType;
  priority: Priority;
  title: string;
  description?: string;
  due_date?: string;
  assigned_to_id?: string;     // UUID
}

export interface DashboardStats {
  total_open: number;
  in_progress: number;
  on_hold: number;
  critical: number;
  completed_today: number;
  by_type: { type: string; count: number }[];
  by_status: { status: string; count: number }[];
}

export interface Technician {
  id: string;
  full_name: string;
  email: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  user_id: number | string;
  nome: string;
  idioma?: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}
