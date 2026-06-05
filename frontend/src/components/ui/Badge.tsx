import { useTranslation } from 'react-i18next';
import type { WorkOrderStatus, WorkOrderType, Priority } from '../../types';

type BadgeVariant = 'status' | 'type' | 'priority';

interface BadgeProps {
  value: string;
  variant: BadgeVariant;
  size?: 'sm' | 'md';
}

const statusClasses: Record<WorkOrderStatus, string> = {
  open: 'bg-blue-500/15 text-blue-400 border-blue-500/25',
  in_progress: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
  completed: 'bg-green-500/15 text-green-400 border-green-500/25',
  cancelled: 'bg-gray-500/15 text-gray-400 border-gray-500/25',
  on_hold: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
};

const typeClasses: Record<WorkOrderType, string> = {
  corrective:  'bg-orange-500/15 text-orange-400 border-orange-500/25',
  preventive:  'bg-teal-500/15 text-teal-400 border-teal-500/25',
  predictive:  'bg-violet-500/15 text-violet-400 border-violet-500/25',
  inspection:  'bg-sky-500/15 text-sky-400 border-sky-500/25',
  improvement: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
};

const priorityClasses: Record<Priority, string> = {
  low: 'bg-gray-500/15 text-gray-400 border-gray-500/25',
  medium: 'bg-sky-500/15 text-sky-400 border-sky-500/25',
  high: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
  critical: 'bg-red-500/15 text-red-400 border-red-500/25',
};

const Badge = ({ value, variant, size = 'sm' }: BadgeProps) => {
  const { t } = useTranslation();

  const getClasses = () => {
    const fallback = 'bg-gray-500/15 text-gray-400 border-gray-500/25';
    if (variant === 'status') return statusClasses[value as WorkOrderStatus] ?? fallback;
    if (variant === 'type') return typeClasses[value as WorkOrderType] ?? fallback;
    return priorityClasses[value as Priority] ?? fallback;
  };

  const sizeClasses = size === 'md'
    ? 'px-2.5 py-1 text-xs'
    : 'px-2 py-0.5 text-xs';

  return (
    <span
      className={`inline-flex items-center font-mono font-medium border rounded ${sizeClasses} ${getClasses()}`}
    >
      {t(`${variant}.${value}`, value)}
    </span>
  );
};

export default Badge;
