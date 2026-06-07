export type UserRole =
  | 'operator'
  | 'technician'
  | 'supervisor'
  | 'maintenance_director'
  | 'plant_manager'
  | 'director'
  | 'admin';

export type WorkOrderStatus = 'open' | 'in_progress' | 'on_hold' | 'completed' | 'cancelled';
export type WorkOrderType = 'corrective' | 'preventive' | 'predictive' | 'inspection' | 'improvement';
export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type WorkOrderSource = 'manual' | 'ticket';
export type MachineStatus = 'running' | 'stopped' | 'maintenance' | 'idle' | 'planned_stop';
export type StopCategoryType = 'planned' | 'unplanned' | 'maintenance';
export type OperatorShift = 'morning' | 'afternoon' | 'night' | 'all';
export type PageLanguage = 'en' | 'fr' | 'es';
export type HourlyRateCurrency = 'CAD' | 'USD' | 'EUR';
export type JobOrderStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type JobOrderSource = 'manual' | 'erp';

export interface User {
  id: string;
  name: string;
  email: string;
  active: boolean;
  role?: UserRole;
  language?: string;
  avatar_url?: string;
  phone?: string;
  job_title?: string;
  last_login_at?: string;
  must_change_password?: boolean;
  invited_by_id?: string;
  invited_at?: string;
  created_at?: string;
}

export interface UserPermission {
  id: string;
  resource: string;
  action: string;
  granted: boolean;
  plant_id?: string;
}

export interface UserInviteRequest {
  email: string;
  role: UserRole;
  plant_id?: string;
}

export interface UserAdminUpdate {
  name?: string;
  language?: string;
  active?: boolean;
  role?: UserRole;
  phone?: string;
  job_title?: string;
  avatar_url?: string;
  must_change_password?: boolean;
}

