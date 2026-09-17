import api from './axios';

export interface CostMonth {
  month: number;      // 1..12
  actual: number;
  budget: number;
}

export interface CostSummary {
  year: number;
  currency: string;
  months: CostMonth[];
  total_actual: number;
  total_budget: number;
  ytd_actual: number;
  ytd_budget: number;
}

export interface BudgetItem {
  month: number;
  amount: number;
}

export const fetchCostSummary = async (year?: number): Promise<CostSummary> => {
  const { data } = await api.get<CostSummary>('/api/costs/summary', {
    params: year ? { year } : {},
  });
  return data;
};

export const fetchBudgets = async (year: number): Promise<BudgetItem[]> => {
  const { data } = await api.get<BudgetItem[]>('/api/costs/budgets', { params: { year } });
  return data;
};

export const saveBudgets = async (year: number, items: BudgetItem[]): Promise<BudgetItem[]> => {
  const { data } = await api.put<BudgetItem[]>('/api/costs/budgets', { year, items });
  return data;
};

// ─── Cost centers — budgets & P&L ──────────────────────────────────────────────

// The comparative is split into scopes: OPEX (running maintenance) and CAPEX
// (improvement work orders). Internal labor is excluded from both — it only
// appears in the informative by-machine view.
export type CostScope = 'opex' | 'capex';

// The plant runs from two sites, told apart by the cost-center name (Mirabel
// cost centers carry "Mirabel"). A null site means both sites combined.
// QS = Saint-Jérôme, QM = Mirabel.
export type CostSite = 'QS' | 'QM';

export interface SapComment {
  pos: number;                         // 1..12 slot in the months map
  account: string;
  text: string;
}

export interface CostCenterPnL {
  cost_center: string;
  code: string | null;                                    // SAP cost-center code (e.g. "CA101020")
  budget: Record<CostScope, number[]>;                    // per scope, 12 slots
  actual: Record<CostScope, number[]>;                    // per scope, 12 slots
  committed: Record<CostScope, number[]>;                 // open-PO commitments, per scope, 12 slots
  by_type: Record<CostScope, Record<string, number[]>>;   // per scope, expense type → 12 slots
  comments: SapComment[];                                 // SAP analyst notes (SAP years only)
}

// Which calendar (year, month) sits behind each of the 12 slots. Calendar years
// map Jan..Dec; SAP fiscal years map Dec of year-1 .. Nov.
export interface MonthMapEntry {
  year: number;
  month: number;
}

export interface CostPnL {
  year: number;
  currency: string;
  fiscal: boolean;                     // true = SAP fiscal year (Dec–Nov)
  source: 'sap' | 'internal';          // official OPEX series
  month_map: MonthMapEntry[];
  cost_centers: CostCenterPnL[];
  totals: {
    budget: Record<CostScope, number[]>;
    actual: Record<CostScope, number[]>;
    // Open-PO commitments per scope, 12 slots (feed the forecast)
    committed: Record<CostScope, number[]>;
    // Platform-tracked OPEX (coverage indicator) — only on SAP years
    tracked_actual: number[] | null;
  };
  // Plant-wide actuals by WO type (corrective, preventive…), each by expense type, monthly [12]
  by_wo_type: Record<string, Record<string, number[]>>;
  prev_year: number;
  // Previous-year actuals per scope, monthly [12]
  prev_actual: Record<CostScope, number[]>;
  // Current-month daily actuals per scope (null unless viewing the current year) —
  // used to project the month landing from the day-of-month run rate.
  current_month: {
    month: number;
    today: number;
    days_in_month: number;
    daily: Record<CostScope, number[]>;
    // Spend per expense type from day 1 through today (labor excluded)
    mtd_by_type: Record<CostScope, Record<string, number>>;
  } | null;
}

export interface CostCenterBudgetRow {
  cost_center: string;
  code?: string | null;          // SAP cost-center code (e.g. "CA101020")
  months: number[];              // 12 months
}

export interface CostCenterBudgets {
  rows: CostCenterBudgetRow[];
  read_only: boolean;            // SAP-imported OPEX years are read-only
  source: 'sap' | 'internal';
  month_map: MonthMapEntry[] | null;   // fiscal slot → calendar (year, month), SAP only
}

