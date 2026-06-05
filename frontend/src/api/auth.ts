import api from './axios';
import type { LoginResponse, LoginCredentials } from '../types';

export const login = async (credentials: LoginCredentials): Promise<LoginResponse> => {
  const { data } = await api.post<LoginResponse>('/api/auth/login', {
    email: credentials.email,
    password: credentials.password,
  });
  return data;
};
