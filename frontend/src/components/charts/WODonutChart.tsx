import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { useTranslation } from 'react-i18next';

interface ChartData {
  status: string;
  count: number;
}

const STATUS_COLORS: Record<string, string> = {
  open: '#3b82f6',
  in_progress: '#f59e0b',
  completed: '#22c55e',
  cancelled: '#6b7280',
  on_hold: '#a855f7',
};

const CustomTooltip = ({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { name: string; value: number; payload: { fill: string; pct: number } }[];
}) => {
  if (active && payload && payload.length) {
    const { name, value, payload: p } = payload[0];
    return (
      <div className="bg-[#1f2937] border border-white/10 rounded-lg px-3 py-2 shadow-xl">
        <p className="text-gray-400 text-xs mb-1">{name}</p>
        <p className="font-mono font-semibold text-sm" style={{ color: p.fill }}>
          {value} &nbsp;<span className="text-gray-500 text-xs font-normal">({p.pct}%)</span>
        </p>
      </div>
    );
  }
  return null;
};

const WODonutChart = ({ data }: { data: ChartData[] }) => {
  const { t } = useTranslation();
  const total = data.reduce((s, d) => s + d.count, 0);

  const chartData = data.map((d) => ({
    name: t(`status.${d.status}`, d.status),
    value: d.count,
    fill: STATUS_COLORS[d.status] ?? '#6b7280',
    pct: total > 0 ? Math.round((d.count / total) * 100) : 0,
  }));

  return (
    <ResponsiveContainer width="100%" height={210}>
      <PieChart>
        <Pie
          data={chartData}
          cx="50%"
          cy="45%"
          innerRadius={58}
          outerRadius={86}
          paddingAngle={3}
          dataKey="value"
          strokeWidth={0}
        >
          {chartData.map((entry, i) => (
            <Cell key={i} fill={entry.fill} />
          ))}
        </Pie>
        <Tooltip content={<CustomTooltip />} />
        <Legend
          iconSize={7}
          iconType="circle"
          formatter={(value) => (
            <span style={{ color: '#9ca3af', fontSize: 11, fontFamily: 'Inter' }}>{value}</span>
          )}
        />
      </PieChart>
    </ResponsiveContainer>
  );
};

export default WODonutChart;
