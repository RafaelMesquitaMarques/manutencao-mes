import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { FeedbackInput, PredictiveAlertItem, submitAlertFeedback } from '../../api/predictive';

interface Props {
  alert: PredictiveAlertItem;
  onClose: () => void;
  onSubmitted: () => void;
}

const TriState = ({ label, value, onChange }: {
  label: string;
  value: boolean | null | undefined;
  onChange: (v: boolean | null) => void;
}) => {
  const { t } = useTranslation();
  const opts: { v: boolean | null; label: string }[] = [
    { v: true, label: t('common.yes') },
    { v: false, label: t('common.no') },
    { v: null, label: t('predictive.fbUnknown') },
  ];
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-gray-400">{label}</span>
      <div className="flex gap-1">
        {opts.map((o) => (
          <button
            key={String(o.v)}
            type="button"
            onClick={() => onChange(o.v)}
            className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
              value === o.v
                ? 'border-blue-500/40 bg-blue-500/15 text-blue-300'
                : 'border-white/[0.08] text-gray-500 hover:text-gray-300'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
};

const FeedbackModal = ({ alert, onClose, onSubmitted }: Props) => {
  const { t } = useTranslation();
  const [fb, setFb] = useState<FeedbackInput>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = <K extends keyof FeedbackInput>(k: K, v: FeedbackInput[K]) =>
    setFb((prev) => ({ ...prev, [k]: v }));

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      await submitAlertFeedback(alert.id, fb);
      onSubmitted();
      onClose();
    } catch {
      setError(t('predictive.fbError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-white/[0.08] bg-gray-900 p-5 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold">{t('predictive.fbTitle')}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={18} /></button>
        </div>
        <p className="text-xs text-gray-500">{t('predictive.fbSubtitle')}</p>

        <div className="space-y-3">
          <TriState label={t('predictive.fbWasCorrect')} value={fb.was_correct} onChange={(v) => set('was_correct', v)} />
          <TriState label={t('predictive.fbProblemFound')} value={fb.problem_found} onChange={(v) => set('problem_found', v)} />
          <TriState label={t('predictive.fbPreventedBreakdown')} value={fb.prevented_breakdown} onChange={(v) => set('prevented_breakdown', v)} />
          <TriState label={t('predictive.fbPartReplaced')} value={fb.part_replaced} onChange={(v) => set('part_replaced', v)} />
          <TriState label={t('predictive.fbBackToNormal')} value={fb.back_to_normal} onChange={(v) => set('back_to_normal', v)} />

          <div>
            <label className="text-sm text-gray-400 block mb-1">{t('predictive.fbTiming')}</label>
            <div className="flex gap-1">
              {(['early', 'on_time', 'late'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => set('timing', fb.timing === v ? null : v)}
                  className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                    fb.timing === v
                      ? 'border-blue-500/40 bg-blue-500/15 text-blue-300'
                      : 'border-white/[0.08] text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {t(`predictive.fbTiming_${v}`)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-sm text-gray-400 block mb-1">{t('predictive.fbComponent')}</label>
            <input
              value={fb.component ?? ''}
              onChange={(e) => set('component', e.target.value || null)}
              className="w-full rounded-lg bg-white/[0.04] border border-white/[0.08] px-3 py-2 text-sm text-white"
              placeholder={t('predictive.fbComponentPh')}
            />
          </div>
          <div>
            <label className="text-sm text-gray-400 block mb-1">{t('predictive.fbCause')}</label>
            <input
              value={fb.cause ?? ''}
              onChange={(e) => set('cause', e.target.value || null)}
              className="w-full rounded-lg bg-white/[0.04] border border-white/[0.08] px-3 py-2 text-sm text-white"
              placeholder={t('predictive.fbCausePh')}
            />
          </div>
          <div>
            <label className="text-sm text-gray-400 block mb-1">{t('predictive.fbActionTaken')}</label>
            <input
              value={fb.action_taken ?? ''}
              onChange={(e) => set('action_taken', e.target.value || null)}
              className="w-full rounded-lg bg-white/[0.04] border border-white/[0.08] px-3 py-2 text-sm text-white"
            />
          </div>
          <div>
            <label className="text-sm text-gray-400 block mb-1">{t('predictive.fbComments')}</label>
            <textarea
              value={fb.comments ?? ''}
              onChange={(e) => set('comments', e.target.value || null)}
              rows={2}
              className="w-full rounded-lg bg-white/[0.04] border border-white/[0.08] px-3 py-2 text-sm text-white"
            />
          </div>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-gray-200">
            {t('common.cancel')}
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="px-4 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
          >
            {saving ? t('common.loading') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default FeedbackModal;
