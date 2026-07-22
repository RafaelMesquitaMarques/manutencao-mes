import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import ReactECharts from 'echarts-for-react';
import { Activity, AlertTriangle, Gauge, RefreshCw, ShieldQuestion } from 'lucide-react';
import {
  MachineHealth, PredictiveAlertItem, PredictiveReason,
  evaluateNow, fetchMachineHealth,
} from '../../api/predictive';
import { useAuthStore } from '../../store/authStore';
import { LEVEL_COLORS, LEVEL_HEX, scoreLevelHex } from './predictiveUi';
import FeedbackModal from './FeedbackModal';

const HOURS_OPTIONS = [24, 72, 168, 720];

const PredictiveHealthTab = ({ equipmentId }: { equipmentId: string }) => {
  const { t } = useTranslation();
  const { user } = useAuthStore();
  const [health, setHealth] = useState<MachineHealth | null>(null);
  const [hours, setHours] = useState(168);
  const [loading, setLoading] = useState(true);
  const [evaluating, setEvaluating] = useState(false);
  const [feedbackAlert, setFeedbackAlert] = useState<PredictiveAlertItem | null>(null);

  const load = useCallback((h: number) => {
    fetchMachineHealth(equipmentId, h)
      .then(setHealth)
      .catch(() => setHealth(null))
      .finally(() => setLoading(false));
  }, [equipmentId]);

  useEffect(() => { setLoading(true); load(hours); }, [load, hours]);

  const reasonText = (r: PredictiveReason) =>
    t(`predictive.reasons.${r.code}`, { ...r.params, unit: r.unit ?? '' } as Record<string, unknown>) as string;

  const canEvaluate = ['supervisor', 'maintenance_director', 'plant_manager', 'director', 'admin']
    .includes(user?.role ?? '');

  const runNow = async () => {
    setEvaluating(true);
    try {
      await evaluateNow(equipmentId);
      load(hours);
    } catch { /* mode off or forbidden — keep current view */ } finally {
      setEvaluating(false);
    }
  };

  if (loading) {
    return <div className="text-gray-500 text-sm py-10 text-center">{t('common.loading')}</div>;
  }
  if (!health || !health.visible) {
    return (
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-8 text-center space-y-2">
        <ShieldQuestion className="mx-auto text-gray-600" size={28} />
        <p className="text-gray-400 text-sm">{t('predictive.notVisible')}</p>
        <p className="text-gray-600 text-xs">{t('predictive.modeLabel')}: {t(`predictive.mode.${health?.mode ?? 'off'}`)}</p>
      </div>
    );
  }

  const latest = health.latest;
  if (!latest) {
    return (
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-8 text-center space-y-2">
        <Activity className="mx-auto text-gray-600" size={28} />
        <p className="text-gray-400 text-sm">{t('predictive.noSnapshot')}</p>
        {canEvaluate && (
          <button onClick={runNow} disabled={evaluating}
                  className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50">
            <RefreshCw size={14} className={evaluating ? 'animate-spin' : ''} />
            {t('predictive.evaluateNow')}
          </button>
        )}
      </div>
    );
  }

  const chartOption = {
    grid: { left: 40, right: 16, top: 20, bottom: 28 },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'time',
      axisLabel: { color: '#6b7280', fontSize: 10 },
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
    },
    yAxis: {
      type: 'value', min: 0, max: 100,
      axisLabel: { color: '#6b7280', fontSize: 10 },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
    },
    series: [{
      name: t('predictive.scoreLabel'),
      type: 'line', showSymbol: false, smooth: true,
      data: (health.history ?? []).map((p) => [p.ts, p.score]),
      lineStyle: { width: 2, color: scoreLevelHex(latest.score) },
      areaStyle: { opacity: 0.08, color: scoreLevelHex(latest.score) },
      markLine: {
        silent: true, symbol: 'none',
        label: { color: '#6b7280', fontSize: 9 },
        data: [
          { yAxis: 25, lineStyle: { color: LEVEL_HEX.watch, type: 'dashed', opacity: 0.5 } },
          { yAxis: 50, lineStyle: { color: LEVEL_HEX.alert, type: 'dashed', opacity: 0.5 } },
          { yAxis: 70, lineStyle: { color: LEVEL_HEX.critical, type: 'dashed', opacity: 0.5 } },
        ],
      },
    }],
  };

  const activeFactors = [...latest.factors].sort((a, b) => b.contribution - a.contribution);
  const sensorsWithIssues = Object.entries(latest.data_quality ?? {})
    .filter(([, q]) => q.status !== 'ok');

  return (
    <div className="space-y-4">
      {/* Top row: score card + chart */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-gray-400 text-sm">{t('predictive.healthIndex')}</span>
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${LEVEL_COLORS[latest.level]}`}>
              {t(`predictive.level.${latest.level}`)}
            </span>
          </div>
          <div className="flex items-end gap-2">
            <span className="text-4xl font-bold" style={{ color: scoreLevelHex(latest.score) }}>
              {Math.round(latest.score)}
            </span>
            <span className="text-gray-600 text-sm mb-1.5">/ 100 · {t('predictive.riskLabel')}</span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <span className="text-gray-500">{t('predictive.confidence')}</span>
            <span className="text-gray-300 text-right">{Math.round((latest.confidence ?? 0) * 100)}%</span>
            <span className="text-gray-500">{t('predictive.dataQuality')}</span>
            <span className="text-gray-300 text-right">{Math.round((latest.quality_score ?? 0) * 100)}%</span>
            <span className="text-gray-500">{t('predictive.mtbfConsumed')}</span>
            <span className="text-gray-300 text-right">{latest.mtbf_pct != null ? `${Math.round(latest.mtbf_pct)}%` : '—'}</span>
            <span className="text-gray-500">{t('predictive.maturityLabel')}</span>
            <span className="text-gray-300 text-right">{t(`predictive.maturity.${latest.maturity ?? 'no_data'}`)}</span>
            <span className="text-gray-500">{t('predictive.contextLabel')}</span>
            <span className="text-gray-300 text-right">{t(`predictive.context.${latest.context ?? 'all'}`)}</span>
          </div>
          {canEvaluate && (
            <button onClick={runNow} disabled={evaluating}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-white/[0.08] text-gray-400 hover:text-gray-200 disabled:opacity-50">
              <RefreshCw size={12} className={evaluating ? 'animate-spin' : ''} />
              {t('predictive.evaluateNow')}
            </button>
          )}
        </div>

        <div className="lg:col-span-2 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-gray-400 text-sm">{t('predictive.scoreHistory')}</span>
            <div className="flex gap-1">
              {HOURS_OPTIONS.map((h) => (
                <button key={h} onClick={() => setHours(h)}
                        className={`px-2 py-0.5 rounded text-xs ${hours === h ? 'bg-blue-500/15 text-blue-300' : 'text-gray-500 hover:text-gray-300'}`}>
                  {h <= 72 ? `${h}h` : `${h / 24}d`}
                </button>
              ))}
            </div>
          </div>
          <ReactECharts option={chartOption} style={{ height: 210 }} notMerge />
        </div>
      </div>

      {/* Factors */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <h3 className="text-white text-sm font-semibold mb-3 flex items-center gap-2">
          <Gauge size={15} className="text-blue-400" />
          {t('predictive.factorsTitle')}
        </h3>
        {activeFactors.length === 0 ? (
          <p className="text-gray-500 text-sm">{t('predictive.noFactors')}</p>
        ) : (
          <div className="space-y-2.5">
            {activeFactors.map((f, i) => (
              <div key={`${f.code}-${i}`} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-gray-300 truncate">
                      {f.reason ? reasonText({ code: f.reason, params: f.params, observed: f.observed, expected: f.expected, unit: f.unit }) : t(`predictive.factors.${f.code}`)}
                    </span>
                    <span className="text-xs text-gray-500 whitespace-nowrap">
                      {f.observed != null && f.expected != null
                        ? `${f.observed}${f.unit ? ` ${f.unit}` : ''} ${t('predictive.vs')} ${f.expected}${f.unit ? ` ${f.unit}` : ''}`
                        : f.observed != null ? `${f.observed}${f.unit ? ` ${f.unit}` : ''}` : ''}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-white/[0.05] mt-1">
                    <div className="h-1.5 rounded-full" style={{
                      width: `${Math.min(100, f.value * 100)}%`,
                      background: scoreLevelHex(latest.score),
                    }} />
                  </div>
                </div>
                <span className="text-xs text-gray-500 w-12 text-right">+{f.contribution.toFixed(1)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sensor quality issues */}
      {sensorsWithIssues.length > 0 && (
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4">
          <h3 className="text-amber-400 text-sm font-semibold mb-2 flex items-center gap-2">
            <AlertTriangle size={14} />
            {t('predictive.sensorIssuesTitle')}
          </h3>
          <div className="space-y-1">
            {sensorsWithIssues.map(([code, q]) => (
              <div key={code} className="flex items-center justify-between text-xs">
                <span className="text-gray-400 font-mono">{code}</span>
                <span className="text-gray-500">
                  {t(`predictive.sensorStatus.${q.status}`)} · {q.issues.map((iss) => t(`predictive.sensorIssue.${iss}`)).join(', ')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Alerts on this machine */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-white text-sm font-semibold">{t('predictive.machineAlertsTitle')}</h3>
          <Link to="/predictive" className="text-xs text-blue-400 hover:text-blue-300">
            {t('predictive.openDashboard')}
          </Link>
        </div>
        {(health.alerts ?? []).length === 0 ? (
          <p className="text-gray-500 text-sm">{t('predictive.noAlerts')}</p>
        ) : (
          <div className="space-y-2">
            {(health.alerts ?? []).slice(0, 6).map((a) => (
              <div key={a.id} className="rounded-xl border border-white/[0.06] p-3 space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${LEVEL_COLORS[a.level]}`}>
                    {t(`predictive.level.${a.level}`)}
                  </span>
                  <span className="text-xs text-gray-400">{t(`predictive.kind.${a.kind}`)}</span>
                  <span className="text-xs text-gray-600">{a.created_at ? new Date(a.created_at).toLocaleString() : ''}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-white/[0.05] text-gray-400">
                    {t(`predictive.status.${a.status}`)}
                  </span>
                  {a.silent && <span className="text-xs text-gray-600">({t('predictive.silentTag')})</span>}
                  <span className="ml-auto text-xs text-gray-500">
                    {t('predictive.confidence')} {Math.round((a.confidence ?? 0) * 100)}%
                  </span>
                </div>
                <ul className="text-xs text-gray-400 space-y-0.5 list-disc list-inside">
                  {a.reasons.slice(0, 4).map((r, i) => <li key={i}>{reasonText(r)}</li>)}
                </ul>
                {a.recommendation && (
                  <p className="text-xs text-blue-300/80">
                    {t('predictive.recommendedAction')}: {t(`predictive.recommendation.${a.recommendation}`)}
                  </p>
                )}
                <div className="flex justify-end">
                  <button onClick={() => setFeedbackAlert(a)}
                          className="text-xs text-blue-400 hover:text-blue-300">
                    {t('predictive.giveFeedback')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {feedbackAlert && (
        <FeedbackModal
          alert={feedbackAlert}
          onClose={() => setFeedbackAlert(null)}
          onSubmitted={() => load(hours)}
        />
      )}
    </div>
  );
};

export default PredictiveHealthTab;
