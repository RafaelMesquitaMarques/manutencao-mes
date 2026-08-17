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
export type WorkOrderSource = 'manual' | 'ticket' | 'pm';
export type MachineStatus = 'running' | 'stopped' | 'maintenance' | 'idle' | 'planned_stop' | 'unjustified' | 'intervention';
export type StopCategoryType = 'planned' | 'unplanned' | 'maintenance';
export type OperatorShift = 'morning' | 'afternoon' | 'night' | 'all';
export type PageLanguage = 'en' | 'fr' | 'es';
export type HourlyRateCurrency = 'CAD' | 'USD' | 'EUR';
export type JobOrderStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type JobOrderSource = 'manual' | 'erp' | 'cortex' | 'smart_label';

export interface User {
  id: string;
  name: string;
  nickname?: string | null;
  email: string;
  active: boolean;
  role?: UserRole;
  language?: string;
  temp_unit?: 'C' | 'F';
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
  nickname?: string;
  email?: string;
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
  /** Effective operational status (kiosk machine / tickets / parent) — list endpoint only */
  live_status?: string | null;
  asset_type?: 'production' | 'auxiliary';
  /** Explicit 3D map shape ('pit_stop', 'assembly_line', …) — map zones, not regular assets */
  block_kind?: string | null;
  subtype?: string | null;
  function_label?: string | null;
  /** Machine photo — same image the factory-map block uses */
  icon_url?: string | null;
  model_url?: string | null;
  height_3d?: number | null;
  parent_equipment_id?: string | null;
  department?: string | null;
  cost_center?: string | null;
  family?: string | null;
  pm_strategy?: string | null;
  cleaning_priority?: string | null;
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
  estimated_hours?: number;
  from_iot: boolean;
  total_minutes?: number;
  actual_downtime_minutes?: number;
  completion_ratio?: number;
  checklist_enforcement?: 'advisory' | 'required' | 'strict';
  board_order?: number | null;
  plan_id?: string;
  occurrence_id?: string;
  created_at?: string;
  updated_at?: string;
  intervention_parts?: InterventionPartOut[];
  technicians?: WOTechnician[];
}

export interface WOTechnician {
  technician_id: string;
  user_id?: string;
  name?: string;
  specialty?: string;
  is_primary?: boolean;
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
  availability?: TechnicianAvailability | null;
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
  hours_worked: number;                 // RAW assigned time (feeds repair_hours/MTTR)
  effective_hours?: number;             // after deducting non-working intervals → drives labor_cost
  deducted_minutes?: number;            // raw − effective (breaks/lunch/off-shift/unavailability)
  overtime_approved?: boolean;
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
  labor_total: number;            // effective labor cost (what is billed)
  parts_total: number;
  other_total: number;
  grand_total: number;
  labor_raw_hours?: number;       // raw assigned time
  labor_effective_hours?: number; // after deductions
  labor_deducted_minutes?: number;
}

// ─── Shift schedules, breaks, availability & unavailability ───────────────────

export type AvailabilityStatus =
  | 'available' | 'inactive' | 'on_vacation' | 'unavailable'
  | 'off_shift' | 'at_lunch' | 'on_break';

export interface TechnicianAvailability {
  status: AvailabilityStatus;
  available: boolean;
  should_warn: boolean;
  detail?: string | null;
  has_schedule: boolean;
  announced?: boolean;          // break confirmed live by the technician (not inferred from schedule)
  since?: string | null;        // ISO — when the announced break started
}

export type ShiftBreakKind = 'lunch' | 'break' | 'pause';

// A break the technician announced live from My Work (presence, not payroll).
// An open row (ended_at null) means they are currently on break.
export interface TechnicianBreak {
  id: string;
  technician_id: string;
  kind: ShiftBreakKind;
  started_at: string;           // ISO
  ended_at?: string | null;
}

export interface ShiftBreak {
  id?: string;
  kind: ShiftBreakKind;
  name: string;
  start_time: string;   // "HH:MM"
  end_time: string;     // "HH:MM"
  paid: boolean;
}

export interface ShiftTemplate {
  id: string;
  plant_id?: string | null;
  key: string;
  name: string;
  start_time: string;   // "HH:MM"
  end_time: string;     // "HH:MM"
  active: boolean;
  breaks: ShiftBreak[];
}

export type UnavailabilityType =
  | 'vacation' | 'sick' | 'absence' | 'training' | 'unavailable' | 'other';