export interface CCBudgetItem {
  cost_center: string;
  month: number;
  amount: number;
}

export const fetchCostPnL = async (year?: number, site?: CostSite | null): Promise<CostPnL> => {
  const { data } = await api.get<CostPnL>('/api/costs/pnl', {
    params: { ...(year ? { year } : {}), ...(site ? { site } : {}) },
  });
  return data;
};

export const fetchCostCenters = async (): Promise<string[]> => {
  const { data } = await api.get<string[]>('/api/costs/cost-centers');
  return Array.isArray(data) ? data : [];
};

export const fetchCostCenterBudgets = async (year: number, kind: CostScope, site?: CostSite | null): Promise<CostCenterBudgets> => {
  const { data } = await api.get<CostCenterBudgets>('/api/costs/cost-center-budgets', {
    params: { year, kind, ...(site ? { site } : {}) },
  });
  return data;
};

export const saveCostCenterBudgets = async (year: number, kind: CostScope, items: CCBudgetItem[]): Promise<CostCenterBudgets> => {
  const { data } = await api.put<CostCenterBudgets>('/api/costs/cost-center-budgets', { year, kind, items });
  return data;
};

// ─── Cost by machine ──────────────────────────────────────────────────────────

export interface MachineCost {
  equipment_id: string | null;
  name: string;
  code: string | null;
  monthly: number[];                   // 12 months
  by_type: Record<string, number[]>;   // actual by expense type, each 12 months
}

export interface CostByMachine {
  year: number;
  currency: string;
  machines: MachineCost[];
}

export const fetchCostByMachine = async (year?: number, fiscal?: boolean, site?: CostSite | null): Promise<CostByMachine> => {
  const { data } = await api.get<CostByMachine>('/api/costs/by-machine', {
    params: { ...(year ? { year } : {}), ...(fiscal ? { fiscal: true } : {}), ...(site ? { site } : {}) },
  });
  return data;
};

// ─── Transactions drill-down (audit trail) ────────────────────────────────────

export interface CostTransactionLine {
  date: string;                        // ISO date
  source: 'wo_cost' | 'wo_part' | 'intervention_part';
  expense_type: string;
  wo_type: string | null;
  description: string;
  amount: number;
  wo_id: string | null;
  wo_number: string | null;
  wo_title: string | null;
  equipment_name: string | null;
  equipment_code: string | null;
  cost_center: string;
}

export interface CostTransactions {
  year: number;
  currency: string;
  count: number;
  total_amount: number;
  truncated: boolean;
  lines: CostTransactionLine[];
}

export const fetchCostTransactions = async (params: {
  year: number; month_from?: number; month_to?: number;
  cost_center?: string; equipment_id?: string; scope?: CostScope; site?: CostSite | null; fiscal?: boolean;
}): Promise<CostTransactions> => {
  const { data } = await api.get<CostTransactions>('/api/costs/transactions', { params });
  return data;
};

// ─── Spend by supplier (procurement report) ───────────────────────────────────

export interface SupplierOrderLine {
  order_number: string;
  date: string;                        // ISO date
  status: string;                      // PO status (received, sent, confirmed…)
  amount: number;
  scope: CostScope;
  cost_center: string | null;
}

export interface SupplierSpend {
  supplier: string;
  total: number;                       // po_total + parts_total
  po_total: number;
  parts_total: number;                 // WO parts naming this supplier
  received: number;                    // received-PO spend (actual)
  committed: number;                   // open-PO spend (sent/confirmed)
  po_count: number;
  by_scope: Record<CostScope, number>;
  orders: SupplierOrderLine[];         // capped list, for drill-down
}

export interface CostBySupplier {
  year: number;
  currency: string;
  site: CostSite | null;
  status: 'all' | 'received';
  total_amount: number;
  supplier_count: number;
  suppliers: SupplierSpend[];
}

