import api from './axios';
import { useAuthStore } from '../store/authStore';
import { usePlantStore } from '../store/plantStore';
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

/** 'voice' = the answer is spoken aloud: short conversational replies that
 * offer details instead of dumping the full report. */
export type AskMode = 'text' | 'voice';

/** Ask the intelligence assistant a natural-language question about the plant's data. */
export async function askIntelligence(
  messages: ChatMessage[],
  language = 'en',
  mode: AskMode = 'text',
): Promise<ChatAskResult> {
  const { data } = await api.post<ChatAskResult>('/api/intelligence/ask', { messages, language, mode });
  return data;
}

/** The agent itself failed server-side — retrying non-streaming would just
 * re-run the same failure (and double the cost). */
export class AskStreamServerError extends Error {}

export interface AskStreamHandlers {
  /** Text tokens of the current model turn (append to the live bubble). */
  onDelta?: (text: string) => void;
  /** A data tool started running server-side. */
  onTool?: (name: string) => void;
  /** The turn ended in a tool call — text streamed so far was preliminary, discard it. */
  onRound?: () => void;
  /** Model state before tokens arrive ('thinking' | 'answering'). */
  onStatus?: (phase: string) => void;
}

/**
 * Streaming variant of askIntelligence (SSE over fetch — axios can't stream).
 * Resolves with the authoritative final result; throws on transport or server
 * error so callers can fall back to the non-streaming endpoint.
 */
export async function askIntelligenceStream(
  messages: ChatMessage[],
  language: string,
  handlers: AskStreamHandlers,
  signal?: AbortSignal,
  mode: AskMode = 'text',
): Promise<ChatAskResult> {
  // Same headers the axios interceptor adds (auth + active-plant context).
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = useAuthStore.getState().token;
  if (token) headers.Authorization = `Bearer ${token}`;
  const plantId = usePlantStore.getState().activePlantId;
  if (plantId) headers['X-Plant-Id'] = plantId;

  const res = await fetch('/api/intelligence/ask/stream', {
    method: 'POST',
    headers,
    body: JSON.stringify({ messages, language, mode }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`stream request failed (${res.status})`);

  let final: ChatAskResult | null = null;
  let errorDetail: string | null = null;

  const handleEvent = (event: string, dataRaw: string) => {
    let data: Record<string, unknown>;
    try { data = JSON.parse(dataRaw); } catch { return; }
    if (event === 'delta') handlers.onDelta?.(String(data.text ?? ''));
    else if (event === 'tool') handlers.onTool?.(String(data.name ?? ''));
    else if (event === 'round') handlers.onRound?.();
    else if (event === 'status') handlers.onStatus?.(String(data.phase ?? ''));
    else if (event === 'done') {
      final = {
        answer: String(data.answer ?? ''),
        used_tools: Array.isArray(data.used_tools) ? (data.used_tools as string[]) : [],
        ai_generated: Boolean(data.ai_generated),
      };
    } else if (event === 'error') errorDetail = String(data.detail ?? 'stream error');
  };

  // Minimal SSE parser — the server only emits `event:` + single-line `data:`
  // frames separated by a blank line.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) handleEvent(event, dataLines.join('\n'));
    }
  }

  if (errorDetail) throw new AskStreamServerError(errorDetail);
  if (!final) throw new Error('stream ended without a result');
  return final;
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