export interface TechnicianUnavailability {
  id: string;
  technician_id: string;
  type: UnavailabilityType;
  start_date: string;   // ISO date
  end_date: string;     // ISO date
  notes?: string | null;
  created_by_id?: string | null;
  created_at: string;
  technician_name?: string | null;
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
  description?: string;
  expected_result?: string | null;
  template_task_id?: string | null;
  proof_photo_url?: string | null;
  media?: { id: string; media_type: 'image' | 'video' | 'link'; url: string; caption?: string | null; sort_order: number }[];
  is_required: boolean;
  is_completed: boolean;
  completed_at?: string;
  completed_by_id?: string;
  sort_order: number;
}

export interface PlantMembership {
  plant_id: string;
  code: string;
  name: string;
  role: UserRole;
  is_default: boolean;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  user_id: number | string;
  name: string;
  nickname?: string | null;
  language?: string;
  role?: UserRole;
  must_change_password?: boolean;
  plants?: PlantMembership[];
  default_plant_id?: string | null;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

// ─── TPM Preventive Maintenance ────────────────────────────────────────────────

export type PmFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'semiannual' | 'annual';
export type RecurrenceEndType = 'never' | 'after_occurrences' | 'on_date';
export type OccurrenceStatus = 'scheduled' | 'in_progress' | 'completed' | 'skipped' | 'cancelled';
export type OccurrenceCompliance = 'on_time' | 'early' | 'late';

export interface PmTaskMedia {
  id: string;
  task_id: string;
  media_type: 'image' | 'video' | 'link';
  url: string;
  caption?: string | null;
  sort_order: number;
}

export interface PmTemplateTask {
  id: string;
  template_id: string;
  description: string;
  expected_result?: string | null;
  sort_order: number;
  is_required: boolean;
  media: PmTaskMedia[];
}

export interface PmTemplate {
  id: string;
  plant_id?: string;
  equipment_id: string;
  equipment_name?: string;
  frequency_type: PmFrequency;
  name: string;
  description?: string;
  estimated_hours: number;
  is_active: boolean;
  sort_order: number;
  enforcement?: 'advisory' | 'required' | 'strict';
  tasks: PmTemplateTask[];
}

export interface PmTemplateListResponse {
  total: number;
  items: PmTemplate[];
}

export interface PlanRecommendedPart {
  id: string;
  plan_id: string;
  stock_item_id?: string;
  item_code?: string;
  item_description?: string;
  quantity_recommended: number;
  unit?: string;
}

export interface MaintenancePlan {
  id: string;
  equipment_id: string;
  equipment_name?: string;
  plant_id?: string;
  name: string;
  description?: string;

  pm_template_id?: string;
  pm_template_name?: string;
  plan_type?: string;

  frequency_type?: PmFrequency;
  frequency_value?: number;
  frequency_days?: number;
  frequency_hours?: number;
  weekdays?: string;
  start_date?: string;

  recurrence_end_type?: RecurrenceEndType;
  recurrence_end_value?: number;
  recurrence_end_date?: string;

  lead_time_days?: number;
  assigned_technician_id?: string;
  assigned_technician_name?: string;
  priority?: string;
  estimated_hours?: number;
  is_active: boolean;

  next_due_date?: string;
  next_due_hours?: number;
  total_occurrences?: number;
  created_by_id?: string;
  created_at: string;

  recommended_parts: PlanRecommendedPart[];
}

export interface MaintenancePlanListResponse {
  total: number;
  items: MaintenancePlan[];
  overdue_count: number;
  due_this_week: number;
}

export interface PlanOccurrence {
  id: string;
  plan_id: string;
  plan_name?: string;
  plant_id?: string;
  equipment_id?: string;
  equipment_name?: string;
  work_order_id?: string;
  work_order_number?: string;

  scheduled_date: string;
  actual_date?: string;

  is_overridden: boolean;
  override_date?: string;
  override_note?: string;

  is_cancelled: boolean;
  cancel_reason?: string;

  status: OccurrenceStatus;
  compliance?: OccurrenceCompliance;
  days_late?: number;

