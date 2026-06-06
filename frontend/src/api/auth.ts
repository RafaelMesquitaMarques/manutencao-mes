import api from './axios';
import type { LoginResponse, LoginCredentials, User } from '../types';

export const login = async (credentials: LoginCredentials): Promise<LoginResponse> => {
  const { data } = await api.post<LoginResponse>('/api/auth/login', {
    email: credentials.email,
    password: credentials.password,
  });
  return data;
};

export const getMe = async (): Promise<User> => {
  const { data } = await api.get<User>('/api/auth/me');
  return data;
};

export const updateMe = async (payload: {
  name?: string;
  language?: string;
  avatar_url?: string;
  phone?: string;
}): Promise<User> => {
  const { data } = await api.patch<User>('/api/auth/me', payload);
  return data;
};

export const forgotPassword = async (email: string): Promise<void> => {
  await api.post('/api/auth/forgot-password', { email });
};

export const resetPassword = async (token: string, newPassword: string): Promise<void> => {
  await api.post('/api/auth/reset-password', { token, new_password: newPassword });
};

export const changePassword = async (oldPassword: string, newPassword: string): Promise<void> => {
  await api.post('/api/auth/change-password', {
    old_password: oldPassword,
    new_password: newPassword,
  });
};

export const getInvitation = async (token: string): Promise<{ email: string; role: string }> => {
  const { data } = await api.get<{ email: string; role: string }>(`/api/auth/invite/${token}`);
  return data;
};

export const acceptInvite = async (payload: {
  token: string;
  name: string;
  password: string;
  language?: string;
}): Promise<User> => {
  const { data } = await api.post<User>('/api/auth/accept-invite', payload);
  return data;
};

export const inviteUser = async (payload: {
  email: string;
  role: string;
  plant_id?: string;
}): Promise<{ id: string; email: string; token: string; expires_at: string }> => {
  const { data } = await api.post('/api/auth/invite', payload);
  return data;
};
