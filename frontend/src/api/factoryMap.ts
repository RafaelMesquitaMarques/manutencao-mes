import api from './axios';

export interface MapTechnician {
  name: string;
  since: string | null;   // ISO start of the technician's labor session
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
  department: string | null;
  family: string | null;
  subtype: string | null;
  function_label: string | null;
  open_ticket: boolean;
  open_ticket_id: string | null;
  open_ticket_number: string | null;
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

export interface FactoryMapData {
  plant_id: string;
  plant_name: string;
  floor_plan_url: string | null;
  machines: MapMachine[];
  zones: MapZone[];
  props: MapProp[];
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

export type PropCreate = Partial<Pick<MapProp, 'kind' | 'label' | 'model_url' | 'equipment_id' | 'pos_x' | 'pos_y' | 'pos_w' | 'pos_h' | 'rotation_deg' | 'height_3d'>>;
export type PropPatch = Partial<Pick<MapProp, 'kind' | 'label' | 'model_url' | 'equipment_id' | 'pos_x' | 'pos_y' | 'pos_w' | 'pos_h' | 'rotation_deg' | 'model_scale' | 'scale_y' | 'scale_z' | 'height_3d'>>;

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
