import React, { useState, useMemo } from 'react';
import {
  Clock, Wrench, AlertTriangle, UserX, CheckCircle, Package,
  Monitor, Eye, User, FlaskConical, Truck, Flame, Zap, Settings,
  Link2, Brush, XCircle, HardHat, Search, AlertOctagon, Plus,
  Check, ChevronDown, BarChart3, Gauge, Bell, type LucideIcon,
} from 'lucide-react';

export const ICON_MAP: Record<string, LucideIcon> = {
  clock24: Clock,
  wrench: Wrench,
  exclamation: AlertTriangle,
  'no-operator': UserX,
  quality: CheckCircle,
  materials: Package,
  computer: Monitor,
  eye: Eye,
  operator: User,
  lab: FlaskConical,
  truck: Truck,
  fire: Flame,
  lightning: Zap,
  gear: Settings,
  chain: Link2,
  broom: Brush,
  'no-entry': XCircle,
  helmet: HardHat,
  magnifier: Search,
  warning: AlertOctagon,
  plus: Plus,
  checkmark: Check,
  chart: BarChart3,
  gauge: Gauge,
  bell: Bell,
};

const ICON_KEYS = Object.keys(ICON_MAP);

interface IconRendererProps {
  icon: string;
  color?: string;
  size?: number;
  className?: string;
}

export const IconRenderer: React.FC<IconRendererProps> = ({
  icon,
  color = '#6b7280',
  size = 24,
  className = '',
}) => {
  const IconComp = ICON_MAP[icon];
  if (IconComp) {
    return (
      <span
        className={`inline-flex items-center justify-center rounded-full ${className}`}
        style={{ background: color + '22', width: size + 12, height: size + 12 }}
      >
        <IconComp size={size} color={color} />
      </span>
    );
  }
  // Fallback: treat as emoji or text
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full ${className}`}
      style={{ background: color + '22', width: size + 12, height: size + 12, fontSize: size }}
    >
      {icon}
    </span>
  );
};

interface IconPickerProps {
  value: string;
  onChange: (key: string) => void;
}

export const IconPicker: React.FC<IconPickerProps> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const filtered = useMemo(
    () => ICON_KEYS.filter((k) => k.includes(search.toLowerCase())),
    [search],
  );

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-sm text-white hover:bg-gray-600"
      >
        <IconRenderer icon={value} size={16} />
        <span className="capitalize">{value}</span>
        <ChevronDown size={14} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-80 bg-gray-800 border border-gray-600 rounded-xl shadow-xl p-3">
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search icons…"
            className="w-full mb-3 px-3 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-sm text-white outline-none"
          />
          <div className="grid grid-cols-6 gap-2 max-h-52 overflow-y-auto">
            {filtered.map((key) => {
              const Icon = ICON_MAP[key];
              return (
                <button
                  key={key}
                  type="button"
                  title={key}
                  onClick={() => { onChange(key); setOpen(false); }}
                  className={`flex items-center justify-center p-2 rounded-lg hover:bg-gray-700 transition-colors ${
                    value === key ? 'bg-blue-600' : ''
                  }`}
                >
                  <Icon size={20} color="white" />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
