import api from './axios';

export interface Department {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
}

export const fetchDepartments = async (includeInactive = false): Promise<Department[]> => {
  const { data } = await api.get<Department[]>('/api/departments/', {
    params: { include_inactive: includeInactive },
  });
  return data;
};

export const createDepartment = async (name: string): Promise<Department> => {
  const { data } = await api.post<Department>('/api/departments/', { name });
  return data;
};

export const updateDepartment = async (
  id: string,
  patch: Partial<Pick<Department, 'name' | 'is_active' | 'sort_order'>>,
): Promise<Department> => {
  const { data } = await api.patch<Department>(`/api/departments/${id}`, patch);
  return data;
};

export const deleteDepartment = async (id: string): Promise<void> => {
  await api.delete(`/api/departments/${id}`);
};