  reminder_sent: boolean;
  overdue_alert_sent: boolean;
  created_at: string;
}

export interface PlanOccurrenceListResponse {
  total: number;
  items: PlanOccurrence[];
}

export interface PlanCalendarItem {
  id: string;
  plan_id: string;
  plan_name: string;
  equipment_id?: string;
  equipment_name?: string;
  date: string;
  status: OccurrenceStatus;
  compliance?: OccurrenceCompliance;
  is_overridden: boolean;
  is_cancelled: boolean;
  work_order_id?: string;
  priority?: string;
}

export interface PmDashboard {
  total_plans: number;
  active_plans: number;
  overdue_occurrences: number;
  due_this_week: number;
  completed_this_month: number;
  compliance_rate: number | null;
  upcoming: PlanOccurrence[];
  overdue: PlanOccurrence[];
}

export interface KPISummary {
  mttr_hours: number;
  mtta_minutes?: number;
  mtbf_hours?: number;
  availability_pct?: number;
  downtime_hours?: number;
  failures?: number;
  backlog_count: number;
  pm_compliance_pct: number;
  total_cost_cad: number;
  parts_per_hour?: number;
  performance_pct?: number;
  quality_pct?: number;
  oee_pct?: number;
  current_status?: string | null;
  operator?: string | null;
  period_days: number;
}

// One subcategory (subgroup) of a downtime category — its share of the group.
export interface DowntimeParetoSub {
  name: string | null;
  name_en: string | null;
  name_fr: string | null;
  name_es: string | null;
  color: string;
  minutes: number;
  count: number;
}

// Downtime grouped by stop reason (Pareto). Names carried in all locales so the
// UI localizes; `type` is the TPM bucket (planned | unplanned | maintenance).
// `subcategories` carries the subgroup breakdown for drill-down.
export interface DowntimeParetoItem {
  name: string | null;
  name_en: string | null;
  name_fr: string | null;
  name_es: string | null;
  color: string;
  type: string | null;
  minutes: number;
  count: number;
  subcategories?: DowntimeParetoSub[];
}

export interface OEETrendPoint {
  date: string;
  availability_pct: number | null;
  performance_pct: number | null;
  quality_pct: number | null;
  oee_pct: number | null;
}

export interface OEEByMachineItem {
  machine_id: string;
  name: string;
  code: string | null;
  availability_pct: number | null;
  performance_pct: number | null;
  quality_pct: number | null;
  oee_pct: number | null;
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

// ── Per-machine reports ───────────────────────────────────────────────────────

export interface TrendPoint {
  date: string;
  pct: number;
}

export interface StopParetoItem {
  category: string;
  color: string;
  type: string;
  count: number;
  minutes: number;
}

export interface MachineReportData {
  machine: {
    id: string;
    name: string;
    code?: string | null;
    department?: string | null;
    equipment_id?: string | null;
    target_availability_pct: number;
  };
  period_days: number;
  availability: { avg_pct: number | null; trend: TrendPoint[] };
  oee: {
    avg_oee_pct: number | null;
    avg_performance_pct: number | null;
    avg_quality_pct: number | null;
    trend: TrendPoint[];
  };
  downtime: {
    unplanned_minutes: number;
    planned_minutes: number;
    stops_count: number;
    pareto: StopParetoItem[];
    sub_pareto?: StopParetoItem[];
  };
  mttr: { hours: number | null; repairs: number };
  mtbf: { hours: number | null; failures: number };
  pm_compliance: { pct: number | null; total: number; on_time: number };
  backlog: { total: number; buckets: { label: string; count: number }[] };
  costs: { total: number; by_type: CostItem[] };
  interventions: {
    count: number;
    avg_response_minutes: number | null;
    avg_duration_minutes: number | null;
    avg_downtime_minutes: number | null;
  };
  tickets: { opened: number; avg_resolution_hours: number | null; avg_resolution_seconds?: number | null };
}

export interface MachineCompareItem {
  machine_id: string;
  name: string;
  code?: string | null;
  department?: string | null;
  target_availability_pct: number;
  availability_pct: number | null;
  oee_pct: number | null;
  downtime_minutes: number;
  stops_count: number;
  mttr_hours: number | null;
  repairs: number;
  failures: number;
  mtbf_hours: number | null;
  total_cost: number;
  backlog_count: number;
  avg_response_minutes: number | null;
}

export interface MachineCompareResponse {
  period_days: number;
  items: MachineCompareItem[];
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
  serial_number?:           string;
  equipment_id?:            string | null;
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
  target_count_per_hour?:   number;
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
  product_name?:    string;
  target_quantity?: number;
  scheduled_date?:  string;
  department?:      string;
  status:           JobOrderStatus;
  source:           JobOrderSource;
  erp_reference?:   string;
  started_at?:      string;
  completed_at?:    string;
  created_at:       string;
}

export interface JobOrderRun {
  id:               string;
  job_order_id:     string;
  machine_id:       string;
  department?:      string;
  started_at:       string;
  ended_at?:        string;
  duration_minutes?: number;
  pieces:           number;
  rejects:          number;
  source:           JobOrderSource;
}

// ── OF cost (productive time × hourly rate; stops excluded) ──────────────────
export interface JobOrderRunCost {
  run_id:             string;
  machine_id:         string;
  machine_name?:      string;
  department?:        string;
  started_at:         string;
  ended_at?:          string;
  gross_minutes:      number;
  stop_minutes:       number;
  productive_minutes: number;
  pieces:             number;
  hourly_rate?:       number;
  currency:           string;
  cost:               number;
  open:               boolean;
}

export interface CostBucket {
  key:                string;
  productive_minutes: number;
  cost:               number;
  pieces:             number;
}

export interface JobOrderCost {
  job_order_id:             string;
  job_number:               string;
  product_name?:            string;
  status:                   JobOrderStatus;
  currency:                 string;
  total_gross_minutes:      number;
  total_stop_minutes:       number;
  total_productive_minutes: number;
  total_pieces:             number;
  total_cost:               number;
  by_machine:               CostBucket[];
  by_department:            CostBucket[];
  runs:                     JobOrderRunCost[];
}

export interface JobOrderCostRow {
  job_order_id:             string;
  job_number:               string;
  product_name?:            string;
  status:                   JobOrderStatus;
  department?:              string;
  total_productive_minutes: number;
  total_pieces:             number;
  total_cost:               number;
}

export interface JobOrderCostReport {
  currency:                 string;
  of_count:                 number;
  factory_total_cost:       number;
  total_productive_minutes: number;
  total_pieces:             number;
  items:                    JobOrderCostRow[];
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
  job_number?:      string;
  operator_name?:   string;
  intervention_started_at?:   string;
  intervention_completed_at?: string;
  wait_minutes?:              number;
  intervention_type_name?:    string;
  intervention_by?:           string;
  intervention_is_preventive?: boolean;
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

/** Details of the OF loaded on the machine (its open run) — Cortex/ERP
 *  enrichment fields are null for a bare kiosk scan. */
export interface MachineJobInfo {
  job_number:            string;
  status:                string;
  source?:               string | null;   // manual | cortex | smart_label | erp
  product_code?:         string | null;
  product_name?:         string | null;
  target_quantity?:      number | null;
  completed_quantity?:   number | null;   // reported by the source system
  produced_here?:        number | null;   // pieces counted on this machine's run
  unit_of_measure?:      string | null;
  operation_code?:       string | null;
  operation_description?: string | null;
  started_at?:           string | null;
  updated_at?:           string | null;
}

export interface MachinePageData extends Machine {
  open_tickets: TicketForMachine[];
  kiosk_layout?: { i: string; x: number; y: number; w: number; h: number }[] | null;
  signal_driven?: boolean;
  current_job?: MachineJobInfo | null;
}

export interface StopCreateRequest {
  stop_category_id?:    string;
  stop_subcategory_id?: string;
  comments?:            string;
  justified_by?:        string;
}

export interface MachineConfigUpdate {
  serial_number?:           string;
  display_name?:            string;
  page_language?:           string;
  custom_color?:            string;
  target_availability_pct?: number;
  target_count?:            number;
  target_count_per_shift?:  number;
  target_count_per_hour?:   number;
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
  assigned_technicians?:       WOTechnician[];
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
  intervention_parts?:         InterventionPartOut[];
}

export interface InterventionPartOut {
  id:               string;
  item_code:        string;
  item_description: string;
  quantity_used:    number;
  unit:             string;
  unit_cost?:       number | null;
  total_cost?:      number | null;
  approval_status:  'pending' | 'approved' | 'rejected';
  approved_at:      string | null;
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
  average_cost:         number | null;
  last_purchase_cost:   number | null;
  last_purchase_date:   string | null;
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

export interface POAttachment {
  id:               string;
  order_id:         string;
  original_name:    string;
  content_type:     string | null;
  size_bytes:       number;
  uploaded_by_name: string | null;
  created_at:       string | null;
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
  cost_center:   string | null;
  scope:         'opex' | 'capex';
  notes:         string | null;
  created_by_id: string | null;
  created_at:    string;
  updated_at:    string | null;
  item_count:    number;
  attachment_count?: number;
  items?:        PurchaseOrderItem[];
  attachments?:  POAttachment[];
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
  avg_resolution_minutes?: number | null;
  avg_resolution_seconds?: number | null;
  by_machine:           { machine: string; count: number }[];
  by_problem_type:      { type: string; count: number }[];
  by_technician:        { technician: string; count: number }[];
  by_escalation:        { level: string; count: number }[];
  by_ticket_status:     { status: string; count: number }[];
  trend:                { date: string; label: string; tickets: number; interventions: number }[];
  bucket_unit:          'day' | 'week';
  period:               { start: string; end: string };
}

export interface DashboardFilters {
  period_days?: number;
  start_date?:  string;
  end_date?:    string;
  machine_ids?: string;
}

// ── Maintenance Intelligence ──────────────────────────────────────────────────

export type IntelRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type InsightType =
  | 'daily_summary' | 'machine_risk' | 'top_irritants'
  | 'trend_analysis' | 'spare_parts' | 'technician_workload' | 'full_report';

export interface AIRecommendation {
  id: string;
  insight_id: string;
  title: string;
  evidence: string;
  impact: string;
  recommendation: string;
  risk_level: IntelRiskLevel;
  related_machine_name?: string | null;
  related_category?: string | null;
  confidence?: number | null;
  status: 'pending' | 'acknowledged' | 'dismissed';
  acknowledged_by?: string | null;
  acknowledged_at?: string | null;
  created_at: string;
}

export interface AIInsight {
  id: string;
  plant_id?: string | null;
  insight_type: InsightType;
  language: string;
  period_start: string;
  period_end: string;
  findings_json: Record<string, unknown>;
  insight_text: string;
  ai_generated: boolean;
  generated_at: string;
  generated_by_model?: string | null;
  recommendations: AIRecommendation[];
}

export interface MachineRiskScore {
  id: string;
  machine_id?: string | null;
  machine_name: string;
  score: number;
  risk_level: IntelRiskLevel;
  hours_since_last_ticket?: number | null;
  historical_mtbf_hours?: number | null;
  recent_ticket_count: number;
  criticality_factor: number;
  computed_at: string;
}

export interface SparePartRiskItem {
  id: string;
  stock_item_id: string;
  part_code: string;
  part_name: string;
  current_qty: number;
  safety_qty: number;
  avg_consumption_30d: number;
  recent_consumption_30d: number;
  risk_level: IntelRiskLevel;
  computed_at: string;
}

export interface GenerateInsightRequest {
  language: string;
  period_days: number;
  insight_type: InsightType;
  plant_id?: string | null;
}

export interface InsightListResponse { total: number; items: AIInsight[] }
export interface MachineRiskListResponse { total: number; items: MachineRiskScore[] }
export interface SparePartRiskListResponse { total: number; items: SparePartRiskItem[] }

export interface InterventionType {
  id: string;
  equipment_id: string | null;
  name: string;
  icon: string;
  color: string;
  sort_order: number;
  is_active: boolean;
}

export interface InterventionTechnicianEntry {
  id: string;
  technician_id: string | null;
  name: string;
  checked_in_at: string | null;
}

export interface MachineIntervention {
  id: string;
  machine_id: string | null;
  equipment_id: string | null;
  ticket_id: string | null;
  status: 'waiting' | 'in_progress' | 'completed';
  called_at: string;
  started_at: string | null;
  completed_at: string | null;
  called_by_id: string | null;
  started_by_id: string | null;
  operator_note: string | null;
  mechanic_note: string | null;
  intervention_type_name: string | null;
  started_by_name?: string | null;
  technicians?: InterventionTechnicianEntry[];
}

export interface MachineOperatorState {
  machine: {
    id: string;
    name: string;
    code: string;
    department: string;
    location: string;
    status: string;
  };
  equipment: {
    id: string;
    name: string;
    code: string;
    location: string;
    hour_meter: number;
  } | null;
  active_intervention: MachineIntervention | null;
  last_intervention: MachineIntervention | null;
  open_tickets_count: number;
  last_maintenance_days_ago: number | null;
}
