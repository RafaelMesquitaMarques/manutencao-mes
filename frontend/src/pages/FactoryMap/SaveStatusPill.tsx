import { useTranslation } from 'react-i18next';
import { Check, CloudUpload, AlertTriangle, Undo2, Redo2 } from 'lucide-react';
import { useEditorStore } from './editorStore';

/** Toolbar cluster shown in edit mode: undo/redo + a truthful save state.
 * Replaces the old fire-and-forget saves whose errors were silently swallowed. */
export default function SaveStatusPill() {
  const { t } = useTranslation();
  const pending = useEditorStore((s) => s.pending);
  const failed = useEditorStore((s) => s.failed);
  const lastSavedAt = useEditorStore((s) => s.lastSavedAt);
  const history = useEditorStore((s) => s.history);
  const future = useEditorStore((s) => s.future);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const retryFailed = useEditorStore((s) => s.retryFailed);
  const discardFailed = useEditorStore((s) => s.discardFailed);

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex rounded-lg border border-gray-700 overflow-hidden">
        <button onClick={undo} disabled={!history.length}
          title={`${t('factoryMap.undo')} (Ctrl+Z)`}
          className="px-2 py-1.5 text-gray-300 hover:bg-gray-700 disabled:opacity-30 disabled:cursor-default">
          <Undo2 size={14} />
        </button>
        <button onClick={redo} disabled={!future.length}
          title={`${t('factoryMap.redo')} (Ctrl+Shift+Z)`}
          className="px-2 py-1.5 text-gray-300 hover:bg-gray-700 disabled:opacity-30 disabled:cursor-default border-l border-gray-700">
          <Redo2 size={14} />
        </button>
      </span>

      {failed.length > 0 ? (
        <span className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg text-xs bg-red-500/10 border border-red-500/40 text-red-300">
          <AlertTriangle size={13} />
          {t('factoryMap.saveFailed', { count: failed.length })}
          <button onClick={retryFailed} className="px-1.5 py-0.5 rounded bg-red-500/20 hover:bg-red-500/30 font-semibold">
            {t('factoryMap.retry')}
          </button>
          <button onClick={discardFailed} title={t('factoryMap.discardFailed')}
            className="px-1 py-0.5 rounded hover:bg-red-500/20">✕</button>
        </span>
      ) : pending > 0 ? (
        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs bg-gray-800 border border-gray-700 text-amber-300">
          <CloudUpload size={13} className="animate-pulse" /> {t('factoryMap.saving')}
        </span>
      ) : lastSavedAt ? (
        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs bg-gray-800 border border-gray-700 text-emerald-400">
          <Check size={13} /> {t('factoryMap.saved')}
        </span>
      ) : null}
    </span>
  );
}
