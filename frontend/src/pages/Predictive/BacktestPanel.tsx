import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlaskConical, Play } from 'lucide-react';
import { PredictiveMachineRow, runBacktest } from '../../api/predictive';

type BacktestResult = Awaited<ReturnType<typeof runBacktest>>;

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

const BacktestPanel = ({ machines }: { machines: PredictiveMachineRow[] }) => {
  const { t } = useTranslation();
  const [equipmentId, setEquipmentId] = useState('');
  const [start, setStart] = useState(isoDate(new Date(Date.now() - 14 * 864e5)));
  const [end, setEnd] = useState(isoDate(new Date()));
  const [stepMin, setStepMin] = useState(60);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BacktestResult | null>(null);

  const run = async () => {
    if (!equipmentId) return;
    setRunning(true);
    setError('');
    setResult(null);
    try {
      const r = await runBacktest({
        equipment_id: equipmentId,
        start: `${start}T00:00:00Z`,
        end: `${end}T23:59:59Z`,
        step_min: stepMin,
      });
      setResult(r);
    } catch {
      setError(t('predictive.btError'));
    } finally {
      setRunning(false);
    }
  };

  const m = result?.metrics;

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02]">
      <div className="p-4 border-b border-white/[0.06] flex items-center gap-2">
        <FlaskConical size={15} className="text-purple-400" />
        <h2 className="text-white font-semibold text-sm">{t('predictive.btTitle')}</h2>
        <p className="text-xs text-gray-600 hidden sm:block">{t('predictive.btSubtitle')}</p>
      </div>
      <div className="p-4 space-y-3">
        <div className="flex items-end gap-3 flex-wrap">
          <label className="block">
            <span className="text-xs text-gray-500">{t('predictive.colMachine')}</span>
            <select value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)}
                    className="mt-1 block px-2.5 py-1.5 rounded-lg bg-gray-900 border border-white/[0.08] text-sm text-gray-300 min-w-[200px]">
              <option value="">—</option>
              {machines.map((mm) => (
                <option key={mm.equipment_id} value={mm.equipment_id}>{mm.name}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-gray-500">{t('predictive.btStart')}</span>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)}
                   className="mt-1 block px-2.5 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-white" />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500">{t('predictive.btEnd')}</span>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)}
                   className="mt-1 block px-2.5 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-white" />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500">{t('predictive.btStep')}</span>
            <select value={stepMin} onChange={(e) => setStepMin(Number(e.target.value))}
                    className="mt-1 block px-2.5 py-1.5 rounded-lg bg-gray-900 border border-white/[0.08] text-sm text-gray-300">
              {[15, 30, 60, 120].map((v) => <option key={v} value={v}>{v} min</option>)}
            </select>
          </label>
          <button onClick={run} disabled={!equipmentId || running}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50">
            <Play size={13} />
            {running ? t('common.loading') : t('predictive.btRun')}
          </button>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        {m && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {[
                { label: t('predictive.btEvaluations'), value: m.evaluations },
                { label: t('predictive.btAlerts'), value: m.alerts },
                { label: t('predictive.btFailures'), value: m.failures },
                { label: t('predictive.btDetected'), value: `${m.detected}/${m.failures}`, tone: 'text-emerald-400' },
                { label: t('predictive.btFalsePositives'), value: m.false_positives, tone: 'text-amber-400' },
                { label: t('predictive.btAvgLead'), value: m.avg_lead_hours != null ? `${m.avg_lead_hours} h` : '—', tone: 'text-blue-400' },
              ].map((c) => (
                <div key={c.label} className="rounded-xl border border-white/[0.06] p-3">
                  <p className={`text-xl font-bold ${c.tone ?? 'text-white'}`}>{c.value}</p>
                  <p className="text-[11px] text-gray-500 mt-0.5">{c.label}</p>
                </div>
              ))}
            </div>

            {result && result.failures.length > 0 && (
              <div className="space-y-1">
                {result.failures.map((f, i) => (
                  <div key={i} className="flex items-center gap-3 text-xs rounded-lg border border-white/[0.05] px-3 py-2">
                    <span className={`px-1.5 py-0.5 rounded ${f.detected ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                      {f.detected ? t('predictive.btHit') : t('predictive.btMiss')}
                    </span>
                    <span className="text-gray-400">{new Date(f.started_at).toLocaleString()}</span>
                    {f.lead_hours != null && (
                      <span className="text-gray-500">{t('predictive.btLead', { hours: f.lead_hours })}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {result && result.failures.length === 0 && (
              <p className="text-xs text-gray-500">{t('predictive.btNoFailures')}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default BacktestPanel;
