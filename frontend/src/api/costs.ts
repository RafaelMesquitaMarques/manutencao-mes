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
