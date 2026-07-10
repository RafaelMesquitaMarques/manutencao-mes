import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PlantMembership } from '../types';

/**
 * Active-plant context (multi-plant phase 0).
 *
 * Memberships come from the login response (or /api/auth/me/plants for
 * sessions that predate it) and are replaced wholesale on every login — never
 * merged — so a different user on the same browser can't inherit another
 * user's plant list. The axios interceptor sends the active plant as
 * X-Plant-Id on every request; the backend validates it against user_plants
 * (the frontend value is context, never the security boundary).
 */
interface PlantState {
  memberships: PlantMembership[];
  activePlantId: string | null;
  setMemberships: (memberships: PlantMembership[], defaultPlantId?: string | null) => void;
  setActivePlant: (plantId: string) => void;
  clear: () => void;
}

export const usePlantStore = create<PlantState>()(
  persist(
    (set, get) => ({
      memberships: [],
      activePlantId: null,
      setMemberships: (memberships, defaultPlantId) => {
        const current = get().activePlantId;
        const stillValid = current && memberships.some((m) => m.plant_id === current);
        set({
          memberships,
          activePlantId: stillValid
            ? current
            : defaultPlantId ?? memberships[0]?.plant_id ?? null,
        });
      },
      // Only switches between authorized plants; callers reload the page after
      // switching so no page state or cached list survives across plants.
      setActivePlant: (plantId) => {
        if (!get().memberships.some((m) => m.plant_id === plantId)) return;
        set({ activePlantId: plantId });
      },
      clear: () => set({ memberships: [], activePlantId: null }),
    }),
    { name: 'kaizo-plant' }
  )
);