export const fetchCostBySupplier = async (params: {
  year?: number; fiscal?: boolean; site?: CostSite | null; status?: 'all' | 'received';
}): Promise<CostBySupplier> => {
  const { year, fiscal, site, status } = params;
  const { data } = await api.get<CostBySupplier>('/api/costs/by-supplier', {
    params: {
      ...(year ? { year } : {}), ...(fiscal ? { fiscal: true } : {}),
      ...(site ? { site } : {}), ...(status ? { status } : {}),
    },
  });
  return data;
};

// ─── SAP GL import (monthly SAC budget extract) ───────────────────────────────

export interface SapImportResult {
  fiscal_year: number;
  months: number;
  lines: number;
  cost_centers: number;
  total_budget: number;
  total_actual: number;
  currency: string;
}

export const importSapCosts = async (file: File): Promise<SapImportResult> => {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post<SapImportResult>('/api/costs/sap-import', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
};

// ─── Cost-center management ────────────────────────────────────────────────────

export interface CostCenterManaged {
  id: string;
  name: string;
  code: string | null;
  active: boolean;
  sort_order: number;
  departments: string[];
}

export interface ManageCostCenters {
  cost_centers: CostCenterManaged[];
  departments: string[];             // every equipment department available to assign
}

export const fetchManageCostCenters = async (): Promise<ManageCostCenters> => {
  const { data } = await api.get<ManageCostCenters>('/api/costs/cost-centers/manage');
  return data;
};

export const createCostCenter = async (name: string, code?: string): Promise<CostCenterManaged> => {
  const { data } = await api.post('/api/costs/cost-centers', { name, code });
  return data;
};

export const updateCostCenter = async (
  id: string, patch: { name?: string; code?: string | null; active?: boolean; sort_order?: number },
): Promise<CostCenterManaged> => {
  const { data } = await api.patch(`/api/costs/cost-centers/${id}`, patch);
  return data;
};

export const deleteCostCenter = async (id: string): Promise<void> => {
  await api.delete(`/api/costs/cost-centers/${id}`);
};

export const saveDeptMap = async (items: { department: string; cost_center_id: string | null }[]): Promise<void> => {
  await api.put('/api/costs/cost-center-departments', { items });
};

// ─── Cost control layer ───────────────────────────────────────────────────────
//
// Everything below is ADDITIVE to the endpoints above. The rule these payloads
// encode: the SAP ledger and platform-tracked spend are never summed (they can
// be the same economic event), and an open commitment never stacks on top of the
// budget of the month it lands in.

// A slot's state against the CUT-OFF, not the calendar:
//   closed   — posted and finished
//   partial  — the ledger only posted part of it (or the month is still running)
//   awaiting — the month happened, the import did not. NOT a zero-cost month.
//   future   — still ahead
export type SlotStatus = 'closed' | 'partial' | 'awaiting' | 'future';

export interface CostAsOf {
  today: string;
  method: 'sap_posted' | 'run_rate';
  source: 'sap' | 'internal';
  elapsed_slot: number;
  last_closed_slot: number;
  partial_slot: number | null;
  cutoff_slot: number | null;
  cutoff_period: MonthMapEntry | null;
  awaiting_slots: number[];
  slot_status: SlotStatus[];
  posted_slots: number[];
  last_import_at: string | null;
  import_age_days: number | null;
  unposted_elapsed_months: number;
}

export interface ForecastSlot {
  slot: number;
  year: number;
  month: number;
  status: SlotStatus;
  basis: 'actual' | 'partial' | 'forecast';
  budget: number;
  actual: number;
  committed: number;
  adjustment: number;
  forecast: number;
}

export interface ForecastScenario {
  scenario: 'base' | 'favorable' | 'unfavorable';
  total: number;
  overdue_committed: number;
  slots: ForecastSlot[];
}

export interface ForecastAdjustmentRow {
  id: string;
  year: number;
  month: number;
  scope: CostScope;
  kind: 'major_intervention' | 'contract' | 'extraordinary' | 'other';
  amount: number;
  reason: string;
  cost_center: string | null;
  slot: number | null;
}

export interface CostForecast {
  year: number;
  currency: string;
  fiscal: boolean;
  source: 'sap' | 'internal';
  kind: CostScope;
  months: number[];
  month_map: MonthMapEntry[];
  as_of: CostAsOf;
  annual_budget: number;
  annual_actual: number;
  period_budget: number;
  period_actual: number;
  budget_to_date: number;         // budget of the slots up to the cut-off
  actual_to_date: number;         // actual over the SAME slots
  variance_to_date: number;       // the real YTD variance (not the leftover envelope)
  variance_to_date_pct: number | null;
  remaining_budget: number;       // annual budget − actual: the available balance
  committed_open: number;
  adjustments_total: number;
  forecast: number;
  forecast_scenarios: Record<'base' | 'favorable' | 'unfavorable', number>;
  projected_variance: number;
  projected_variance_pct: number | null;
  run_rate: number;
  run_rate_recent: number;
  slots: ForecastSlot[];
  scenarios: Record<'base' | 'favorable' | 'unfavorable', ForecastScenario>;
  assumptions: { key: string; value: unknown; detail?: string }[];
  adjustment_rows: ForecastAdjustmentRow[];
}

export interface CostControlParams {
  year?: number;
  site?: CostSite | null;
  kind?: CostScope;
  month_from?: number;
  month_to?: number;
}

const controlParams = (p: CostControlParams) => ({
  ...(p.year ? { year: p.year } : {}),
  ...(p.site ? { site: p.site } : {}),
  ...(p.kind ? { kind: p.kind } : {}),
  ...(p.month_from ? { month_from: p.month_from } : {}),
  ...(p.month_to ? { month_to: p.month_to } : {}),
});

export const fetchCostForecast = async (p: CostControlParams): Promise<CostForecast> => {
  const { data } = await api.get<CostForecast>('/api/costs/forecast', { params: controlParams(p) });
  return data;
};

// ─── Reconciliation SAP × KAIZO ───────────────────────────────────────────────

export interface ReconCostCenter {
  cost_center: string;
  code: string | null;
  sap_total: number;
  linked: number;
  unlinked: number;
  linked_pct: number | null;
  lines: number;
  linked_lines: number;
}

export interface ReconDuplicate {
  cost_center: string;
  cost_center_code: string;
  account: string;
  account_code: string;
  amount: number;
  occurrences: number;
  positions: number[];
}

export interface CostReconciliation {
  year: number;
  source: 'sap' | 'internal';
  currency: string;
  month_map: MonthMapEntry[];
  as_of: CostAsOf;
  sap_total: number;
  linked_total: number;
  linked_pct: number | null;
  unlinked_total: number;
  unlinked_pct: number | null;
  lines: number;
  linked_lines: number;
  unclassified: Record<'no_cost_center' | 'unmapped_cost_center' | 'no_account',
    { count: number; amount: number }>;
  duplicates: ReconDuplicate[];
  reversals: ReconDuplicate[];
  orphan_links: { fiscal_year: number; pos: number; cost_center_code: string;
    account_code: string; links: number; amount: number }[];
  // Platform-tracked spend over the same window. A COVERAGE figure — never added
  // to sap_total.
  tracked_total: number;
  tracked_coverage_pct: number | null;
  by_cost_center: ReconCostCenter[];
}

export const fetchCostReconciliation = async (p: CostControlParams): Promise<CostReconciliation> => {
  const { data } = await api.get<CostReconciliation>('/api/costs/reconciliation', { params: controlParams(p) });
  return data;
};

export interface SapLineLink {
  id: string;
  target_kind: 'work_order' | 'equipment' | 'purchase_order';
  amount: number;
  note: string | null;
  origin: 'manual' | 'suggested';
  label: string | null;
}

export interface SapLine {
  fiscal_year: number;
  pos: number;
  year: number;
  month: number;
  cost_center: string;
  cost_center_code: string;
  account: string;
  account_code: string;
  budget: number;
  actual: number;
  comment: string | null;
  linked_amount: number;
  links: SapLineLink[];
}

export interface SapLines {
  year: number;
  currency: string;
  count: number;
  total_actual: number;
  truncated: boolean;
  lines: SapLine[];
}

export const fetchSapLines = async (p: CostControlParams & {
  cost_center?: string; account?: string; link?: 'all' | 'linked' | 'unlinked'; q?: string;
}): Promise<SapLines> => {
  const { data } = await api.get<SapLines>('/api/costs/sap-lines', {
    params: {
      ...controlParams(p),
      ...(p.cost_center ? { cost_center: p.cost_center } : {}),
      ...(p.account ? { account: p.account } : {}),
      ...(p.link && p.link !== 'all' ? { link: p.link } : {}),
      ...(p.q ? { q: p.q } : {}),
    },
  });
  return data;
};

export interface LinkCandidate {
  kind: 'work_order' | 'purchase_order';
  id: string;
  label: string;
  amount: number;
  date: string;
  score: number;
  detail: string | null;
  status?: string;
}

export interface LinkSuggestions {
  line: { fiscal_year: number; pos: number; cost_center: string; account: string; actual: number };
  // True when the best candidates are indistinguishable — the UI must not
  // confirm one of them on the user's behalf.
  ambiguous: boolean;
  auto_confirmable: boolean;
  candidates: LinkCandidate[];
}

export const fetchLinkSuggestions = async (p: {
  fiscal_year: number; pos: number; cost_center_code: string; account_code: string;
  site?: CostSite | null;
}): Promise<LinkSuggestions> => {
  const { data } = await api.get<LinkSuggestions>('/api/costs/sap-links/suggestions', {
    params: { ...p, ...(p.site ? { site: p.site } : {}) },
  });
  return data;
};

export const createSapLink = async (body: {
  fiscal_year: number; pos: number; cost_center_code: string; account_code: string;
  target_kind: 'work_order' | 'equipment' | 'purchase_order'; target_id: string;
  amount: number; note?: string; origin?: 'manual' | 'suggested';
}): Promise<{ id: string }> => {
  const { data } = await api.post('/api/costs/sap-links', body);
  return data;
};

export const deleteSapLink = async (id: string): Promise<void> => {
  await api.delete(`/api/costs/sap-links/${id}`);
};

// ─── Commitments (open purchase orders) ───────────────────────────────────────

export interface CommitmentOrder {
  id: string;
  order_number: string;
  supplier: string;
  site: CostSite | null;
  plant_id: string | null;
  cost_center: string | null;
  scope: CostScope;
  status: string;
  order_date: string | null;
  expected_date: string | null;
  received_date: string | null;
  ordered_amount: number;
  received_amount: number;
  open_balance: number;
  item_count: number;
  ordered_qty: number;
  received_qty: number;
  age_days: number | null;
  overdue_days: number;
  partially_received: boolean;
  slot: number | null;
  currency: string;
}

export interface CostCommitments {
  year: number;
  currency: string;
  month_map: MonthMapEntry[];
  orders: CommitmentOrder[];
  totals: { ordered: number; received: number; open: number; overdue: number; count: number };
  // What the purchase-order integration does NOT carry — stated so the UI never
  // implies invoice or asset data it does not have.
  has_invoice_data: boolean;
  has_equipment_link: boolean;
  has_work_order_link: boolean;
  ageing_buckets: { from: number; to: number | null; count: number; amount: number }[];
}

export const fetchCostCommitments = async (p: CostControlParams & { include_received?: boolean }): Promise<CostCommitments> => {
  const { data } = await api.get<CostCommitments>('/api/costs/commitments', {
    params: { ...controlParams(p), ...(p.include_received ? { include_received: true } : {}) },
  });
  return data;
};

// ─── Equipment: cost × reliability ────────────────────────────────────────────

export interface EquipmentAnalysisRow {
  equipment_id: string;
  name: string;
  code: string | null;
  criticality: string;
  department: string | null;
  cost_center: string | null;
  asset_type: string;
  cost: number;
  parts: number;
  services: number;
  labor: number;
  planned_cost: number;
  unplanned_cost: number;
  monthly: number[];
  corrective: number;
  preventive: number;
  other_wo: number;
  interventions: number;
  repeat_failures: number;
  downtime_hours: number;
  mttr_hours: number | null;
  mtbf_hours: number | null;
  operating_hours: number | null;
  cost_per_operating_hour: number | null;
  cost_per_hour_basis: string | null;
  share_pct: number | null;
  attention_score: number;
}

export interface EquipmentAnalysis {
  year: number;
  currency: string;
  month_map: MonthMapEntry[];
  window: { from: string; to: string; days: number };
  equipment: EquipmentAnalysisRow[];
  total_tracked_cost: number;
  // How much of the official ledger the rows above explain. Low coverage means
  // "no cost LINKED", never "no cost".
  coverage: {
    official_total: number;
    tracked_total: number;
    equipment_with_cost: number;
    equipment_total: number;
    source: 'sap' | 'internal';
  };
}

export const fetchEquipmentAnalysis = async (p: CostControlParams): Promise<EquipmentAnalysis> => {
  const { data } = await api.get<EquipmentAnalysis>('/api/costs/equipment-analysis', { params: controlParams(p) });
  return data;
};

export interface RepairReplace {
  available: boolean;
  missing_inputs?: string[];
  reason?: string;
  equipment_id?: string;
  name?: string;
  period_cost?: number;
  annualised_cost?: number | null;
  replacement_cost?: number | null;
  age_years?: number | null;
  downtime_hours?: number;
  repeat_failures?: number;
  criticality?: string;
  cost_ratio_pct?: number | null;
  note?: string;
}

export const fetchRepairReplace = async (equipmentId: string, p: CostControlParams): Promise<RepairReplace> => {
  const { data } = await api.get<RepairReplace>(
    `/api/costs/equipment-analysis/${equipmentId}/repair-replace`, { params: controlParams(p) });
  return data;
};

// ─── Supplier depth ───────────────────────────────────────────────────────────

export interface SupplierAnalysisRow {
  supplier: string;
  monthly: number[];
  prev_monthly: number[];
  total: number;
  prev_total: number;
  delta: number;
  delta_pct: number | null;
  committed: number;
  orders: number;
  by_scope: Record<CostScope, number>;
  emergency: number;
  planned: number;
}

export interface PriceDrift {
  basis: 'stock' | 'desc';
  item: string;
  code: string | null;
  first_date: string;
  first_price: number;
  last_date: string;
  last_price: number;
  change_pct: number;
  purchases: number;
  suppliers: string[];
  exposure: number;
}

export interface SupplierAnalysis {
  year: number;
  prev_year: number;
  currency: string;
  month_map: MonthMapEntry[];
  suppliers: SupplierAnalysisRow[];
  total: number;
  prev_total: number;
  concentration: { hhi: number | null; top3_pct: number | null; top5_pct: number | null; supplier_count: number };
  emergency_rule: { lead_days: number };
  price_drift: PriceDrift[];
}

export const fetchSupplierAnalysis = async (p: CostControlParams): Promise<SupplierAnalysis> => {
  const { data } = await api.get<SupplierAnalysis>('/api/costs/supplier-analysis', { params: controlParams(p) });
  return data;
};

// ─── Cost-center depth ────────────────────────────────────────────────────────

export interface CostCenterAnalysisRow {
  cost_center: string;
  code: string | null;
  actual: number;
  prev_actual: number;
  budget: number;
  budget_to_date: number;
  variance_to_date: number | null;
  delta: number;
  delta_pct: number | null;
  drivers: { account: string; actual: number; prev_actual: number; delta: number }[];
}

export interface CostCenterAnalysis {
  year: number;
  prev_year: number;
  kind: CostScope;
  currency: string;
  cutoff_slot: number | null;
  // False = the previous year was never imported; a YoY delta would be a fiction.
  has_prev: boolean;
  as_of: CostAsOf;
  cost_centers: CostCenterAnalysisRow[];
}

export const fetchCostCenterAnalysis = async (p: CostControlParams): Promise<CostCenterAnalysis> => {
  const { data } = await api.get<CostCenterAnalysis>('/api/costs/cost-center-analysis', { params: controlParams(p) });
  return data;
};

// ─── Inventory / spare parts ──────────────────────────────────────────────────

export interface InventoryAnalysis {
  year: number;
  currency: string;
  window: { from: string; to: string };
  stock_value: number;
  valuation: { valued_items: number; unvalued_items: number; basis_counts: Record<string, number> };
  items_total: number;
  consumption_value: number;
  movement_consumption_value: number;
  top_consumption: { item: string; code: string | null; stock_item_id: string | null;
    value: number; qty: number; uses: number }[];
  by_equipment: { equipment_id: string; name: string | null; value: number; items: number }[];
  critical_count: number;
  stockout_count: number;
  critical_items: { id: string; code: string | null; name: string | null; quantity: number; min_quantity: number }[];
  stockout_items: { id: string; code: string | null; name: string | null; min_quantity: number }[];
  dormant: { id: string; code: string | null; name: string | null; quantity: number;
    value: number; basis: string; last_purchase_date: string | null }[];
  dormant_count: number;
  dormant_value: number;
  // Dormant items with no unit cost — counted, but worth nothing on paper.
  dormant_unvalued: number;
  dormant_days: number;
  // False = no item carries a minimum level, so "nothing critical" would be a
  // false reassurance rather than a finding.
  has_min_levels: boolean;
  emergency_purchases: { order_number: string; supplier: string; order_date: string;
    lead_days: number; amount: number; cost_center: string | null }[];
  emergency_total: number;
  emergency_rule: { lead_days: number };
  movement_rows: number;
  accounting_note: string;
}

export const fetchInventoryAnalysis = async (p: CostControlParams): Promise<InventoryAnalysis> => {
  const { data } = await api.get<InventoryAnalysis>('/api/costs/inventory-analysis', { params: controlParams(p) });
  return data;
};

// ─── Alerts, rules and actions ────────────────────────────────────────────────

export type CostAlertKind =
  | 'forecast_over_budget' | 'cost_increase' | 'recurring_corrective'
  | 'stale_commitments' | 'cc_variance' | 'low_link_coverage' | 'stale_import';

export interface CostAlert {
  kind: CostAlertKind;
  severity: 'critical' | 'high' | 'medium';
  value: number;
  threshold: number;
  amount: number | null;
  subject?: string;
  subject_id?: string;
  evidence: { key: string; value: unknown }[];
  drill: { tab?: string; slot?: number; cost_center?: string; equipment_id?: string };
}

export interface CostAlerts {
  year: number;
  kind: CostScope;
  currency: string;
  as_of: CostAsOf;
  alerts: CostAlert[];
  counts: Record<'critical' | 'high' | 'medium', number>;
}

export const fetchCostAlerts = async (p: CostControlParams): Promise<CostAlerts> => {
  const { data } = await api.get<CostAlerts>('/api/costs/alerts', { params: controlParams(p) });
  return data;
};

export interface CostAlertRule {
  kind: CostAlertKind;
  enabled: boolean;
  threshold: number;
  scope: 'opex' | 'capex' | 'both';
  default_threshold: number;
  configured: boolean;
}

export const fetchCostAlertRules = async (site?: CostSite | null): Promise<{ rules: CostAlertRule[] }> => {
  const { data } = await api.get('/api/costs/alert-rules', { params: site ? { site } : {} });
  return data;
};

export const saveCostAlertRules = async (
  items: { kind: string; enabled: boolean; threshold: number; scope: string }[],
  site?: CostSite | null,
): Promise<void> => {
  await api.put('/api/costs/alert-rules', { items }, { params: site ? { site } : {} });
};

export type ActionStatus = 'open' | 'in_progress' | 'done' | 'cancelled';
// Savings are kept in three separate states on purpose: a deferred expense or a
// maintenance that was simply skipped is NOT a saving and stays 'none'.
export type SavingsType = 'none' | 'potential' | 'implemented' | 'verified';

export interface CostActionRow {
  id: string;
  title: string;
  description: string | null;
  alert_kind: string | null;
  context_kind: string;
  context_ref: string | null;
  owner_id: string | null;
  owner_name: string | null;
  due_date: string | null;
  status: ActionStatus;
  savings_type: SavingsType;
  savings_amount: number | null;
  result_note: string | null;
  fiscal_year: number | null;
  site: CostSite | null;
  created_at: string | null;
  closed_at: string | null;
}

export interface CostActions {
  actions: CostActionRow[];
  savings: Record<'potential' | 'implemented' | 'verified', number>;
  counts: Record<ActionStatus, number>;
}

export const fetchCostActions = async (p: { year?: number; site?: CostSite | null; status?: string }): Promise<CostActions> => {
  const { data } = await api.get<CostActions>('/api/costs/actions', {
    params: { ...(p.year ? { year: p.year } : {}), ...(p.site ? { site: p.site } : {}),
      ...(p.status ? { status: p.status } : {}) },
  });
  return data;
};

export const createCostAction = async (body: {
  title: string; description?: string; alert_kind?: string | null; context_kind?: string;
  context_ref?: string | null; owner_id?: string | null; due_date?: string | null;
  fiscal_year?: number | null; savings_type?: SavingsType; savings_amount?: number | null;
}, site?: CostSite | null): Promise<CostActionRow> => {
  const { data } = await api.post('/api/costs/actions', body, { params: site ? { site } : {} });
  return data;
};

export const updateCostAction = async (id: string, patch: Partial<{
  title: string; description: string; owner_id: string | null; due_date: string | null;
  status: ActionStatus; savings_type: SavingsType; savings_amount: number | null; result_note: string;
}>): Promise<CostActionRow> => {
  const { data } = await api.patch(`/api/costs/actions/${id}`, patch);
  return data;
};

export const deleteCostAction = async (id: string): Promise<void> => {
  await api.delete(`/api/costs/actions/${id}`);
};

// ─── Forecast adjustments ─────────────────────────────────────────────────────

export const createForecastAdjustment = async (body: {
  year: number; month: number; scope: CostScope; kind: string; amount: number;
  reason: string; cost_center?: string | null;
}, site?: CostSite | null): Promise<{ id: string }> => {
  const { data } = await api.post('/api/costs/forecast-adjustments', body, { params: site ? { site } : {} });
  return data;
};

export const deleteForecastAdjustment = async (id: string): Promise<void> => {
  await api.delete(`/api/costs/forecast-adjustments/${id}`);
};

// ─── Executive summary + report ───────────────────────────────────────────────

export interface ExecutiveSummary {
  year: number;
  site: CostSite | null;
  source: 'sap' | 'internal';
  currency: string;
  kind: CostScope;
  months: number[];
  month_map: MonthMapEntry[];
  cutoff: MonthMapEntry | null;
  method: 'sap_posted' | 'run_rate';
  budget: {
    state: 'under' | 'on_track' | 'at_risk' | 'over';
    period_budget: number; budget_to_date: number; actual_to_date: number;
    variance_to_date: number; variance_to_date_pct: number | null;
    remaining_budget: number; committed_open: number;
  };
  landing: {
    forecast: number;
    scenarios: Record<'base' | 'favorable' | 'unfavorable', number>;
    projected_variance: number; projected_variance_pct: number | null; run_rate: number;
  };
  // 'yoy' when the previous year exists in the ledger, 'budget' otherwise —
  // a variation against a year that was never imported is not reported.
  driver_basis: 'yoy' | 'budget';
  drivers: { cost_center: string; actual: number; prev_actual: number; delta: number;
    delta_pct: number | null; budget_to_date?: number; variance_to_date?: number | null;
    top_account: string | null }[];
  attention_equipment: { equipment_id: string; name: string; code: string | null;
    cost: number; corrective: number; repeat_failures: number; downtime_hours: number;
    criticality: string; score: number }[];
  supplier_concentration: { hhi: number | null; top3_pct: number | null;
    top5_pct: number | null; supplier_count: number } | null;
  data_quality: { key: string; value: number; detail: unknown }[];
  priority_alerts: CostAlert[];
}

export const fetchExecutiveSummary = async (p: CostControlParams): Promise<ExecutiveSummary> => {
  const { data } = await api.get<ExecutiveSummary>('/api/costs/executive-summary', { params: controlParams(p) });
  return data;
};

export const downloadExecutiveReport = async (p: CostControlParams): Promise<void> => {
  const res = await api.get('/api/costs/executive-report', {
    params: controlParams(p), responseType: 'blob',
  });
  const url = window.URL.createObjectURL(new Blob([res.data]));
  const a = document.createElement('a');
  a.href = url;
  a.download = `kaizo-costs-${p.year ?? ''}-${p.kind ?? 'opex'}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
};
