import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchAlerts } from '../api/maintenance';
import { fetchTickets } from '../api/maintenance';
import { fetchMyWorkOrders } from '../api/workOrders';
import { useLiveEvents } from './useLiveEvents';

export interface LiveBadges {
  alertCount: number;
  ticketCount: number;
  myWorkCount: number;
  hasCritical: boolean;
}

const EMPTY: LiveBadges = { alertCount: 0, ticketCount: 0, myWorkCount: 0, hasCritical: false };

export function useLiveBadges(): LiveBadges {
  const [badges, setBadges] = useState<LiveBadges>(EMPTY);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  const doFetch = useCallback(async () => {
    if (document.visibilityState === 'hidden') return;
    try {
      const [alertRes, openRes, inProgRes, myWorkRes] = await Promise.allSettled([
        fetchAlerts({ limit: '1' }),
        fetchTickets({ status: 'open', limit: '50' }),
        fetchTickets({ status: 'in_progress', limit: '1' }),
        fetchMyWorkOrders(),
      ]);

      setBadges((prev) => {
        const alertCount  = alertRes.status === 'fulfilled'  ? alertRes.value.total  : prev.alertCount;
        const openTotal   = openRes.status === 'fulfilled'   ? openRes.value.total   : 0;
        const inProgTotal = inProgRes.status === 'fulfilled' ? inProgRes.value.total : 0;
        const myWorkItems = myWorkRes.status === 'fulfilled' ? myWorkRes.value : [];
        const hasCritical = openRes.status === 'fulfilled'
          ? openRes.value.items.some((t) => t.priority === 'critical')
          : prev.hasCritical;
        return {
          alertCount,
          ticketCount: openTotal + inProgTotal,
          myWorkCount: myWorkItems.filter(
            (w) => w.status !== 'completed' && w.status !== 'cancelled'
          ).length,
          hasCritical,
        };
      });
    } catch {
      // silent failure — keep current values
    }
  }, []);

  // Instant refresh when an alert/ticket/WO mutation is pushed over the live WS.
  useLiveEvents((e) => {
    if (e.topic === 'badges' || e.topic === 'reconnect') doFetch();
  });

  useEffect(() => {
    doFetch();
    intervalRef.current = setInterval(doFetch, 60_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') doFetch();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(intervalRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [doFetch]);

  return badges;
}