export interface Equipment {
  id: string;
  plant_id: string;
  code: string;
  name: string;
  location?: string;
  description?: string;
  manufacturer?: string;
  model?: string;
  serial_number?: string;
  manufacturing_year?: number;
  criticality: string;
  status: string;
  hour_meter: number;
  specifications?: Record<string, unknown>;
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
  executor_name?: string;
  ticket_id?: string;
  ticket_number?: string;
  source?: WorkOrderSource;
  scheduled_date?: string;
  scheduled_start_time?: string;
  scheduled_end_time?: string;
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
  total_minutes?: number;
  actual_downtime_minutes?: number;
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
  executor_id?: string;
  estimated_hours?: number;
  notes?: string;
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
  specialty?: string;
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
  technician_name?: string;
  date: string;
  hours_worked: number;
  hourly_rate?: number;
  labor_cost?: number;
  activity?: string;
  notes?: string;
  started_at?: string;
  stopped_at?: string;
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
  role?: UserRole;
  must_change_password?: boolean;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface MaintenancePlan {
  id: string;
  equipment_id: string;
  equipment_name?: string;
  name: string;
  description?: string;
  trigger_type?: string;
  interval_days?: number;
  interval_hours?: number;
  last_executed_at?: string;
  next_execution_at?: string;
  active: boolean;
}

export interface KPISummary {
  mttr_hours: number;
  backlog_count: number;
  pm_compliance_pct: number;
  total_cost_cad: number;
  period_days: number;
}

export interface BacklogData {
  total: number;
  buckets: { label: string; count: number }[];
}

export interface MTTRItem {
  equipment: string;
  code: string;
  avg_repair_hours: number;
  repairs: number;
}

export interface CostItem {
  type: string;
  total: number;
}

// ── Maintenance Alerts & Tickets ──────────────────────────────────────────────

export type AlertPriority  = 'low' | 'medium' | 'high' | 'critical';
export type AlertStatus    = 'new_alert' | 'assigned' | 'in_progress' | 'resolved' | 'cancelled';
export type AlertShift     = 'morning' | 'afternoon' | 'night';
export type TicketStatus   = 'open' | 'in_progress' | 'on_hold_parts' | 'on_hold_ext' | 'completed' | 'cancelled';
export type AlertProblemType =
  | 'mechanical' | 'electrical' | 'pneumatic' | 'sensor'
  | 'safety_risk' | 'quality_impact' | 'machine_stop' | 'preventive_request' | 'other';

export interface Machine {
  id:                       string;
  name:                     string;
  code?:                    string;
  department?:              string;
  location?:                string;
  is_active:                boolean;
  current_status?:          MachineStatus;
  current_operator?:        string;
  current_shift?:           string;
  current_job_number?:      string;
  last_maintenance_at?:     string;
  last_stop_at?:            string;
  last_start_at?:           string;
  page_slug?:               string;
  page_language?:           PageLanguage;
  target_availability_pct?: number;
  target_count?:            number;
  target_count_per_shift?:  number;
  shifts_config?:           Record<string, { start: string; end: string }> | null;
  hourly_rate?:             number;
  hourly_rate_currency?:    HourlyRateCurrency;
  show_production_panel?:   boolean;
  show_reject_panel?:       boolean;
  show_availability_gauge?: boolean;
  show_job_number?:         boolean;
  custom_color?:            string;
  display_name?:            string;
  created_at:               string;
}

export interface StopSubcategoryOut {
  id:                   string;
  category_id:          string;
  name:                 string;
  name_en?:             string;
  name_fr?:             string;
  name_es?:             string;
  icon:                 string;
  color?:               string;
  comment_required?:    boolean;
  triggers_maintenance: boolean;
  is_active:            boolean;
  sort_order:           number;
}

export interface StopCategoryOut {
  id:                   string;
  machine_id?:          string;
  name:                 string;
  name_en?:             string;
  name_fr?:             string;
  name_es?:             string;
  type:                 StopCategoryType;
  icon:                 string;
  color:                string;
  comment_required?:    boolean;
  triggers_maintenance?: boolean;
  is_active:            boolean;
  is_global?:           boolean;
  sort_order:           number;
  subcategories:        StopSubcategoryOut[];
}

export interface RejectSubcategoryOut {
  id:                string;
  category_id:       string;
  name:              string;
  name_en?:          string;
  name_fr?:          string;
  name_es?:          string;
  icon?:             string;
  color?:            string;
  comment_required?: boolean;
  is_active:         boolean;
  sort_order:        number;
}

export interface RejectCategoryOut {
  id:                string;
  machine_id?:       string;
  name:              string;
  name_en?:          string;
  name_fr?:          string;
  name_es?:          string;
  icon?:             string;
  color?:            string;
  comment_required?: boolean;
  is_active:         boolean;
  is_global?:        boolean;
  sort_order:        number;
  subcategories:     RejectSubcategoryOut[];
}

export interface RejectLogCreate {
  category_id?:    string;
  subcategory_id?: string;
  quantity:        number;
  operator_id?:    string;
  shift?:          string;
  job_number?:     string;
  comment?:        string;
}

export interface JobOrder {
  id:               string;
  job_number:       string;
  machine_id?:      string;
  description?:     string;
  target_quantity?: number;
  status:           JobOrderStatus;
  source:           JobOrderSource;
  started_at?:      string;
  completed_at?:    string;
  created_at:       string;
}

export interface StopCategoryMini {
  id:    string;
  name:  string;
  icon:  string;
  color: string;
  type:  string;
}

export interface MachineStopOut {
  id:               string;
  machine_id:       string;
  started_at:       string;
  ended_at?:        string;
  duration_minutes?: number;
  comments?:        string;
  justified_by?:    string;
  ticket_id?:       string;
  category?:        StopCategoryMini;
  subcategory?: {
    id: string; name: string; icon: string; color?: string; triggers_maintenance: boolean;
  };
}

export interface MachineOperatorOut {
  id:            string;
  machine_id:    string;
  user_id?:      string;
  name:          string;
  employee_code?: string;
  shift:         OperatorShift;
  is_active:     boolean;
  created_at:    string;
}

export interface MESDataExtended {
  production_count:       number;
  target:                 number;
  oee_pct:                number;
  availability_pct:       number;
  reject_count:           number;
  downtime_today_minutes: number;
  is_placeholder:         boolean;
}

export interface TicketForMachine {
  id:                      string;
  ticket_number:           string;
  status:                  string;
  priority:                string;
  problem_type?:           string;
  description?:            string;
  assigned_to_name?:       string;
  opened_at:               string;
  opened_by_technician_at?: string;
  work_order_id?:          string;
  work_order_number?:      string;
}

export interface MachinePageData extends Machine {
  open_tickets: TicketForMachine[];
}

export interface StopCreateRequest {
  stop_category_id?:    string;
  stop_subcategory_id?: string;
  comments?:            string;
  justified_by?:        string;
}

export interface MachineConfigUpdate {
  display_name?:            string;
  page_language?:           string;
  custom_color?:            string;
  target_availability_pct?: number;
  target_count?:            number;
  target_count_per_shift?:  number;
  hourly_rate?:             number;
  hourly_rate_currency?:    HourlyRateCurrency;
  show_production_panel?:   boolean;
  show_reject_panel?:       boolean;
  show_availability_gauge?: boolean;
  show_job_number?:         boolean;
}

export interface MachineOperatorCreate {
  name:           string;
  employee_code?: string;
  shift:          OperatorShift;
  user_id?:       string;
}

export interface MaintenanceRequestCreate {
  problem_type:  string;
  priority:      string;
  description?:  string;
  operator_name: string;
  shift?:        string;
}

export interface MESData {
  production_count:       number;
  target:                 number;
  oee_pct:                number;
  downtime_today_minutes: number;
  is_placeholder:         boolean;
}

export interface MaintenanceAlert {
  id:               string;
  alert_number:     string;
  machine_id:       string;
  machine_name?:    string;
  department?:      string;
  problem_type:     AlertProblemType;
  priority:         AlertPriority;
  description?:     string;
  created_by?:      string;
  shift?:           AlertShift;
  status:           AlertStatus;
  assigned_to_id?:  string;
  assigned_to_name?: string;
  ticket_id?:       string;
  escalation_level: number;
  escalated_at?:    string;
  is_overdue:       boolean;
  created_at:       string;
  updated_at?:      string;
}

export interface AlertCreate {
  machine_id:   string;
  department?:  string;
  problem_type: AlertProblemType;
  priority:     AlertPriority;
  description?: string;
  created_by:   string;
  shift?:       AlertShift;
}

export interface TicketComment {
  id:         string;
  ticket_id:  string;
  author:     string;
  comment:    string;
  created_at: string;
}

export interface MaintenanceTicket {
  id:                          string;
  ticket_number:               string;
  alert_id?:                   string;
  machine_id:                  string;
  machine_name?:               string;
  priority:                    AlertPriority;
  status:                      TicketStatus;
  assigned_to_id?:             string;
  assigned_to_name?:           string;
  suggested_technician_id?:    string;
  reported_at?:                string;
  work_order_id?:              string;
  work_order_number?:          string;
  work_order_status?:          string;
  problem_type?:               AlertProblemType;
  description?:                string;
  machine_page_source?:        boolean;
  opened_by_technician_at?:    string;
  closed_by_technician_at?:    string;
  opened_at:                   string;
  started_at?:                 string;
  completed_at?:               string;
  diagnosis?:                  string;
  corrective_action?:          string;
  parts_used?:                 PartUsed[];
  estimated_downtime_minutes?: number;
  total_intervention_minutes?: number;
  current_escalation_level:   number;
  last_updated_at?:            string;
  comments?:                   TicketComment[];
}

export interface PartUsed {
  name:     string;
  qty:      number;
  unit?:    string;
  part_no?: string;
}

export interface TicketSummary {
  id:                       string;
  ticket_number:            string;
  machine_name?:            string;
  priority:                 string;
  problem_type:             string;
  status:                   string;
  opened_at:                string;
  is_overdue:               boolean;
  current_escalation_level: number;
  work_order_id?:           string;
}

export interface WOSummary {
  id:                   string;
  wo_number:            string;
  ticket_id?:           string;
  ticket_number?:       string;
  machine_name?:        string;
  priority:             string;
  status:               string;
  opened_at:            string;
  executor_id?:         string;
  executor_name?:       string;
  scheduled_date?:      string;
  scheduled_start_time?: string;
  scheduled_end_time?:  string;
}

export interface SupervisorOverview {
  pending_tickets: TicketSummary[];
  unassigned_wos:  WOSummary[];
  unscheduled_wos: WOSummary[];
}

export interface StockItem {
  id:                   string;
  plant_id:             string | null;
  code:                 string;
  name:                 string;
  description:          string;
  category:             string;
  part_class:           string;
  unit:                 string;
  quantity:             number;
  min_quantity:         number | null;
  unit_cost:            number | null;
  warehouse:            string;
  location:             string;
  supplier_id:          string | null;
  supplier_name:        string | null;
  supplier_code:        string | null;
  interal_product_id:   string | null;
  notes:                string;
  is_low_stock:         boolean;
}

export interface StockItemListResponse {
  total:           number;
  low_stock_count: number;
  items:           StockItem[];
}

export interface Supplier {
  id:            string;
  code:          string;
  name:          string;
  contact_name:  string | null;
  email:         string | null;
  phone:         string | null;
  fax:           string | null;
  website:       string | null;
  address:       string | null;
  city:          string | null;
  country:       string | null;
  category:      string | null;
  payment_terms: string | null;
  currency:      string;
  lead_time_days: number | null;
  rating:        number | null;
  notes:         string | null;
  is_active:     boolean;
  created_at:    string | null;
  updated_at:    string | null;
  item_count?:   number;
  order_count?:  number;
  open_order_count?: number;
}

export type PurchaseOrderStatus = 'draft' | 'sent' | 'confirmed' | 'received' | 'cancelled';

export interface PurchaseOrderItem {
  id:                string;
  order_id:          string;
  stock_item_id:     string | null;
  description:       string;
  quantity:          number;
  unit_cost:         number;
  total_cost:        number;
  received_quantity: number;
  notes:             string | null;
}

export interface PurchaseOrder {
  id:            string;
  order_number:  string;
  supplier_id:   string;
  supplier_name: string | null;
  supplier_code: string | null;
  status:        PurchaseOrderStatus;
  order_date:    string;
  expected_date: string | null;
  received_date: string | null;
  total_amount:  number | null;
  currency:      string;
  notes:         string | null;
  created_by_id: string | null;
  created_at:    string;
  updated_at:    string | null;
  item_count:    number;
  items?:        PurchaseOrderItem[];
}

export interface SupplierDashboard {
  total_suppliers:         number;
  active_suppliers:        number;
  open_purchase_orders:    number;
  low_stock_with_supplier: number;
  by_category:             { category: string; count: number }[];
}

export interface InventoryCategories {
  categories:  string[];
  part_classes: string[];
  warehouses:  string[];
}

export interface InventoryDashboard {
  total_items:      number;
  low_stock_count:  number;
  zero_stock_count: number;
  by_category:      { category: string; count: number }[];
}

export interface InventoryMovement {
  id:              string;
  stock_item_id:   string;
  work_order_id?:  string;
  movement_type:   'deduction' | 'addition' | 'adjustment';
  quantity:        number;
  quantity_before: number;
  quantity_after:  number;
  unit_cost?:      number;
  notes?:          string;
  created_at:      string;
}

export interface MachineHistoryEntry {
  id:                string;
  event_type:        string;
  problem_type?:     string;
  description?:      string;
  diagnosis?:        string;
  corrective_action?: string;
  parts_used:        PartUsed[];
  technician_name?:  string;
  downtime_minutes?: number;
  total_minutes?:    number;
  occurred_at:       string;
  completed_at?:     string;
  work_order_id?:    string;
  ticket_id?:        string;
}

export interface MaintenanceDashboardData {
  open_alerts:          number;
  open_tickets:         number;
  critical_tickets:     number;
  overdue_alerts:       number;
  avg_resolution_hours: number;
  by_machine:           { machine: string; count: number }[];
  by_problem_type:      { type: string; count: number }[];
  by_technician:        { technician: string; count: number }[];
  by_escalation:        { level: string; count: number }[];
  by_ticket_status:     { status: string; count: number }[];
}
