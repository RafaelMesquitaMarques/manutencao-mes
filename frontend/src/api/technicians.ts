import api from './axios';
import type { TechnicianFull, TechnicianBreak } from '../types';

// ─── Current technician (self) ───────────────────────────────────────────────

export const fetchMyTechnician = async (): Promise<TechnicianFull> => {
  const { data } = await api.get<TechnicianFull>('/api/technicians/me');
  return data;
};

// ─── Announced (live) break — presence self-service ──────────────────────────
// Lets the technician tell the team they are actually on break, separate from
// the scheduled breaks that drive labor cost.

export const fetchMyActiveBreak = async (): Promise<TechnicianBreak | null> => {
  const { data } = await api.get<TechnicianBreak | null>('/api/technicians/me/break');
  return data ?? null;
};

export const startMyBreak = async (): Promise<TechnicianBreak> => {
  const { data } = await api.post<TechnicianBreak>('/api/technicians/me/break');
  return data;
};

export const endMyBreak = async (): Promise<TechnicianBreak> => {
  const { data } = await api.post<TechnicianBreak>('/api/technicians/me/break/end');
  return data;
};
