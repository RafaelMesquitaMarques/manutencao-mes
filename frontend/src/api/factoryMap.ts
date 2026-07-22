import api from './axios';

export interface MapTechnician {
  name: string;
  since: string | null;   // ISO start of the technician's labor session
}

// An OF parked at a machine's output (worked there, waiting to be scanned at
// the next step — Perçage after Edge, the Pit Stop after Coupe, …).
export interface QueuedOf {
  job_number: string;
  product_name: string | null;
  age_minutes: number | null;   // since its run there closed (next OF scanned)
}

// An OF in a machine's PLANNED pipeline: pending, assigned by production planning,
// waiting BEHIND the machine (the cutting saws have no input conveyor, only a plan).
export interface PipelineOf {
  job_number: string;
  product_name: string | null;
  scheduled_date: string | null;   // planned cut date (soonest first)
  late: boolean;                    // scheduled before today
  due_today: boolean;
}

// Live TV stats for an assembly line (end-of-line scoreboard on the 3D map):
// shift actual (UE), evolving objective (target/h × hours elapsed in the
// shift), efficiency %, and the short-term rate/trend from the last minutes.
export interface LineStats {
  actual: number;
  rate_per_h: number;
  trend: 'up' | 'down' | 'flat';
  target_per_hour: number;
  evolving_target: number;
  efficiency_pct: number | null;
}

export interface MapMachine {
  id: string;
  machine_id: string | null;
  equipment_id: string | null;
  page_slug: string | null;
  name: string;
  code: string | null;
  status: string;
  operator: string | null;
  // Technicians working the machine when status === 'intervention' (purple) — one
  // per tech on the clock, each with the ISO start of their labor session.
  technicians: MapTechnician[] | null;
  // Justification of the OPEN stop (kiosk timeline: subcategory > category >
  // comments) — feeds the assembly-line balloon when the belt is stopped.
  stop_reason: string | null;
  // End-of-line TV stats — only set for assembly lines.
  line_stats: LineStats | null;
  // OF currently loaded at the machine's kiosk — shown on linked input/output conveyors.
  current_job_number: string | null;
  // OFs PARKED at this machine's output: worked there, not the current OF, not yet
  // scanned at the next step nor arrived in the Pit Stop. Oldest first, capped;
  // `queued_total` keeps the +N badge honest beyond the cap.
  queued_ofs: QueuedOf[] | null;
  queued_total: number;
  // PLANNED pipeline behind the machine (pending OFs assigned by planning, soonest
  // scheduled first). Drives the raw-panel stack behind the cutting saws.
  pipeline_ofs: PipelineOf[] | null;
  pipeline_total: number;
  department: string | null;
  family: string | null;
  subtype: string | null;
  function_label: string | null;
  open_ticket: boolean;
  open_ticket_id: string | null;
  open_ticket_number: string | null;
  // Latest predictive-health snapshot (null when the module is off or not
  // visible at this user's activation-ladder level).
  predictive: { level: string; score: number } | null;
  pos_x: number | null;
  pos_y: number | null;
  pos_w: number | null;
  pos_h: number | null;
  rotation_deg: number | null;
  icon_url: string | null;
  model_url: string | null;
  height_3d: number | null;
  model_scale: number | null;
  scale_y: number | null;
  scale_z: number | null;
  block_kind: string | null;
  asset_type: string | null;
  parent_equipment_id: string | null;
  orbit_x: number | null;
  orbit_y: number | null;
  orbit_w: number | null;
  orbit_h: number | null;
  custom_color: string | null;
  placed: boolean;
}

// A temperature probe placed freely on the map. The 3D view draws a thermometer
// at pos_x/pos_y and the temperature badge shows the value of the nearest sensor.
export interface MapSensor {
  id: string;
  name: string;
  department: string | null;
  pos_x: number | null;
  pos_y: number | null;
  height_3d: number | null;
  last_value_c: number | null;   // canonical Celsius; UI converts to the user's unit
  status: string;
}

