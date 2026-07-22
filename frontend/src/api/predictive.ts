import api from './axios';

export type PredictiveMode = 'off' | 'silent' | 'admin' | 'active';
export type HealthLevel = 'normal' | 'watch' | 'alert' | 'critical' | 'no_data';
export type PredictiveAlertStatus =
  | 'new' | 'in_review' | 'inspection_planned' | 'intervention_required'
  | 'intervention_done' | 'false_positive' | 'monitoring' | 'closed';

export interface PredictiveReason {
  code: string;
  params: Record<string, string | number | null>;
  observed: number | null;
  expected: number | null;
  unit: string | null;
}

export interface PredictiveFactor {
  code: string;
  family: string;
  weight: number;
  value: number;
  quality: number;
  contribution: number;
  observed: number | null;
  expected: number | null;
  unit: string | null;
  params: Record<string, string | number | null>;
  reason: string | null;
}

export interface PredictiveMachineRow {
  equipment_id: string;
  name: string;
  code: string | null;
  department: string | null;
  family: string | null;
  criticality: string | null;
  score: number;
  level: HealthLevel;
  confidence: number | null;
  quality_score: number | null;
  mtbf_pct: number | null;
  maturity: string | null;
  context: string | null;
  ts: string | null;
  open_alerts: number;
}

export interface PredictiveOverview {
  mode: PredictiveMode;
  visible: boolean;
  machines: PredictiveMachineRow[];
  kpis: {
    machines_tracked?: number;
    machines_critical?: number;
    machines_alert?: number;
    machines_insufficient?: number;
    alerts_open?: number;
    alerts_new?: number;
    avg_confidence?: number | null;
    feedback_confirmed_30d?: number;
    feedback_false_positive_30d?: number;
    breakdowns_prevented_30d?: number;
    sensor_problems?: number;
  };
  next_inspections?: {
    alert_id: string; equipment_id: string; due: string; level: string; kind: string;
  }[];
}

export interface PredictiveAlertItem {
  id: string;
  equipment_id: string;
  equipment_name: string | null;
  machine_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  level: HealthLevel;
  score: number;
  kind: string;
  probable_component: string | null;
  probable_failure: string | null;
  reasons: PredictiveReason[];
  sensors_involved: string[];
  window_hours: number | null;
  confidence: number | null;
  recommendation: string | null;
  silent: boolean;
  status: PredictiveAlertStatus;
  assigned_to_id: string | null;
  inspection_due: string | null;
  inspection_result: string | null;
  resolved_at: string | null;
  auto_resolved: boolean;
  ticket_id: string | null;
  engine_version: string | null;
  config_version: number | null;
  feedback?: PredictiveFeedback[];
}

export interface PredictiveFeedback {
  id: string;
  was_correct: boolean | null;
  problem_found: boolean | null;
  component: string | null;
  failure_mode: string | null;
  cause: string | null;
  timing: 'early' | 'on_time' | 'late' | null;
  action_taken: string | null;
  part_replaced: boolean | null;
  prevented_breakdown: boolean | null;
  back_to_normal: boolean | null;
  comments: string | null;
  created_at: string | null;
}

export interface FeedbackInput {
  was_correct?: boolean | null;
  problem_found?: boolean | null;
  component?: string | null;
  failure_mode?: string | null;
  cause?: string | null;
  timing?: 'early' | 'on_time' | 'late' | null;
  action_taken?: string | null;
  part_replaced?: boolean | null;
  prevented_breakdown?: boolean | null;
  back_to_normal?: boolean | null;
  comments?: string | null;
}

