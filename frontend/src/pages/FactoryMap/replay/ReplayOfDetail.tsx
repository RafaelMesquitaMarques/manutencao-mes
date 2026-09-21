/**
 * Panel for an OF during the replay: where it was at the cursor instant and
 * the whole path it took within the window (runs per machine + entries into
 * and exits from the Pit Stop buffer).
 */
import { useTranslation } from 'react-i18next';
import { ArrowRight, Boxes, ExternalLink, MapPin, X } from 'lucide-react';
import type { OfSnapshot } from './replayModel';
import { formatInTz } from './ReplayBar';

interface Props {
  snapshot: OfSnapshot;
  cursor: number;
  timezone: string;
  /** equipment_id → readable name, to label each run. */
  machineName: (equipmentId: string | null) => string;
  onClose: () => void;
  onSeek: (at: number) => void;
  onFocus: (equipmentId: string) => void;
  onOpenOfPage: () => void;
}

export default function ReplayOfDetail({
  snapshot, cursor, timezone, machineName, onClose, onSeek, onFocus, onOpenOfPage,
}: Props) {
  const { t } = useTranslation();
  const here = snapshot.currentRun ?? snapshot.lastRun;

  return (
    <aside className="w-80 flex-shrink-0 border-l border-gray-800 overflow-y-auto p-4">
      <div className="flex items-start justify-between mb-1">
        <h3 className="text-white font-semibold text-sm flex items-center gap-2">
          <Boxes size={16} className="text-purple-400" />
          <span className="font-mono">{snapshot.jobNumber}</span>
        </h3>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
      </div>
      {snapshot.productName && <p className="text-xs text-gray-500 mb-3">{snapshot.productName}</p>}

      <div className="rounded-lg bg-gray-900 border border-gray-800 px-2.5 py-2 mb-3">
        <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
          {t('replay.ofWhereAt', { time: formatInTz(cursor, timezone) })}
        </p>
        {snapshot.inBuffer ? (
          <p className="text-sm text-indigo-300 flex items-center gap-1.5"><Boxes size={13} /> {t('replay.ofInBuffer')}</p>
        ) : here ? (
          <button onClick={() => here.equipment_id && onFocus(here.equipment_id)}
            className="text-left w-full group">
            <p className="text-sm text-gray-100 group-hover:text-white flex items-center gap-1.5">
              <MapPin size={13} className="text-cyan-400" /> {machineName(here.equipment_id)}
            </p>
            <p className="text-[10px] text-gray-500">
              {snapshot.currentRun ? t('replay.ofRunning') : t('replay.ofParked')}
            </p>
          </button>
        ) : (
          <p className="text-sm text-gray-500">{t('replay.ofNotYetSeen')}</p>
        )}
        <p className="text-[10px] text-gray-500 mt-1">{t('replay.runPieces', { count: snapshot.piecesSoFar })}</p>
      </div>

      <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">{t('replay.ofPath')}</p>
      <div className="space-y-1.5">
        {snapshot.runs.map((r) => {
          const started = Date.parse(r.started_at);
          const ended = r.ended_at ? Date.parse(r.ended_at) : null;
          const done = ended !== null && ended <= cursor;
          const active = started <= cursor && (ended === null || ended > cursor);
          const future = started > cursor;
          return (
            <button key={r.id} onClick={() => onSeek(started)}
              className={`w-full text-left rounded-lg border px-2.5 py-1.5 transition-colors ${
                active ? 'border-emerald-500/50 bg-emerald-500/10'
                  : future ? 'border-gray-800 bg-gray-900/40 opacity-50'
                    : 'border-gray-800 bg-gray-900 hover:border-gray-700'}`}>
              <span className="flex items-center gap-1.5 text-xs text-gray-200">
                <ArrowRight size={11} className="text-gray-600 flex-shrink-0" />
                <span className="truncate">{machineName(r.equipment_id)}</span>
              </span>
              <span className="block text-[10px] text-gray-500 mt-0.5">
                {formatInTz(started, timezone, false)}
                {' → '}
                {ended ? formatInTz(ended, timezone, false) : t('replay.stillOpen')}
                {done || active ? ` · ${t('replay.runPieces', { count: r.pieces })}` : ''}
                {r.operator ? ` · ${r.operator}` : ''}
              </span>
            </button>
          );
        })}
        {snapshot.runs.length === 0 && <p className="text-xs text-gray-600">{t('replay.ofNoRuns')}</p>}
      </div>

      {snapshot.pitEvents.length > 0 && (
        <>
          <p className="text-[11px] uppercase tracking-wide text-gray-500 mt-4 mb-2">{t('replay.ofBufferLedger')}</p>
          <div className="space-y-1">
            {snapshot.pitEvents.map((p, i) => (
              <button key={`${p.ts}-${i}`} onClick={() => onSeek(Date.parse(p.ts))}
                className="w-full flex items-center gap-2 rounded-lg bg-gray-900 border border-gray-800 hover:border-gray-700 px-2.5 py-1.5">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${p.direction === 'out' ? 'bg-orange-400' : 'bg-indigo-400'}`} />
                <span className="text-[11px] text-gray-300 flex-1 text-left truncate">
                  {t(p.direction === 'out' ? 'replay.bufferOut' : 'replay.bufferIn', { count: p.quantity })}
                  {p.components.length > 0 && <span className="text-gray-600"> · {p.components.join(', ')}</span>}
                </span>
                <span className="text-[10px] text-gray-500 flex-shrink-0">{formatInTz(Date.parse(p.ts), timezone, false)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <button onClick={onOpenOfPage}
        className="w-full flex items-center justify-center gap-1.5 mt-4 px-3 py-2 rounded-lg text-sm text-white bg-indigo-600 hover:bg-indigo-500">
        <ExternalLink size={14} /> {t('ofWatch.openOf')}
      </button>
    </aside>
  );
}