export interface PlantWeather {
  temp_c: number | null;         // canonical Celsius
  code: number | null;           // WMO weather code → icon
  updated_at: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface MapZone {
  id: string;
  name: string;
  color: string;
  pos_x: number;
  pos_y: number;
  pos_w: number;
  pos_h: number;
}

export interface MapProp {
  id: string;
  kind: string;
  label: string | null;
  model_url: string | null;
  equipment_id: string | null;
  machine_id: string | null;   // conveyor → kiosk machine (opens its OFs on click)
  role: string | null;         // 'input' | 'output' feed direction
  pos_x: number;
  pos_y: number;
  pos_w: number;
  pos_h: number;
  rotation_deg: number | null;
  model_scale: number | null;
  scale_y: number | null;
  scale_z: number | null;
  height_3d: number | null;
}

// A user-saved 3D camera viewpoint. Center-independent: the look-at point lives
// in map-pixel space and the camera is an offset vector (see backend model).
// `department` set → it's that department's pinned camera pose (overrides its
// auto bounding-box frame); null → a free, user-named view.
export interface MapView {
  id: string;
  name: string;
  department: string | null;
  target_px_x: number;
  target_px_y: number;
  target_y: number;
  offset_x: number;
  offset_y: number;
  offset_z: number;
}

export interface FactoryMapData {
  plant_id: string;
  plant_name: string;
  // Efficiency-colour thresholds for the assembly-line TVs (plant-wide,
  // configured on /settings/line-objectives).
  line_tv_thresholds?: { green_from: number; amber_from: number };
  // The GLOBAL clock: Σ of the lines' measured stats against the plant's OWN
  // global objective (independent of the per-line objectives).
  global_line_stats?: LineStats | null;
  floor_plan_url: string | null;
  machines: MapMachine[];
  zones: MapZone[];
  props: MapProp[];
  sensors: MapSensor[];
  views: MapView[];
  home_view_id: string | null;   // the requesting user's favourite view for this plant
}

export type MachineLayout = Partial<Pick<MapMachine, 'pos_x' | 'pos_y' | 'pos_w' | 'pos_h' | 'rotation_deg' | 'icon_url' | 'model_url' | 'height_3d' | 'model_scale' | 'scale_y' | 'scale_z' | 'block_kind' | 'parent_equipment_id' | 'orbit_x' | 'orbit_y' | 'orbit_w' | 'orbit_h'>>;
export type ZonePatch = Partial<Pick<MapZone, 'name' | 'color' | 'pos_x' | 'pos_y' | 'pos_w' | 'pos_h'>>;

export const fetchFactoryMap = async (plantId: string, assetType: string = 'production'): Promise<FactoryMapData> => {
  const { data } = await api.get<FactoryMapData>(`/api/factory-map/${plantId}`, { params: { asset_type: assetType } });
  return data;
};

export const saveMachineLayout = async (machineId: string, layout: MachineLayout): Promise<void> => {
  await api.patch(`/api/factory-map/item/${machineId}`, layout);
};

export const saveFloorPlan = async (plantId: string, floor_plan_url: string | null): Promise<void> => {
  await api.patch(`/api/factory-map/${plantId}/floor-plan`, { floor_plan_url });
};

// Reposition a temperature sensor on the map (edit mode drag). CRUD of the sensor
// itself lives in api/temperatureSensors.ts (Settings → Devices).
export const saveSensorLayout = async (
  sensorId: string,
  layout: { pos_x?: number; pos_y?: number; height_3d?: number },
): Promise<void> => {
  await api.patch(`/api/factory-map/sensor/${sensorId}`, layout);
};

// Cached outdoor weather for the plant (overview badge). temp in Celsius.
export const fetchPlantWeather = async (plantId: string): Promise<PlantWeather> => {
  const { data } = await api.get<PlantWeather>(`/api/plants/${plantId}/weather`);
  return data;
};

// Light poll of just the sensor readings so the 3D thermometers + badge stay live
// without reloading the whole map.
export const fetchMapSensors = async (plantId: string): Promise<MapSensor[]> => {
  const { data } = await api.get<MapSensor[]>(`/api/factory-map/${plantId}/sensors`);
  return data;
};

export const createZone = async (plantId: string, zone: ZonePatch): Promise<MapZone> => {
  const { data } = await api.post<MapZone>(`/api/factory-map/${plantId}/zones`, zone);
  return data;
};

export const saveZone = async (zoneId: string, patch: ZonePatch): Promise<void> => {
  await api.patch(`/api/factory-map/zone/${zoneId}`, patch);
};

export const deleteZone = async (zoneId: string): Promise<void> => {
  await api.delete(`/api/factory-map/zone/${zoneId}`);
};

export type PropCreate = Partial<Pick<MapProp, 'kind' | 'label' | 'model_url' | 'equipment_id' | 'machine_id' | 'role' | 'pos_x' | 'pos_y' | 'pos_w' | 'pos_h' | 'rotation_deg' | 'height_3d'>>;
export type PropPatch = Partial<Pick<MapProp, 'kind' | 'label' | 'model_url' | 'equipment_id' | 'machine_id' | 'role' | 'pos_x' | 'pos_y' | 'pos_w' | 'pos_h' | 'rotation_deg' | 'model_scale' | 'scale_y' | 'scale_z' | 'height_3d'>>;

export const createProp = async (plantId: string, prop: PropCreate): Promise<MapProp> => {
  const { data } = await api.post<MapProp>(`/api/factory-map/${plantId}/props`, prop);
  return data;
};

export const saveProp = async (propId: string, patch: PropPatch): Promise<void> => {
  await api.patch(`/api/factory-map/prop/${propId}`, patch);
};

export const deleteProp = async (propId: string): Promise<void> => {
  await api.delete(`/api/factory-map/prop/${propId}`);
};

export type ViewCreate = Omit<MapView, 'id' | 'department'> & { department?: string | null };
export type ViewPatch = Partial<Omit<MapView, 'id'>>;   // includes `department` (link/unlink)

export const createView = async (plantId: string, view: ViewCreate): Promise<MapView> => {
  const { data } = await api.post<MapView>(`/api/factory-map/${plantId}/views`, view);
  return data;
};

// Reposition (and/or rename) an existing view — used to re-pin a department's camera pose.
export const updateView = async (viewId: string, patch: ViewPatch): Promise<void> => {
  await api.patch(`/api/factory-map/view/${viewId}`, patch);
};

export const deleteView = async (viewId: string): Promise<void> => {
  await api.delete(`/api/factory-map/view/${viewId}`);
};

// Set (or clear, with null) the current user's favourite Home-overview view for a plant.
export const setHomeView = async (plantId: string, viewId: string | null): Promise<void> => {
  await api.put(`/api/factory-map/${plantId}/home-view`, { view_id: viewId });
};
