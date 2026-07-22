import api from './axios';

// ── OF watch ("spot") — follow a specific OF on the factory map ───────────────
// A watch is shared by the whole plant team (one per OF). The map polls
// /api/of-watch/{plant} (~30 s) for live location + inactivity; the backend
// loop fires SMS/email/Teams alerts when a watched OF stalls past its threshold.

export interface OfWatchLocation {
  kind: 'machine' | 'pit_stop' | 'unknown';
  machine_id: string | null;      // Machine id (map equipment ties via MapMachine.machine_id)
  machine_name: string | null;
  parked: boolean;                // true = at the machine's OUTPUT (last passage), not loaded
  planned: boolean;               // true = pending OF queued BEHIND the machine (not started yet)
  lane: number | null;            // pit_stop only (parsed L##-P##)
  slot: number | null;
  position_code: string | null;
}

export interface OfWatch {
  id: string;
  job_order_id: string;
  job_number: string;
  product_name: string | null;
  of_status: string | null;       // pending | in_progress | completed | cancelled
  threshold_minutes: number;
  created_by_name: string | null;
  created_at: string | null;
  last_movement_at: string | null;
  inactive_minutes: number | null;   // null = OF finished (no clock)
  alerting: boolean;                 // inactive ≥ threshold right now
  location: OfWatchLocation;
}

// Whole-map search result: where the OF physically is right now.
export interface OfLocateResult {
  job_order_id: string;
  job_number: string;
  product_name: string | null;
  of_status: string | null;
  scheduled_date: string | null;
  location: OfWatchLocation;
  last_movement_at: string | null;
  watched: boolean;
  watch_id: string | null;
}

export const WATCH_THRESHOLDS = [5, 10, 15, 30, 60, 120] as const;

export const fetchOfWatches = async (plantId: string): Promise<OfWatch[]> => {
  const { data } = await api.get<{ watches: OfWatch[] }>(`/api/of-watch/${plantId}`);
  return data.watches;
};

// 404 = no OF matches the query → null (the caller shows "not found").
export const locateOf = async (plantId: string, q: string): Promise<OfLocateResult | null> => {
  try {
    const { data } = await api.get<OfLocateResult>(`/api/of-watch/${plantId}/locate`, { params: { q } });
    return data;
  } catch (e) {
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 404) return null;
    throw e;
  }
};

export const createOfWatch = async (
  plantId: string, jobOrderId: string, thresholdMinutes?: number,
): Promise<void> => {
  await api.post(`/api/of-watch/${plantId}`, {
    job_order_id: jobOrderId,
    ...(thresholdMinutes != null ? { threshold_minutes: thresholdMinutes } : {}),
  });
};

// Follow an OF by the NUMBER shown on the map — kiosk chips can display OFs that
// have no job_orders row yet (externally-fed data); the backend creates the row
// (like a scan would), anchored to `machineId` when given.
export const createOfWatchByNumber = async (
  plantId: string, jobNumber: string, machineId?: string | null, thresholdMinutes?: number,
): Promise<void> => {
  await api.post(`/api/of-watch/${plantId}`, {
    job_number: jobNumber,
    ...(machineId ? { machine_id: machineId } : {}),
    ...(thresholdMinutes != null ? { threshold_minutes: thresholdMinutes } : {}),
  });
};

export const patchOfWatch = async (watchId: string, thresholdMinutes: number): Promise<void> => {
  await api.patch(`/api/of-watch/${watchId}`, { threshold_minutes: thresholdMinutes });
};

export const deleteOfWatch = async (watchId: string): Promise<void> => {
  await api.delete(`/api/of-watch/${watchId}`);
};
