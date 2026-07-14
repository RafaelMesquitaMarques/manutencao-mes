import api from './axios';

// One assembly line's production objective (Cortex "horloges" model):
// cadence in units/h, the work window and the scheduled pauses — everything
// the evolving Standard on the 3D line TVs is computed from.
export interface WorkPause {
  start: string;   // "HH:MM"
  end: string;
}

// The three canonical shifts a line can run (aligned with the platform's
// morning/afternoon/night buckets). Each can be switched on/off independently.
export type ShiftKey = 'morning' | 'afternoon' | 'night';
export const SHIFT_KEYS: ShiftKey[] = ['morning', 'afternoon', 'night'];

export interface Shift {
  enabled: boolean;
  start: string;   // "HH:MM"
  end: string;
}

export interface LineObjective {
  machine_id: string;
  name: string;
  code: string | null;
  cadence_per_hour: number;
  work_start: string | null;
  work_end: string | null;
  shifts: Record<ShiftKey, Shift>;
  pauses: WorkPause[];
}

export type LineObjectiveInput = {
  cadence_per_hour: number;
  work_start: string | null;
  work_end: string | null;
  shifts?: Record<ShiftKey, Shift>;
  pauses: WorkPause[];
};

export async function fetchLineObjectives(): Promise<LineObjective[]> {
  const { data } = await api.get('/api/machines/assembly-lines');
  return data;
}

export async function saveLineObjective(machineId: string, body: LineObjectiveInput): Promise<LineObjective> {
  const { data } = await api.put(`/api/machines/assembly-lines/${machineId}/objective`, body);
  return data;
}

// Add an assembly line to the active plant: the Equipment (block_kind
// 'assembly_line') + its kiosk/Machine are created server-side. Lets a plant
// carry only the lines it has (e.g. Las Vegas has fewer than St-Jérôme), and any
// plant grow later. The signal token + ADAM/Cortex device are wired afterwards
// in Settings › Devices, then the line is placed on the factory map.
export async function createAssemblyLine(
  body: { name: string; code: string; cadence_per_hour: number },
): Promise<LineObjective> {
  const { data } = await api.post('/api/machines/assembly-lines', body);
  return data;
}

// Soft-remove a line: deactivates the Equipment + kiosk. History is preserved.
export async function deleteAssemblyLine(machineId: string): Promise<void> {
  await api.delete(`/api/machines/assembly-lines/${machineId}`);
}

// The GLOBAL clock's own objective (independent of the per-line ones): drives
// the global TV's Standard; its Réel stays the measured sum of the lines. It keeps
// a single work window (no per-shift grid — that's a per-line concept).
export type GlobalObjective = {
  cadence_per_hour: number;
  work_start: string | null;
  work_end: string | null;
  pauses: WorkPause[];
};

export async function fetchGlobalObjective(): Promise<GlobalObjective> {
  const { data } = await api.get('/api/machines/assembly-lines/global-objective');
  return data;
}

export async function saveGlobalObjective(body: LineObjectiveInput): Promise<GlobalObjective> {
  const { data } = await api.put('/api/machines/assembly-lines/global-objective', body);
  return data;
}

// Plant-wide efficiency-colour thresholds for the line TVs: green when
// efficiency ≥ green_from, amber when ≥ amber_from, red below.
export interface TvSettings {
  green_from: number;
  amber_from: number;
}

export async function fetchTvSettings(): Promise<TvSettings> {
  const { data } = await api.get('/api/machines/assembly-lines/tv-settings');
  return data;
}

export async function saveTvSettings(body: TvSettings): Promise<TvSettings> {
  const { data } = await api.put('/api/machines/assembly-lines/tv-settings', body);
  return data;
}
