import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Wrench, LogIn, LogOut } from 'lucide-react';
import {
  fetchWOCheckin,
  checkinWOIntervention,
  checkoutWOIntervention,
} from '../api/workOrders';
import type { WOCheckinState } from '../api/workOrders';

function elapsedStr(from: string): string {
  const mins = Math.floor((Date.now() - new Date(from).getTime()) / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// Office-side twin of the kiosk's technician check-in card: when the WO's
// machine has an ACTIVE intervention, the logged-in technician can join/leave
// it from My Work or the WO detail. Renders nothing when there is no active
// intervention (or the WO has no machine).
export default function InterventionCheckin({ workOrderId }: { workOrderId: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<WOCheckinState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await fetchWOCheckin(workOrderId));
    } catch {
      setState(null);
    }
  }, [workOrderId]);

  useEffect(() => { load(); }, [load]);

  if (!state?.active) return null;

  const toggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      const updated = state.me_checked_in
        ? await checkoutWOIntervention(workOrderId)
        : await checkinWOIntervention(workOrderId);
      setState(updated);
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      if (detail === 'no_technician_profile') setErr(t('workOrders.checkinNoTechProfile'));
      else if (detail === 'no_active_intervention') { setErr(null); await load(); }
      else setErr(t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg px-3 py-2.5 bg-purple-500/10 border border-purple-500/25 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs font-semibold text-purple-300 flex items-center gap-1.5">
          <Wrench size={12} />
          {t('workOrders.interventionOngoing')}
        </span>
        {state.has_tech_profile && (
          <button
            onClick={toggle}
            disabled={busy}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border transition-colors disabled:opacity-50 ${
              state.me_checked_in
                ? 'bg-purple-500/15 border-purple-500/40 text-purple-300 hover:bg-purple-500/25'
                : 'bg-blue-500/15 border-blue-500/40 text-blue-300 hover:bg-blue-500/25'
            }`}
          >
            {state.me_checked_in ? <LogOut size={12} /> : <LogIn size={12} />}
            {state.me_checked_in ? t('workOrders.checkOutIntervention') : t('workOrders.checkInIntervention')}
          </button>
        )}
      </div>
      {state.technicians.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {state.technicians.map((c) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-1.5 text-xs text-purple-200/90 bg-purple-500/10 border border-purple-500/30 rounded-full px-2.5 py-0.5"
            >
              {c.name}
              {c.checked_in_at && (
                <span className="text-purple-400/60 text-[10px]">{elapsedStr(c.checked_in_at)}</span>
              )}
            </span>
          ))}
        </div>
      )}
      {err && <p className="text-xs text-amber-400">{err}</p>}
    </div>
  );
}
