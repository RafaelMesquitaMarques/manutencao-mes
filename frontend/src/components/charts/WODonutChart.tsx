import ReactECharts from 'echarts-for-react';
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

// Matches the donut style used on the Maintenance Dashboard: ring on the left,
// vertical legend on the right, item tooltip with count + percentage.
const WODonutChart = ({ data }: { data: ChartData[] }) => {
  const { t } = useTranslation();

  const chartData = data.map((d) => ({
    name: t(`status.${d.status}`, d.status),
    value: d.count,
    itemStyle: { color: STATUS_COLORS[d.status] ?? '#6b7280' },
  }));

  const option = {
    tooltip: {
      trigger: 'item',
      backgroundColor: '#111827',
      borderColor: 'rgba(255,255,255,0.1)',
      textStyle: { color: '#e5e7eb' },
      formatter: '{b}: {c} ({d}%)',
    },
    legend: {
      orient: 'vertical',
      right: 16,
      top: 'center',
      textStyle: { color: '#9ca3af', fontSize: 11 },
    },
    series: [
      {
        type: 'pie',
        radius: ['45%', '70%'],
        center: ['35%', '50%'],
        data: chartData,
        label: { show: false },
        labelLine: { show: false },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.5)' } },
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: 210 }} />;
};

export default WODonutChart;
