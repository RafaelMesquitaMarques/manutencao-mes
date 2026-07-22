import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import {
  PredictiveMachineRow, PredictiveMode,
  fetchPredictiveSettings, updateMachinePredictiveSettings, updatePredictiveSettings,
} from '../../api/predictive';

const MODES: PredictiveMode[] = ['off', 'silent', 'admin', 'active'];

interface Props {
  machines: PredictiveMachineRow[];
  onClose: () => void;
  onSaved: () => void;
}

const Num = ({ label, value, onChange, step = 1, min = 0 }: {
  label: string; value: number; onChange: (v: number) => void; step?: number; min?: number;
}) => (
  <label className="block">
    <span className="text-xs text-gray-500">{label}</span>
    <input
      type="number" value={value} step={step} min={min}
      onChange={(e) => onChange(Number(e.target.value))}
      className="mt-1 w-full rounded-lg bg-white/[0.04] border border-white/[0.08] px-2.5 py-1.5 text-sm text-white"
    />
  </label>
);

const SettingsModal = ({ machines, onClose, onSaved }: Props) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<PredictiveMode>('off');
  const [levels, setLevels] = useState({ watch: 25, alert: 50, critical: 70, deadband: 5 });
  const [persistence, setPersistence] = useState(2);
  const [cooldown, setCooldown] = useState(12);
  const [confidenceFloor, setConfidenceFloor] = useState(0.35);
  const [evalInterval, setEvalInterval] = useState(15);
  // equipment_id → mode override ('' = inherit plant mode)
  const [machineModes, setMachineModes] = useState<Record<string, string>>({});
  const [dirtyMachines, setDirtyMachines] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchPredictiveSettings().then((s) => {
      const p = s.plant as Record<string, unknown>;
      setMode((p.mode as PredictiveMode) ?? 'off');
      const lv = (p.levels ?? {}) as Record<string, number>;
      setLevels({
        watch: lv.watch ?? 25, alert: lv.alert ?? 50,
        critical: lv.critical ?? 70, deadband: lv.deadband ?? 5,
      });
      setPersistence((p.persistence_evals as number) ?? 2);
      setCooldown((p.cooldown_hours as number) ?? 12);
      setConfidenceFloor((p.confidence_floor as number) ?? 0.35);
      setEvalInterval((p.eval_interval_min as number) ?? 15);
      const mm: Record<string, string> = {};
      s.machines.forEach((m) => {
        if (m.enabled === false) mm[m.equipment_id] = 'off';
        else if (m.mode) mm[m.equipment_id] = m.mode;
      });
      setMachineModes(mm);
    }).catch(() => setError(t('predictive.settingsLoadError'))).finally(() => setLoading(false));
  }, [t]);

  const setMachineMode = (id: string, v: string) => {
    setMachineModes((prev) => ({ ...prev, [id]: v }));
    setDirtyMachines((prev) => new Set(prev).add(id));
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await updatePredictiveSettings({
        mode,
        levels,
        persistence_evals: persistence,
        cooldown_hours: cooldown,
        confidence_floor: confidenceFloor,
        eval_interval_min: evalInterval,
      });
      for (const id of dirtyMachines) {
        const v = machineModes[id] ?? '';
        await updateMachinePredictiveSettings(id, {
          enabled: v === 'off' ? false : true,
          mode: v && v !== 'off' ? (v as PredictiveMode) : null,
        });
      }
      onSaved();
      onClose();
    } catch {
      setError(t('predictive.settingsSaveError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-2xl border border-white/[0.08] bg-gray-900 p-5 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold">{t('predictive.settingsTitle')}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={18} /></button>
        </div>

        {loading ? (
          <p className="text-gray-500 text-sm py-8 text-center">{t('common.loading')}</p>
        ) : (
          <>
            <div>
              <span className="text-xs text-gray-500">{t('predictive.plantModeLabel')}</span>
              <div className="flex gap-1.5 mt-1 flex-wrap">
                {MODES.map((m) => (
                  <button key={m} onClick={() => setMode(m)}
                          className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                            mode === m
                              ? 'border-blue-500/40 bg-blue-500/15 text-blue-300'
                              : 'border-white/[0.08] text-gray-500 hover:text-gray-300'
                          }`}>
                    {t(`predictive.mode.${m}`)}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-gray-600 mt-1">{t('predictive.modeHelp')}</p>
            </div>

            <div>
              <span className="text-xs text-gray-500 uppercase tracking-wide">{t('predictive.levelsTitle')}</span>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2">
                <Num label={t('predictive.level.watch')} value={levels.watch} onChange={(v) => setLevels({ ...levels, watch: v })} />
                <Num label={t('predictive.level.alert')} value={levels.alert} onChange={(v) => setLevels({ ...levels, alert: v })} />
                <Num label={t('predictive.level.critical')} value={levels.critical} onChange={(v) => setLevels({ ...levels, critical: v })} />
                <Num label={t('predictive.deadband')} value={levels.deadband} onChange={(v) => setLevels({ ...levels, deadband: v })} />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Num label={t('predictive.persistenceLabel')} value={persistence} onChange={setPersistence} min={1} />
              <Num label={t('predictive.cooldownLabel')} value={cooldown} onChange={setCooldown} step={0.5} />
              <Num label={t('predictive.confidenceFloorLabel')} value={confidenceFloor} onChange={setConfidenceFloor} step={0.05} />
              <Num label={t('predictive.evalIntervalLabel')} value={evalInterval} onChange={setEvalInterval} min={5} />
            </div>

            {machines.length > 0 && (
              <div>
                <span className="text-xs text-gray-500 uppercase tracking-wide">{t('predictive.machineOverridesTitle')}</span>
                <div className="mt-2 space-y-1.5 max-h-56 overflow-y-auto pr-1">
                  {machines.map((m) => (
                    <div key={m.equipment_id} className="flex items-center gap-2">
                      <span className="text-sm text-gray-300 flex-1 truncate">{m.name}</span>
                      <select
                        value={machineModes[m.equipment_id] ?? ''}
                        onChange={(e) => setMachineMode(m.equipment_id, e.target.value)}
                        className="px-2 py-1 rounded-lg bg-gray-900 border border-white/[0.08] text-xs text-gray-300"
                      >
                        <option value="">{t('predictive.inheritPlant')}</option>
                        {MODES.map((mo) => (
                          <option key={mo} value={mo}>{t(`predictive.mode.${mo}`)}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {error && <p className="text-sm text-red-400">{error}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-gray-200">
                {t('common.cancel')}
              </button>
              <button onClick={save} disabled={saving}
                      className="px-4 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50">
                {saving ? t('common.loading') : t('common.save')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default SettingsModal;
