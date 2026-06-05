import { create } from 'zustand';
import type { WorkOrder } from '../types';

interface WorkOrderState {
  workOrders: WorkOrder[];
  isLoading: boolean;
  error: string | null;
  setWorkOrders: (wos: WorkOrder[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  upsertWorkOrder: (wo: WorkOrder) => void;
  addWorkOrder: (wo: WorkOrder) => void;
}

export const useWorkOrderStore = create<WorkOrderState>()((set) => ({
  workOrders: [],
  isLoading: false,
  error: null,
  setWorkOrders: (workOrders) => set({ workOrders }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
  upsertWorkOrder: (wo) =>
    set((state) => ({
      workOrders: state.workOrders.some((w) => w.id === wo.id)
        ? state.workOrders.map((w) => (w.id === wo.id ? wo : w))
        : [wo, ...state.workOrders],
    })),
  addWorkOrder: (wo) =>
    set((state) => ({ workOrders: [wo, ...state.workOrders] })),
}));
