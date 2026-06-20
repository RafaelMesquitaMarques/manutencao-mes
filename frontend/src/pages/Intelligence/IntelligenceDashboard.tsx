import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Sparkles, RefreshCw, AlertTriangle, Package, CheckCircle2,
  ClipboardCheck, Clock, ChevronDown, Cpu, Lightbulb, Send, Loader2,
} from 'lucide-react';
import {
  fetchLatestInsight, generateInsight, fetchRiskScores, fetchSparePartsRisk,
  acknowledgeRecommendation, askIntelligence, type ChatMessage,
} from '../../api/intelligence';
import { useAuthStore } from '../../store/authStore';
import type {
  AIInsight, MachineRiskScore, SparePartRiskItem, IntelRiskLevel, InsightType,
} from '../../types';
import Spinner from '../../components/ui/Spinner';

const RISK_STYLE: Record<IntelRiskLevel, { bg: string; text: string; border: string; dot: string }> = {
  critical: { bg: 'bg-red-500/10',    text: 'text-red-400',    border: 'border-red-500/30',    dot: 'bg-red-500' },
  high:     { bg: 'bg-orange-500/10', text: 'text-orange-400', border: 'border-orange-500/30', dot: 'bg-orange-500' },
  medium:   { bg: 'bg-amber-500/10',  text: 'text-amber-400',  border: 'border-amber-500/30',  dot: 'bg-amber-500' },
  low:      { bg: 'bg-green-500/10',  text: 'text-green-400',  border: 'border-green-500/30',  dot: 'bg-green-500' },
};

const INSIGHT_TYPES: InsightType[] = [
  'full_report', 'daily_summary', 'machine_risk',
  'top_irritants', 'trend_analysis', 'spare_parts', 'technician_workload',
];

const PERIODS = [7, 30, 90];

/** Minimal markdown renderer for the AI insight text (##/###, **bold**, - lists). */
function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const lines = text.split('\n');
    const out: React.ReactNode[] = [];
    let list: string[] = [];
    const flushList = (key: string) => {
      if (list.length) {
        out.push(
          <ul key={key} className="list-disc pl-5 space-y-1 my-2 text-gray-300 text-sm">
            {list.map((li, i) => <li key={i}>{inline(li)}</li>)}
          </ul>,
        );
        list = [];
      }
    };
    const inline = (s: string): React.ReactNode => {
      // **bold** segments
      const parts = s.split(/(\*\*[^*]+\*\*)/g);
      return parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**')
          ? <strong key={i} className="text-white font-semibold">{p.slice(2, -2)}</strong>
          : <span key={i}>{p}</span>,
      );
    };
    lines.forEach((raw, idx) => {
      const line = raw.trimEnd();
      if (/^###\s+/.test(line)) { flushList(`l${idx}`); out.push(<h4 key={idx} className="text-sm font-semibold text-gray-200 mt-4 mb-1">{inline(line.replace(/^###\s+/, ''))}</h4>); }
      else if (/^##\s+/.test(line)) { flushList(`l${idx}`); out.push(<h3 key={idx} className="text-base font-bold text-white mt-5 mb-2 flex items-center gap-2"><span className="w-1 h-4 bg-blue-500 rounded-full" />{inline(line.replace(/^##\s+/, ''))}</h3>); }
      else if (/^#\s+/.test(line)) { flushList(`l${idx}`); out.push(<h2 key={idx} className="text-lg font-bold text-white mb-2">{inline(line.replace(/^#\s+/, ''))}</h2>); }
      else if (/^[-*]\s+/.test(line)) { list.push(line.replace(/^[-*]\s+/, '')); }
      else if (line === '' || line === '---') { flushList(`l${idx}`); }
      else { flushList(`l${idx}`); out.push(<p key={idx} className="text-sm text-gray-300 leading-relaxed my-1.5">{inline(line)}</p>); }
    });
    flushList('last');
    return out;
  }, [text]);
  return <div className="max-w-none">{blocks}</div>;
}

function RiskBadge({ level }: { level: IntelRiskLevel }) {
  const s = RISK_STYLE[level];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-medium ${s.bg} ${s.text} ${s.border}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {level}
    </span>
  );
}

