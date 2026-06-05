import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { useTranslation } from 'react-i18next';

interface ChartData {
  type: string;
  count: number;
}

const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-[#1f2937] border border-white/10 rounded-lg px-3 py-2 shadow-xl">
        <p className="text-gray-400 text-xs mb-1">{label}</p>
        <p className="text-blue-400 font-mono font-semibold text-sm">{payload[0].value}</p>
      </div>
    );
  }
  return null;
};

const WOBarChart = ({ data }: { data: ChartData[] }) => {
  const { t } = useTranslation();

  const chartData = data.map((d) => ({
    name: t(`type.${d.type}`, d.type),
    count: d.count,
  }));

  return (
    <ResponsiveContainer width="100%" height={210}>
      <BarChart data={chartData} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
        <XAxis
          dataKey="name"
          tick={{ fill: '#6b7280', fontSize: 11, fontFamily: 'Inter' }}
          axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: '#6b7280', fontSize: 11, fontFamily: 'JetBrains Mono' }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
        <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} maxBarSize={52} />
      </BarChart>
    </ResponsiveContainer>
  );
};

export default WOBarChart;
