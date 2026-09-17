import api from './axios';
import type {
  MachineReportData, MachineCompareResponse, ProductivityData,
  ProductivityCompareData, CompareDimension,
} from '../types';

/**
 * The analysis window for every Machine Reports endpoint. The page drives it from
 * an explicit date range; `period_days` remains the API's fallback for a caller
 * that passes no dates.
 */
export interface ReportRange {
  start?: string;          // ISO date, inclusive
  end?: string;            // ISO date, inclusive
  period_days?: number;
}

function rangeParams(r: ReportRange): Record<string, string | number> {
  const p: Record<string, string | number> = { period_days: r.period_days ?? 30 };
  if (r.start && r.end) {
    p.start = r.start;
    p.end = r.end;
  }
  return p;
}

export const fetchMachineReport = async (
  machineId: string,
  range: ReportRange = {},
): Promise<MachineReportData> => {
  const { data } = await api.get<MachineReportData>(`/api/reports/machine/${machineId}`, {
    params: rangeParams(range),
  });
  return data;
};

export const fetchMachineComparison = async (
  range: ReportRange = {},
): Promise<MachineCompareResponse> => {
  const { data } = await api.get<MachineCompareResponse>('/api/reports/machines/compare', {
    params: rangeParams(range),
  });
  return data;
};

/** Window + filters shared by the productivity overview and its comparison. */
export interface ProductivityQuery extends ReportRange {
  shift?: string;
  department?: string;
  machine_ids?: string[];
  operators?: string[];
  include_unattributed?: boolean;
}

/**
 * FastAPI reads list params as REPEATED keys (`machine_id=a&machine_id=b`), while
 * axios would serialize an array as `machine_id[]=a`. Building URLSearchParams by
 * hand is what keeps the multi-selects working.
 */
function productivityParams(q: ProductivityQuery): URLSearchParams {
  const p = new URLSearchParams();
  Object.entries(rangeParams(q)).forEach(([k, v]) => p.set(k, String(v)));
  if (q.shift) p.set('shift', q.shift);
  if (q.department) p.set('department', q.department);
  (q.machine_ids ?? []).forEach((id) => p.append('machine_id', id));
  (q.operators ?? []).forEach((name) => p.append('operator', name));
  if (q.include_unattributed) p.set('include_unattributed', 'true');
  return p;
}

export const fetchProductivity = async (q: ProductivityQuery = {}): Promise<ProductivityData> => {
  const { data } = await api.get<ProductivityData>('/api/reports/productivity', {
    params: productivityParams(q),
  });
  return data;
};

export const fetchProductivityCompare = async (
  dimension: CompareDimension,
  opts: { keys?: string[]; top?: number } = {},
  q: ProductivityQuery = {},
): Promise<ProductivityCompareData> => {
  const params = productivityParams(q);
  params.set('dimension', dimension);
  if (opts.top) params.set('top', String(opts.top));
  (opts.keys ?? []).forEach((k) => params.append('key', k));
  const { data } = await api.get<ProductivityCompareData>('/api/reports/productivity/compare', {
    params,
  });
  return data;
};
