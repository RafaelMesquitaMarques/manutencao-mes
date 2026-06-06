export type WorkOrderStatus = 'open' | 'in_progress' | 'on_hold' | 'completed' | 'cancelled';
export type WorkOrderType = 'corrective' | 'preventive' | 'predictive' | 'inspection' | 'improvement';
export type Priority = 'low' | 'medium' | 'high' | 'critical';

export interface User {
  id: string;
  name: string;
  email: string;
  active: boolean;
}

export interface Equipment {
  id: string;
  plant_id: string;
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
  id: string;
  wo_number: string;
  title: string;
  short_description?: string;
  description?: string;
  status: WorkOrderStatus;
  type: WorkOrderType;
  priority: Priority;
  equipment_id: string;
  equipment_name?: string;
  equipment_location?: string;
  assigned_to_id?: string;
  assigned_to_name?: string;
  created_by_id?: string;
  created_by_name?: string;
  executor_id?: string;
  root_cause?: string;
  solution_applied?: string;
  opened_at: string;
  due_date?: string;
  started_at?: string;
  completed_at?: string;
  downtime_hours?: number;
  repair_hours?: number;
  total_cost?: number;
  execution_mode?: string;
  classification?: string;
  failure_code?: string;
  component?: string;
  tag?: string;
  project_number?: string;
  cost_center?: string;
  from_iot: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface WorkOrderCreate {
  equipment_id: string;
  type: WorkOrderType;
  priority: Priority;
  title: string;
  description?: string;
  due_date?: string;
  assigned_to_id?: string;
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

export interface TechnicianFull {
  id: string;
  user_id: string;
  employee_number?: string;
  specialty?: string;
  shift?: string;
  hourly_rate?: number;
  certifications: string[];
  active: boolean;
  created_at: string;
  full_name?: string;
  email?: string;
}

export interface TechnicianCreate {
  user_id: string;
  employee_number?: string;
  specialty?: string;
  shift?: string;
  hourly_rate?: number;
  certifications?: string[];
}

export interface LaborRecord {
  id: string;
  work_order_id: string;
  technician_id: string;
  date: string;
  hours_worked: number;
  hourly_rate?: number;
  labor_cost?: number;
  activity?: string;
  notes?: string;
  created_at: string;
}

export interface WOPart {
  id: string;
  work_order_id: string;
  stock_item_id?: string;
  part_number?: string;
  description: string;
  quantity: number;
  unit: string;
  unit_cost?: number;
  total_cost?: number;
  supplier?: string;
  notes?: string;
  created_at: string;
}

export interface WOCost {
  id: string;
  work_order_id: string;
  transaction_type: string;
  description: string;
  amount: number;
  currency: string;
  reference?: string;
  date: string;
  notes?: string;
  created_at: string;
}

export interface WOCostSummary {
  labor_total: number;
  parts_total: number;
  other_total: number;
  grand_total: number;
}

export interface WOAction {
  id: string;
  work_order_id: string;
  author_id?: string;
  action_type: string;
  content?: string;
  old_value?: string;
  new_value?: string;
  created_at: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  user_id: number | string;
  name: string;
  language?: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}
