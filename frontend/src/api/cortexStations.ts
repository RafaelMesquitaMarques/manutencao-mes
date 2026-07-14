import api from './axios';
import type { AdamDeviceStatus } from './adamDevices';

export interface CortexStation {
  id: string;
  name: string;
  station_key: string;
  machine_id: string | null;
  machine_name: string | null;
  machine_code: string | null;
  machine_has_token: boolean;
  enabled: boolean;
  poll_interval_s: number;
  status: AdamDeviceStatus;
  last_seen_at: string | null;
  last_error: string | null;
}

export type CortexStationInput = {
  name: string;
  station_key: string;
  machine_id: string | null;
  enabled: boolean;
  poll_interval_s: number;
};

export async function fetchCortexStations(): Promise<CortexStation[]> {
  const { data } = await api.get('/api/cortex-stations');
  return data;
}

export async function createCortexStation(body: CortexStationInput): Promise<CortexStation> {
  const { data } = await api.post('/api/cortex-stations', body);
  return data;
}

export async function updateCortexStation(id: string, body: CortexStationInput): Promise<CortexStation> {
  const { data } = await api.put(`/api/cortex-stations/${id}`, body);
  return data;
}

export async function deleteCortexStation(id: string): Promise<void> {
  await api.delete(`/api/cortex-stations/${id}`);
}
