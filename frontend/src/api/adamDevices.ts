import api from './axios';

export type AdamModel = '6050' | '6051';
export type AdamSignalSource = 'di' | 'counter' | 'state';
export type AdamActiveLevel = 'low' | 'high';
export type AdamDeviceStatus = 'unknown' | 'online' | 'offline' | 'error';

export interface AdamDevice {
  id: string;
  name: string;
  model: AdamModel;
  ip_address: string;
  port: number;
  machine_id: string | null;
  machine_name: string | null;
  machine_code: string | null;
  machine_has_token: boolean;
  enabled: boolean;
  signal_source: AdamSignalSource;
  channel: number;
  active_level: AdamActiveLevel;
  counter_reg: number;
  idle_timeout_s: number;
  poll_interval_ms: number;
  status: AdamDeviceStatus;
  last_seen_at: string | null;
  last_error: string | null;
}

export type AdamDeviceInput = {
  name: string;
  model: AdamModel;
  ip_address: string;
  port: number;
  machine_id: string | null;
  enabled: boolean;
  signal_source: AdamSignalSource;
  channel: number;
  active_level: AdamActiveLevel;
  counter_reg: number;
  idle_timeout_s: number;
  poll_interval_ms: number;
};

export async function fetchAdamDevices(): Promise<AdamDevice[]> {
  const { data } = await api.get('/api/adam-devices');
  return data;
}

export async function createAdamDevice(body: AdamDeviceInput): Promise<AdamDevice> {
  const { data } = await api.post('/api/adam-devices', body);
  return data;
}

export async function updateAdamDevice(id: string, body: AdamDeviceInput): Promise<AdamDevice> {
  const { data } = await api.put(`/api/adam-devices/${id}`, body);
  return data;
}

export async function deleteAdamDevice(id: string): Promise<void> {
  await api.delete(`/api/adam-devices/${id}`);
}

// Reuses the existing per-machine signal-token provisioning.
export async function provisionMachineToken(
  machineRef: string,
): Promise<{ machine_id: string; signal_ingest_token: string }> {
  const { data } = await api.post(`/api/machines/${machineRef}/signal-token`);
  return data;
}
