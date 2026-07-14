import api from './axios';

export type TemperatureSource = 'simulated' | 'adam_analog' | 'http';
export type TemperatureSensorStatus = 'unknown' | 'online' | 'offline' | 'error';

export interface TemperatureSensor {
  id: string;
  name: string;
  department: string | null;
  enabled: boolean;
  source: TemperatureSource;
  sim_baseline_c: number;
  sim_amplitude_c: number;
  pos_x: number | null;
  pos_y: number | null;
  height_3d: number | null;
  last_value_c: number | null;
  last_reading_at: string | null;
  status: TemperatureSensorStatus;
  last_error: string | null;
}

export type TemperatureSensorInput = {
  name: string;
  department: string | null;
  enabled: boolean;
  source: TemperatureSource;
  sim_baseline_c: number;
  sim_amplitude_c: number;
};

export async function fetchTemperatureSensors(): Promise<TemperatureSensor[]> {
  const { data } = await api.get('/api/temperature-sensors');
  return data;
}

export async function createTemperatureSensor(
  body: TemperatureSensorInput,
): Promise<TemperatureSensor> {
  const { data } = await api.post('/api/temperature-sensors', body);
  return data;
}

export async function updateTemperatureSensor(
  id: string,
  body: TemperatureSensorInput,
): Promise<TemperatureSensor> {
  const { data } = await api.put(`/api/temperature-sensors/${id}`, body);
  return data;
}

export async function deleteTemperatureSensor(id: string): Promise<void> {
  await api.delete(`/api/temperature-sensors/${id}`);
}
