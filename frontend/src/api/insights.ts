import api from './axios';

export type InsightSeverity = 'critical' | 'warn' | 'info' | 'good';

export interface HomeInsight {
  kind: string;
  severity: InsightSeverity;
  params: Record<string, string | number>;
  link: string | null;
  machine_id?: string;
}

export interface HomeInsightsResponse {
  generated_at: string;
  insights: HomeInsight[];
}

export const fetchHomeInsights = async (): Promise<HomeInsightsResponse> => {
  const { data } = await api.get<HomeInsightsResponse>('/api/insights/home');
  return data;
};
