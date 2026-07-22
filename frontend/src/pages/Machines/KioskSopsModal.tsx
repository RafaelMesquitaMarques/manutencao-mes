import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, X, Loader2, ListChecks, Clock, ChevronRight } from 'lucide-react';
import {
  fetchKioskSops, startKioskSopExecution, setKioskSopExecutionStep,
  completeKioskSopExecution, abandonKioskSopExecution,
  type Sop, type SopCategory,
} from '../../api/sops';
import SopPlayer from '../../components/sops/SopPlayer';

const CATEGORY_CHIP: Record<string, string> = {
  operation:   'text-sky-300 border-sky-500/40 bg-sky-500/10',
  maintenance: 'text-amber-300 border-amber-500/40 bg-amber-500/10',
  safety:      'text-red-300 border-red-500/40 bg-red-500/10',
  quality:     'text-violet-300 border-violet-500/40 bg-violet-500/10',
  setup:       'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
};

interface Props {
  machineRef: string;
  lng: string;                       // kiosk language (machine page language)
  operatorName?: string | null;      // recorded on kiosk executions
  onClose: () => void;
}

/** Full-screen SOP browser for the machine kiosk: operators open operation
 * procedures, technicians open maintenance ones — then follow step by step. */
export default function KioskSopsModal({ machineRef, lng, operatorName, onClose }: Props) {
  const { t: rawT } = useTranslation();
  const t = useMemo(
    () => (key: string, opts?: Record<string, unknown>) => rawT(key, { ...(opts ?? {}), lng }) as string,
    [rawT, lng],
  );

  const [sops, setSops] = useState<Sop[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState<SopCategory | ''>('');
  const [active, setActive] = useState<Sop | null>(null);

  useEffect(() => {
    fetchKioskSops(machineRef)
      .then(setSops)
      .catch(() => setSops([]))
      .finally(() => setLoading(false));
  }, [machineRef]);

  const categories = useMemo(
    () => Array.from(new Set(sops.map((s) => s.category))),
    [sops],
  );
  const visible = category ? sops.filter((s) => s.category === category) : sops;

  if (active) {
    return (
      <SopPlayer
        sop={active}
        lng={lng}
        autoStart
        onClose={() => setActive(null)}
        execApi={{
          start: () => startKioskSopExecution(machineRef, active.id, operatorName ?? undefined),
          setStep: (execId, stepId, checked) => setKioskSopExecutionStep(machineRef, execId, stepId, checked),
          complete: (execId, notes) => completeKioskSopExecution(machineRef, execId, notes),
          abandon: (execId) => abandonKioskSopExecution(machineRef, execId),
        }}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-[110] bg-black/70 flex items-center justify-center sm:p-4" onClick={onClose}>
      <div
        className="w-full h-full sm:h-[92vh] sm:max-w-3xl bg-[#0d1421] sm:rounded-2xl border border-white/[0.08] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-white/[0.08]">
          <p className="text-white text-xl font-black flex items-center gap-2.5">
            <BookOpen size={22} className="text-indigo-400" /> {t('sops.kiosk.title')}
          </p>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className="p-2.5 rounded-xl border border-white/10 text-gray-400 hover:text-white hover:bg-white/[0.06]"
          >
            <X size={22} />
          </button>
        </div>

        {/* Category tabs */}
        {categories.length > 1 && (
          <div className="flex items-center gap-2 px-5 py-3 overflow-x-auto shrink-0">
            <button
              onClick={() => setCategory('')}
              className={`text-sm px-4 py-2 rounded-full border font-bold whitespace-nowrap transition-colors ${
                category === '' ? 'text-white border-indigo-400 bg-indigo-500/20' : 'text-gray-500 border-white/10'
              }`}
            >
              {t('sops.kiosk.all')}
            </button>
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(category === c ? '' : c)}
                className={`text-sm px-4 py-2 rounded-full border font-bold whitespace-nowrap transition-colors ${
                  category === c ? CATEGORY_CHIP[c] : 'text-gray-500 border-white/10'
                }`}
              >
                {t(`sops.categories.${c}`)}
              </button>
            ))}
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto px-5 pb-5 pt-2 space-y-3">
          {loading ? (
            <div className="flex justify-center py-14"><Loader2 size={26} className="animate-spin text-indigo-400" /></div>
          ) : visible.length === 0 ? (
            <div className="text-center py-14 space-y-3">
              <BookOpen size={44} className="text-gray-700 mx-auto" />
              <p className="text-gray-500 text-lg">{t('sops.kiosk.empty')}</p>
            </div>
          ) : (
            visible.map((sop) => (
              <button
                key={sop.id}
                onClick={() => setActive(sop)}
                className="w-full text-left bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.08] hover:border-indigo-500/40 rounded-2xl px-5 py-4 transition-colors flex items-center gap-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[11px] px-2 py-0.5 rounded-full border font-bold uppercase tracking-wide ${CATEGORY_CHIP[sop.category]}`}>
                      {t(`sops.categories.${sop.category}`)}
                    </span>
                    <span className="font-mono text-[11px] text-gray-600">{sop.sop_number} · v{sop.version}</span>
                  </div>
                  <p className="text-white font-bold text-lg leading-snug mt-1">{sop.title}</p>
                  <div className="flex items-center gap-4 mt-1.5 text-sm text-gray-500">
                    <span className="flex items-center gap-1.5"><ListChecks size={15} /> {t('sops.stepCount', { count: sop.steps.length })}</span>
                    {sop.estimated_minutes != null && (
                      <span className="flex items-center gap-1.5"><Clock size={15} /> {Math.round(sop.estimated_minutes)} min</span>
                    )}
                  </div>
                </div>
                <ChevronRight size={24} className="text-gray-600 shrink-0" />
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