/** Conversational Q&A over the platform's live data (tool-use agent). */
function IntelligenceChat({ language }: { language: string }) {
  const { t } = useTranslation();
  // Suggested prompts — translated, so they follow the platform language.
  const exampleQs = [
    t('intelligence.example1', 'Compare IMA 04 with IMA 05'),
    t('intelligence.example2', 'Which machine broke down the most in the last 7 days?'),
    t('intelligence.example3', 'Which machine has the best availability rate?'),
  ];
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setError(null);
    const next: ChatMessage[] = [...messages, { role: 'user', content: q }];
    setMessages(next);
    setInput('');
    setBusy(true);
    try {
      const res = await askIntelligence(next, language);
      setMessages((m) => [...m, { role: 'assistant', content: res.answer }]);
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(detail ?? t('intelligence.askError', 'Request failed. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-violet-500/15 flex items-center justify-center flex-shrink-0">
            <Sparkles size={16} className="text-violet-300" />
          </div>
          <div>
            <h2 className="text-white font-semibold text-sm">{t('intelligence.askTitle', 'Ask the data')}</h2>
            <p className="text-gray-500 text-[11px]">{t('intelligence.askHint', 'Natural-language questions about machines, KPIs, tickets, parts…')}</p>
          </div>
        </div>
        {messages.length > 0 && (
          <button onClick={() => { setMessages([]); setError(null); }} disabled={busy}
            className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-40">
            {t('intelligence.clearChat', 'Clear')}
          </button>
        )}
      </div>

      {messages.length > 0 && (
        <div ref={scrollRef} className="max-h-[26rem] overflow-y-auto space-y-3 mb-3 pr-1">
          {messages.map((m, i) => (
            m.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] bg-blue-600/20 border border-blue-500/25 rounded-2xl rounded-br-sm px-3.5 py-2 text-sm text-blue-50 whitespace-pre-wrap">{m.content}</div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div className="max-w-[90%] bg-white/[0.03] border border-white/[0.06] rounded-2xl rounded-bl-sm px-3.5 py-2">
                  <Markdown text={m.content} />
                </div>
              </div>
            )
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 bg-white/[0.03] border border-white/[0.06] rounded-2xl rounded-bl-sm px-3.5 py-2 text-gray-400 text-sm">
                <Loader2 size={14} className="animate-spin" /> {t('intelligence.thinking', 'Analyzing the data…')}
              </div>
            </div>
          )}
        </div>
      )}

      {messages.length === 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {exampleQs.map((ex) => (
            <button key={ex} onClick={() => send(ex)} disabled={busy}
              className="text-xs text-gray-300 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] rounded-full px-3 py-1.5 transition-colors disabled:opacity-40">
              {ex}
            </button>
          ))}
        </div>
      )}

      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}

      <div className="flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }}
          rows={1}
          placeholder={t('intelligence.askPlaceholder', 'e.g. Compare IMA 04 with IMA 05')}
          disabled={busy}
          className="flex-1 resize-none bg-[#0d1421] border border-white/[0.08] rounded-xl px-3.5 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500/50 max-h-32"
        />
        <button onClick={() => send(input)} disabled={busy || !input.trim()}
          className="flex items-center justify-center w-10 h-10 rounded-xl bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40 flex-shrink-0">
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </div>
    </div>
  );
}

