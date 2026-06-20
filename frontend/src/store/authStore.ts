import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User, UserRole } from '../types';

export const ROLE_PERMISSIONS: Record<string, Set<string>> = {
  operator: new Set(['dashboard:view', 'machines:view', 'my_work:view']),
  technician: new Set([
    'dashboard:view', 'work_orders:view', 'work_orders:update',
    'technicians:view', 'equipment:view', 'my_work:view',
    'alerts:view', 'alerts:create', 'tickets:view', 'tickets:update',
    'maintenance:view', 'machines:view', 'schedule:view', 'pm_calendar:view',
  ]),
  supervisor: new Set([
    'dashboard:view', 'work_orders:view', 'work_orders:create', 'work_orders:update',
    'technicians:view', 'technicians:update', 'equipment:view', 'my_work:view',
    'alerts:view', 'alerts:create', 'alerts:update',
    'tickets:view', 'tickets:create', 'tickets:update',
    'maintenance:view', 'supervisor_view:view', 'machines:view',
    'schedule:view', 'schedule:update', 'pm_calendar:view', 'kpis:view',
  ]),
  maintenance_director: new Set([
    'dashboard:view',
    'work_orders:view', 'work_orders:create', 'work_orders:update', 'work_orders:delete',
    'technicians:view', 'technicians:create', 'technicians:update', 'technicians:delete',
    'equipment:view', 'equipment:create', 'equipment:update',
    'my_work:view', 'alerts:view', 'alerts:create', 'alerts:update', 'alerts:delete',
    'tickets:view', 'tickets:create', 'tickets:update', 'tickets:delete',
    'maintenance:view', 'supervisor_view:view', 'machines:view', 'machines:update',
    'schedule:view', 'schedule:create', 'schedule:update', 'schedule:delete',
    'pm_calendar:view', 'pm_calendar:create', 'pm_calendar:update',
    'kpis:view', 'settings_machines:view', 'settings_machines:update',
  ]),
  plant_manager: new Set([
    'dashboard:view',
    'work_orders:view', 'work_orders:create', 'work_orders:update', 'work_orders:delete',
    'technicians:view', 'technicians:create', 'technicians:update', 'technicians:delete',
    'equipment:view', 'equipment:create', 'equipment:update', 'equipment:delete',
    'my_work:view', 'alerts:view', 'alerts:create', 'alerts:update', 'alerts:delete',
    'tickets:view', 'tickets:create', 'tickets:update', 'tickets:delete',
    'maintenance:view', 'supervisor_view:view', 'machines:view', 'machines:update',
    'schedule:view', 'schedule:create', 'schedule:update', 'schedule:delete',
    'pm_calendar:view', 'pm_calendar:create', 'pm_calendar:update', 'pm_calendar:delete',
    'kpis:view', 'settings_machines:view', 'settings_machines:update', 'settings_users:view',
  ]),
  director: new Set([
    'dashboard:view', 'work_orders:view', 'technicians:view', 'equipment:view',
    'my_work:view', 'alerts:view', 'tickets:view', 'maintenance:view',
    'supervisor_view:view', 'machines:view', 'schedule:view', 'pm_calendar:view',
    'kpis:view', 'settings_machines:view',
  ]),
  admin: new Set(['*']),
};

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  permissions: string[] | null;   // effective 'resource:action' list from API; null = not loaded yet
  setAuth: (user: User, token: string) => void;
  setPermissions: (permissions: string[]) => void;
  patchUser: (patch: Partial<User>) => void;
  logout: () => void;
  can: (resource: string, action?: string) => boolean;
  hasRole: (...roles: UserRole[]) => boolean;
  isAdmin: () => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      permissions: null,
      setAuth: (user, token) => set({ user, token, isAuthenticated: true, permissions: null }),
      setPermissions: (permissions) => set({ permissions }),
      patchUser: (patch) => set((state) => ({ user: state.user ? { ...state.user, ...patch } : null })),
      logout: () => set({ user: null, token: null, isAuthenticated: false, permissions: null }),
      can: (resource: string, action = 'view') => {
        const { user, permissions } = get();
        if (!user) return false;
        const role = (user.role ?? 'operator') as string;
        if (role === 'admin') return true;
        // Once the effective permissions are loaded from the API, they are authoritative
        // (per-user overrides as an allow-list, or role defaults when the user has none).
        if (permissions !== null) {
          return permissions.includes('*') || permissions.includes(`${resource}:${action}`);
        }
        // Not loaded yet — fall back to role defaults to avoid a flash of hidden UI.
        const perms = ROLE_PERMISSIONS[role] ?? new Set<string>();
        return perms.has(`${resource}:${action}`);
      },
      hasRole: (...roles: UserRole[]) => {
        const { user } = get();
        if (!user) return false;
        return roles.includes((user.role ?? 'operator') as UserRole);
      },
      isAdmin: () => {
        const { user } = get();
        return user?.role === 'admin';
      },
    }),
    {
      name: 'foliot-auth',
      partialize: (state) => ({
        token: state.token,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        permissions: state.permissions,
      }),
    }
  )
);
