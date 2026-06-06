import { useAuthStore } from '../store/authStore';
import type { UserRole } from '../types';

export function usePermission(resource: string, action = 'view'): boolean {
  return useAuthStore((state) => state.can(resource, action));
}

export function useRole(...roles: UserRole[]): boolean {
  return useAuthStore((state) => state.hasRole(...roles));
}

export function useIsAdmin(): boolean {
  return useAuthStore((state) => state.isAdmin());
}
