import api from './axios';

export type WidgetType = 'status' | 'stops' | 'production';

export interface DashboardTile {
  i: string;
  machine_id: string | null;
  widget: WidgetType;
  x: number; y: number; w: number; h: number;
}

export interface Dashboard {
  id: string;
  slug: string;
  name: string;
  is_shared: boolean;
  tiles: DashboardTile[];
}

export const fetchDashboards = async (): Promise<Dashboard[]> => {
  const { data } = await api.get<Dashboard[]>('/api/dashboards/');
  return data;
};

export const fetchDashboard = async (ref: string): Promise<Dashboard> => {
  const { data } = await api.get<Dashboard>(`/api/dashboards/${ref}`);
  return data;
};

export const createDashboard = async (
  body: { name: string; tiles?: DashboardTile[]; is_shared?: boolean },
): Promise<Dashboard> => {
  const { data } = await api.post<Dashboard>('/api/dashboards/', body);
  return data;
};

export const updateDashboard = async (
  ref: string,
  body: Partial<{ name: string; tiles: DashboardTile[]; is_shared: boolean }>,
): Promise<Dashboard> => {
  const { data } = await api.patch<Dashboard>(`/api/dashboards/${ref}`, body);
  return data;
};

export const deleteDashboard = async (ref: string): Promise<void> => {
  await api.delete(`/api/dashboards/${ref}`);
};