export default function IntelligenceDashboard() {
  const { t, i18n } = useTranslation();
  const userName = useAuthStore((s) => s.user?.name ?? 'User');

  const [insight, setInsight] = useState<AIInsight | null>(null);
  const [risks, setRisks] = useState<MachineRiskScore[]>([]);
  const [parts, setParts] = useState<SparePartRiskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [ackId, setAckId] = useState<string | null>(null);

  // The platform only ships EN/FR/ES; fall back to EN for any other detected locale.
  const platformLang = (l: string) => (['en', 'fr', 'es'].includes((l || '').slice(0, 2)) ? (l || '').slice(0, 2) : 'en');
  const [genLang, setGenLang] = useState(() => platformLang(i18n.language));
  const [genPeriod, setGenPeriod] = useState(30);
  const [genType, setGenType] = useState<InsightType>('full_report');

  // Follow the language the user picks platform-wide (chat + report default).
  useEffect(() => { setGenLang(platformLang(i18n.language)); }, [i18n.language]);

  const load = useCallback(async (lang: string, type: InsightType) => {
    setLoading(true);
    try {
      const [ins, rs, sp] = await Promise.allSettled([
        fetchLatestInsight(lang, type),
        fetchRiskScores(),
        fetchSparePartsRisk(),
      ]);
      if (ins.status === 'fulfilled') setInsight(ins.value);
      if (rs.status === 'fulfilled') setRisks(rs.value.items);
      if (sp.status === 'fulfilled') setParts(sp.value.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(genLang, genType); }, [load, genLang, genType]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const ins = await generateInsight({ language: genLang, period_days: genPeriod, insight_type: genType });
      setInsight(ins);
      // refresh risk/parts which were recomputed by the generation
      const [rs, sp] = await Promise.allSettled([fetchRiskScores(), fetchSparePartsRisk()]);
      if (rs.status === 'fulfilled') setRisks(rs.value.items);
      if (sp.status === 'fulfilled') setParts(sp.value.items);
    } finally {
      setGenerating(false);
    }
  };

  const handleAck = async (id: string) => {
    setAckId(id);
    try {
      const updated = await acknowledgeRecommendation(id, userName);
      setInsight((prev) => prev ? {
        ...prev,
        recommendations: prev.recommendations.map((r) => r.id === id ? updated : r),
      } : prev);
    } finally {
      setAckId(null);
    }
  };

  const atRiskMachines = risks.filter((r) => r.risk_level === 'high' || r.risk_level === 'critical');
  const selectCls = 'bg-[#0d1421] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500';

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-brand text-xl font-bold uppercase tracking-[0.1em] text-white flex items-center gap-2.5">
            <img src="/mirai-icon.png" alt="" className="w-7 h-7 object-contain" />
            {t('intelligence.title', 'Ask Ninja')}
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">{t('intelligence.subtitle', 'AI-assisted analysis of maintenance data')}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={genType} onChange={(e) => setGenType(e.target.value as InsightType)} className={selectCls} title={t('intelligence.reportType', 'Report type')}>
            {INSIGHT_TYPES.map((tp) => <option key={tp} value={tp}>{t(`intelligence.type.${tp}`, tp)}</option>)}
          </select>
          <div className="flex gap-1 bg-white/[0.04] rounded-lg p-1">
            {PERIODS.map((p) => (
              <button key={p} onClick={() => setGenPeriod(p)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${genPeriod === p ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-white/[0.06]'}`}>
                {p}{t('intelligence.daysShort', 'd')}
              </button>
            ))}
          </div>
          <div className="relative">
            <select value={genLang} onChange={(e) => setGenLang(e.target.value)} className={`${selectCls} pr-7 appearance-none uppercase`}>
              <option value="en">EN</option>
              <option value="fr">FR</option>
              <option value="es">ES</option>
            </select>
            <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 pointer-events-none" />
          </div>
          <button onClick={handleGenerate} disabled={generating}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-violet-600 hover:bg-violet-500 rounded-lg disabled:opacity-50">
            <Sparkles size={15} className={generating ? 'animate-pulse' : ''} />
            {generating ? t('intelligence.generating', 'Generating…') : t('intelligence.generate', 'Generate')}
          </button>
        </div>
      </div>

      {/* Conversational Q&A over live data */}
      <IntelligenceChat language={genLang} />

      {loading ? (
        <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>
      ) : (
        <div className="grid lg:grid-cols-3 gap-6">
          {/* ── Left: AI narrative + recommendations (2 cols) ── */}
          <div className="lg:col-span-2 space-y-6">
            <div className="glass-card p-6">
              {!insight ? (
                <div className="flex flex-col items-center justify-center h-56 gap-3 text-center">
                  <img src="/mirai-icon.png" alt="" className="w-12 h-12 object-contain opacity-40" />
                  <p className="text-gray-400 font-medium">{t('intelligence.noInsight', 'No analysis yet')}</p>
                  <p className="text-gray-600 text-sm max-w-sm">{t('intelligence.noInsightHint', 'Click Generate to produce a maintenance intelligence report for the selected period.')}</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3 mb-4 pb-4 border-b border-white/[0.06]">
                    <div className="flex items-center gap-2 flex-wrap">
                      {insight.ai_generated ? (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-medium bg-violet-500/10 text-violet-300 border-violet-500/30">
                          <Cpu size={11} /> {insight.generated_by_model ?? 'AI'}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-medium bg-gray-500/10 text-gray-400 border-gray-500/30">
                          <AlertTriangle size={11} /> {t('intelligence.fallback', 'Calculator-only (no AI key)')}
                        </span>
                      )}
                      <span className="text-[11px] text-gray-600 uppercase font-mono">{insight.language}</span>
                    </div>
                    <span className="text-[11px] text-gray-600 flex items-center gap-1">
                      <Clock size={11} />
                      {new Date(insight.generated_at).toLocaleString()}
                    </span>
                  </div>
                  <Markdown text={insight.insight_text} />
                </>
              )}
            </div>

            {/* Recommendations */}
            {insight && insight.recommendations.length > 0 && (
              <div className="glass-card p-6">
                <h2 className="text-white font-semibold flex items-center gap-2 mb-4">
                  <Lightbulb size={16} className="text-amber-400" />
                  {t('intelligence.recommendations', 'Recommendations')}
                  <span className="text-xs text-gray-600 font-mono">({insight.recommendations.length})</span>
                </h2>
                <div className="space-y-3">
                  {insight.recommendations.map((rec) => (
                    <div key={rec.id} className={`rounded-xl border p-4 ${RISK_STYLE[rec.risk_level].border} bg-white/[0.02]`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <RiskBadge level={rec.risk_level} />
                          <h3 className="text-sm font-semibold text-white truncate">{rec.title}</h3>
                        </div>
                        {rec.status === 'acknowledged' ? (
                          <span className="flex items-center gap-1 text-[11px] text-green-400 flex-shrink-0">
                            <CheckCircle2 size={13} /> {t('intelligence.acknowledged', 'Acknowledged')}
                            {rec.acknowledged_by && <span className="text-gray-600">· {rec.acknowledged_by}</span>}
                          </span>
                        ) : (
                          <button onClick={() => handleAck(rec.id)} disabled={ackId === rec.id}
                            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-blue-300 bg-blue-500/10 border border-blue-500/25 hover:bg-blue-500/20 rounded-lg flex-shrink-0 disabled:opacity-50">
                            <ClipboardCheck size={12} />
                            {ackId === rec.id ? '…' : t('intelligence.acknowledge', 'Acknowledge')}
                          </button>
                        )}
                      </div>
                      <div className="mt-2 space-y-1.5 text-xs">
                        <p className="text-gray-400"><span className="text-gray-600 uppercase text-[10px] tracking-wide">{t('intelligence.evidence', 'Evidence')}: </span>{rec.evidence}</p>
                        <p className="text-gray-400"><span className="text-gray-600 uppercase text-[10px] tracking-wide">{t('intelligence.impact', 'Impact')}: </span>{rec.impact}</p>
                        <p className="text-gray-300"><span className="text-gray-600 uppercase text-[10px] tracking-wide">{t('intelligence.action', 'Action')}: </span>{rec.recommendation}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── Right: risk panels ── */}
          <div className="space-y-6">
            {/* Machine risk */}
            <div className="glass-card p-5">
              <h2 className="text-white font-semibold text-sm flex items-center gap-2 mb-4">
                <AlertTriangle size={15} className="text-red-400" />
                {t('intelligence.machineRisk', 'Machine risk')}
                {atRiskMachines.length > 0 && (
                  <span className="ml-auto text-[11px] text-red-400 bg-red-500/10 border border-red-500/25 px-1.5 py-0.5 rounded-full">
                    {atRiskMachines.length} {t('intelligence.atRisk', 'at risk')}
                  </span>
                )}
              </h2>
              {risks.length === 0 ? (
                <p className="text-gray-600 text-sm text-center py-6">{t('common.noData', 'No data')}</p>
              ) : (
                <div className="space-y-2">
                  {risks.slice(0, 12).map((r) => (
                    <div key={r.id} className="flex items-center gap-3">
                      <div className="w-9 text-right">
                        <span className={`text-sm font-mono font-bold ${RISK_STYLE[r.risk_level].text}`}>{Math.round(r.score)}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-200 truncate">{r.machine_name}</p>
                        <div className="h-1.5 bg-white/[0.05] rounded-full mt-1 overflow-hidden">
                          <div className={`h-full ${RISK_STYLE[r.risk_level].dot} rounded-full`} style={{ width: `${Math.min(r.score, 100)}%` }} />
                        </div>
                      </div>
                      <RiskBadge level={r.risk_level} />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Spare parts risk */}
            <div className="glass-card p-5">
              <h2 className="text-white font-semibold text-sm flex items-center gap-2 mb-4">
                <Package size={15} className="text-sky-400" />
                {t('intelligence.sparePartsRisk', 'Spare parts at risk')}
              </h2>
              {parts.length === 0 ? (
                <p className="text-gray-600 text-sm text-center py-6">{t('intelligence.noPartsRisk', 'No parts at risk')}</p>
              ) : (
                <div className="space-y-2">
                  {parts.slice(0, 12).map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-2 bg-white/[0.02] rounded-lg px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm text-gray-200 truncate">{p.part_name || p.part_code}</p>
                        <p className="text-[11px] text-gray-600 font-mono">
                          {p.part_code} · {t('intelligence.stock', 'stock')} {p.current_qty}/{p.safety_qty}
                        </p>
                      </div>
                      <RiskBadge level={p.risk_level} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
