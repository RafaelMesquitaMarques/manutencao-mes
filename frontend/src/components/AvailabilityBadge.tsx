import { useTranslation } from 'react-i18next';
import {
  CheckCircle2, XCircle, Palmtree, Clock, Coffee, Utensils, Ban,
} from 'lucide-react';
import type { AvailabilityStatus, TechnicianAvailability } from '../types';

// Visual mapping for each availability state. Colors follow the app palette:
// green = assignable, amber = soft-warn (off shift / break), red = hard-warn
// (inactive / vacation / unavailable).
const STYLE: Record<AvailabilityStatus, { cls: string; Icon: typeof CheckCircle2 }> = {
  available:   { cls: 'bg-green-500/15 text-green-400 border-green-500/25',   Icon: CheckCircle2 },
  inactive:    { cls: 'bg-gray-500/15 text-gray-400 border-gray-500/25',      Icon: XCircle },
  on_vacation: { cls: 'bg-purple-500/15 text-purple-400 border-purple-500/25', Icon: Palmtree },
  unavailable: { cls: 'bg-red-500/15 text-red-400 border-red-500/25',         Icon: Ban },
  off_shift:   { cls: 'bg-amber-500/15 text-amber-400 border-amber-500/25',   Icon: Clock },
  at_lunch:    { cls: 'bg-amber-500/15 text-amber-400 border-amber-500/25',   Icon: Utensils },
  on_break:    { cls: 'bg-amber-500/15 text-amber-400 border-amber-500/25',   Icon: Coffee },
};

export default function AvailabilityBadge({
  availability, size = 13,
}: {
  availability?: TechnicianAvailability | null;
  size?: number;
}) {
  const { t } = useTranslation();
  if (!availability) return <span className="text-gray-600 text-xs">—</span>;
  const s = STYLE[availability.status] ?? STYLE.available;
  const { Icon } = s;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${s.cls}`}
      title={availability.detail ?? undefined}
    >
      <Icon size={size} />
      {t(`availability.${availability.status}`)}
    </span>
  );
}
