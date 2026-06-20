import api from './axios';
import type {
  AIInsight,
  InsightListResponse,
  MachineRiskListResponse,
  SparePartRiskListResponse,
  AIRecommendation,
  GenerateInsightRequest,
} from '../types';

export async function generateInsight(body: GenerateInsightRequest): Promise<AIInsight> {
  const { data } = await api.post<AIInsight>('/api/intelligence/generate', body);
  return data;
}

export async function fetchLatestInsight(
  language = 'fr',
  insight_type = 'full_report',
): Promise<AIInsight | null> {
  try {
    const { data } = await api.get<AIInsight>('/api/intelligence/latest', {
      params: { language, insight_type },
    });
    return data;
  } catch {
    return null; // 404 = none generated yet
  }
}

export async function fetchInsightHistory(
  params?: { language?: string; insight_type?: string; limit?: number; offset?: number },
): Promise<InsightListResponse> {
  const { data } = await api.get<InsightListResponse>('/api/intelligence/history', { params });
  return data;
}

export async function fetchRiskScores(
  risk_level?: string,
): Promise<MachineRiskListResponse> {
  const { data } = await api.get<MachineRiskListResponse>('/api/intelligence/risk-scores', {
    params: risk_level ? { risk_level } : {},
  });
  return data;
}

export async function fetchSparePartsRisk(
  risk_level?: string,
): Promise<SparePartRiskListResponse> {
  const { data } = await api.get<SparePartRiskListResponse>('/api/intelligence/spare-parts-risk', {
    params: risk_level ? { risk_level } : {},
  });
  return data;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatAskResult {
  answer: string;
  used_tools: string[];
  ai_generated: boolean;
}

/** Ask the intelligence assistant a natural-language question about the plant's data. */
export async function askIntelligence(
  messages: ChatMessage[],
  language = 'en',
): Promise<ChatAskResult> {
  const { data } = await api.post<ChatAskResult>('/api/intelligence/ask', { messages, language });
  return data;
}

export async function acknowledgeRecommendation(
  id: string,
  acknowledged_by: string,
): Promise<AIRecommendation> {
  const { data } = await api.patch<AIRecommendation>(
    `/api/intelligence/recommendations/${id}/acknowledge`,
    { acknowledged_by },
  );
  return data;
}
