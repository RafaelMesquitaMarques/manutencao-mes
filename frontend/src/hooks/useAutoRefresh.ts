import { useState, useEffect, useCallback, useRef } from 'react';

export interface UseAutoRefreshResult {
  lastUpdatedAt: Date | null;
  isRefreshing: boolean;
  hasError: boolean;
  manualRefresh: () => void;
}

/**
 * Calls silentLoad every intervalMs while the tab is visible.
 * Pauses when hidden, triggers immediately on tab focus.
 * manualRefresh shows isRefreshing=true and resets the countdown.
 */
export function useAutoRefresh(
  silentLoad: () => Promise<void>,
  intervalMs = 30_000,
): UseAutoRefreshResult {
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasError, setHasError] = useState(false);

  const silentLoadRef = useRef(silentLoad);
  useEffect(() => { silentLoadRef.current = silentLoad; }, [silentLoad]);

  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  const runSilent = useCallback(async () => {
    if (document.visibilityState === 'hidden') return;
    try {
      await silentLoadRef.current();
      setLastUpdatedAt(new Date());
      setHasError(false);
    } catch {
      setHasError(true);
    }
  }, []);

  const resetInterval = useCallback(() => {
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(runSilent, intervalMs);
  }, [runSilent, intervalMs]);

  useEffect(() => {
    resetInterval();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        runSilent();
        resetInterval();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(intervalRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [runSilent, resetInterval]);

  const manualRefresh = useCallback(() => {
    setIsRefreshing(true);
    silentLoadRef.current()
      .then(() => {
        setLastUpdatedAt(new Date());
        setHasError(false);
      })
      .catch(() => { setHasError(true); })
      .finally(() => {
        setIsRefreshing(false);
        resetInterval();
      });
  }, [resetInterval]);

  return { lastUpdatedAt, isRefreshing, hasError, manualRefresh };
}