export interface MachineHealth {
  mode: PredictiveMode;
  visible: boolean;
  equipment?: {
    id: string; name: string; code: string | null;
    criticality: string | null; family: string | null; department: string | null;
  };
  latest?: {
    ts: string; score: number; level: HealthLevel; context: string | null;
    factors: PredictiveFactor[];
    data_quality: Record<string, { status: string; issues: string[]; last_at: string | null }>;
    quality_score: number | null; confidence: number | null;
    mtbf_pct: number | null; maturity: string | null;
    engine_version: string | null; config_version: number | null;
  } | null;
  history?: { ts: string; score: number; level: HealthLevel; confidence: number | null; mtbf_pct: number | null }[];
  baselines?: {
    metric_key: string; context_key: string; unit: string | null; n_samples: number;
    median: number | null; mad: number | null; mean: number | null; std: number | null;
    p05: number | null; p95: number | null; valid: boolean; frozen: boolean;
    version: number; computed_at: string | null;
  }[];
  alerts?: PredictiveAlertItem[];
  mtbf?: {
    hours_since_last: number; mtbf_hist_h: number | null; mtbf_recent_h: number | null;
    pct_consumed: number | null; trend: number | null; failures_365d: number;
  } | null;
}

export async function fetchPredictiveOverview(): Promise<PredictiveOverview> {
  const { data } = await api.get('/api/predictive/overview');
  return data;
}

export async function fetchMachineHealth(equipmentId: string, hours = 168): Promise<MachineHealth> {
  const { data } = await api.get(`/api/predictive/machines/${equipmentId}`, { params: { hours } });
  return data;
}

export async function fetchPredictiveAlerts(params: {
  status?: string; level?: string; open_only?: boolean; equipment_id?: string;
  limit?: number; offset?: number;
} = {}): Promise<{ total: number; items: PredictiveAlertItem[]; mode: PredictiveMode; visible: boolean }> {
  const { data } = await api.get('/api/predictive/alerts', { params });
  return data;
}

export async function updateAlertStatus(
  alertId: string,
  body: { status: PredictiveAlertStatus; assigned_to_id?: string; inspection_due?: string; inspection_result?: string },
): Promise<PredictiveAlertItem> {
  const { data } = await api.patch(`/api/predictive/alerts/${alertId}/status`, body);
  return data;
}

export async function submitAlertFeedback(alertId: string, body: FeedbackInput): Promise<{ id: string }> {
  const { data } = await api.post(`/api/predictive/alerts/${alertId}/feedback`, body);
  return data;
}

export async function createAlertTicket(alertId: string): Promise<{ ticket_id: string; ticket_number: string }> {
  const { data } = await api.post(`/api/predictive/alerts/${alertId}/ticket`);
  return data;
}

export async function evaluateNow(equipmentId: string): Promise<unknown> {
  const { data } = await api.post(`/api/predictive/machines/${equipmentId}/evaluate`);
  return data;
}

export async function fetchPredictiveSettings(): Promise<{
  plant: Record<string, unknown> & { mode: PredictiveMode };
  machines: { equipment_id: string; enabled: boolean | null; mode: PredictiveMode | null }[];
}> {
  const { data } = await api.get('/api/predictive/settings');
  return data;
}

export async function updatePredictiveSettings(body: Record<string, unknown>): Promise<{ ok: boolean; version: number }> {
  const { data } = await api.put('/api/predictive/settings', body);
  return data;
}

export async function updateMachinePredictiveSettings(
  equipmentId: string,
  body: { enabled?: boolean | null; mode?: PredictiveMode | null },
): Promise<{ ok: boolean }> {
  const { data } = await api.put(`/api/predictive/machines/${equipmentId}/settings`, body);
  return data;
}

export async function runBacktest(body: {
  equipment_id: string; start: string; end: string; step_min?: number;
}): Promise<{
  metrics: {
    evaluations: number; alerts: number; failures: number; detected: number;
    missed: number; false_positives: number; avg_lead_hours: number | null;
  };
  snapshots: { ts: string; score: number; level: HealthLevel }[];
  alerts: { opened_at: string; kind: string; level: string; score: number }[];
  failures: { started_at: string; detected: boolean; lead_hours: number | null }[];
}> {
  const { data } = await api.post('/api/predictive/backtest', body);
  return data;
}
