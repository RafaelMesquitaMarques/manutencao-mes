import api from './axios';
import type { User, UserPermission, UserAdminUpdate } from '../types';

export const fetchUsers = async (): Promise<User[]> => {
  const { data } = await api.get<User[]>('/api/users/');
  return data;
};

export const fetchUser = async (userId: string): Promise<User> => {
  const { data } = await api.get<User>(`/api/users/${userId}`);
  return data;
};

export const createUser = async (payload: {
  name: string;
  email: string;
  password: string;
  language?: string;
  role?: string;
  job_title?: string;
  phone?: string;
  must_change_password?: boolean;
}): Promise<User> => {
  const { data } = await api.post<User>('/api/users/', payload);
  return data;
};

export const updateUser = async (userId: string, payload: UserAdminUpdate): Promise<User> => {
  const { data } = await api.patch<User>(`/api/users/${userId}`, payload);
  return data;
};

export const deleteUser = async (userId: string): Promise<void> => {
  await api.delete(`/api/users/${userId}`);
};

export const fetchUserPermissions = async (userId: string): Promise<UserPermission[]> => {
  const { data } = await api.get<UserPermission[]>(`/api/users/${userId}/permissions`);
  return data;
};

export const setUserPermissions = async (
  userId: string,
  permissions: Array<{ resource: string; action: string; granted: boolean; plant_id?: string }>,
): Promise<void> => {
  await api.put(`/api/users/${userId}/permissions`, { permissions });
};

export const fetchUserPlants = async (userId: string): Promise<Array<{ plant_id: string; role: string }>> => {
  const { data } = await api.get(`/api/users/${userId}/plants`);
  return data;
};

export const assignUserToPlant = async (
  userId: string,
  plantId: string,
  role?: string,
): Promise<void> => {
  await api.post(`/api/users/${userId}/plants/${plantId}`, null, {
    params: role ? { role } : undefined,
  });
};

export const removeUserFromPlant = async (userId: string, plantId: string): Promise<void> => {
  await api.delete(`/api/users/${userId}/plants/${plantId}`);
};
