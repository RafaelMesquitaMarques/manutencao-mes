import api from './axios';

export type SushiModel = 'xs770a' | 'xs530' | 'xs550';
export type SushiHealth = 'unknown' | 'online' | 'stale' | 'offline';
export type SushiNamur = 'good' | 'failure' | 'check' | 'out_of_spec' | 'maintenance' | null;

export interface SushiDevice {
  id: string;
  name: string;
  dev_eui: string;
  model: SushiModel;
  equipment_id: string | null;
  equipment_name: string | null;
  equipment_code: string | null;
  enabled: boolean;
  update_period_min: number;
  vel_warn_mms: number | null;
  vel_crit_mms: number | null;
  acc_warn_ms2: number | null;
  acc_crit_ms2: number | null;
  temp_warn_c: number | null;
  temp_crit_c: number | null;
  press_min_mpa: number | null;
  press_max_mpa: number | null;
  health: SushiHealth;
  namur: SushiNamur;
  last_uplink_at: string | null;
  last_data_type: string | null;
  battery_pct: number | null;
  rssi_dbm: number | null;
  snr_db: number | null;
  per_pct: number | null;
  tag_name: string | null;
  last_error: string | null;
  ingest_configured: boolean;
}

export type SushiDeviceInput = {
  name: string;
  dev_eui: string;
  model: SushiModel;
  equipment_id: string | null;
  enabled: boolean;
  update_period_min: number;
  vel_warn_mms: number | null;
  vel_crit_mms: number | null;
  acc_warn_ms2: number | null;
  acc_crit_ms2: number | null;
  temp_warn_c: number | null;
  temp_crit_c: number | null;
  press_min_mpa: number | null;
  press_max_mpa: number | null;
};

export async function fetchSushiDevices(): Promise<SushiDevice[]> {
  const { data } = await api.get('/api/sushi-devices');
  return data;
}

export async function createSushiDevice(body: SushiDeviceInput): Promise<SushiDevice> {
  const { data } = await api.post('/api/sushi-devices', body);
  return data;
}

export async function updateSushiDevice(id: string, body: SushiDeviceInput): Promise<SushiDevice> {
  const { data } = await api.put(`/api/sushi-devices/${id}`, body);
  return data;
}

export async function deleteSushiDevice(id: string): Promise<void> {
  await api.delete(`/api/sushi-devices/${id}`);
}

// ─── Condition read model (Equipment detail tab) ──────────────────────────────

export type SushiMetric = 'vel' | 'acc' | 'temp' | 'press' | 'unknown';

export interface SushiSeriesPoint {
  t: string;
  avg: number;
  max: number;
  min: number;
}

export interface SushiSeries {
  sensor_id: string;
  code: string;
  name: string;
  metric: SushiMetric;
  axis: string | null;
  unit: string;
  latest: { value: number; timestamp: string; quality: string } | null;
  points: SushiSeriesPoint[];
}

export interface SushiConditionDevice {
  id: string;
  name: string;
  dev_eui: string;
  model: SushiModel;
  enabled: boolean;
  health: SushiHealth;
  namur: SushiNamur;
  last_uplink_at: string | null;
  battery_pct: number | null;
  rssi_dbm: number | null;
  snr_db: number | null;
  per_pct: number | null;
  update_period_min: number;
  tag_name: string | null;
  thresholds: {
    vel_warn_mms: number | null;
    vel_crit_mms: number | null;
    acc_warn_ms2: number | null;
    acc_crit_ms2: number | null;
    temp_warn_c: number | null;
    temp_crit_c: number | null;
    press_min_mpa: number | null;
    press_max_mpa: number | null;
  };
}

export interface SushiConditionAlert {
  id: string;
  type: string;
  severity: string;
  value_read: number | null;
  limit_value: number | null;
  message: string;
  acknowledged: boolean;
  created_at: string | null;
}

export interface SushiCondition {
  devices: SushiConditionDevice[];
  series: SushiSeries[];
  alerts: SushiConditionAlert[];
  hours: number;
  bucket_minutes: number;
}

export async function fetchEquipmentCondition(
  equipmentId: string,
  hours = 24,
): Promise<SushiCondition> {
  const { data } = await api.get(`/api/sushi/equipment/${equipmentId}/condition`, {
    params: { hours },
  });
  return data;
}
