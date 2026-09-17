/**
 * Painel de detalhe de UMA máquina durante o replay: o que estava a acontecer
 * no instante do cursor e a faixa de estados de toda a janela.
 *
 * Tudo aqui é reconstruído; cada bloco diz de onde vem (parada justificada,
 * intervenção, ticket ou ausência de evento registado) em vez de apresentar
 * números sem proveniência.
 */
import { useTranslation } from 'react-i18next';
import { Boxes, Clock, ExternalLink, Wrench } from 'lucide-react';
import { STATUS_HEX, STATUS_LABEL } from '../../../utils/statusColors';
import type { ReplaySegment } from '../../../api/factoryReplay';
import type { MachineSnapshot } from './replayModel';
import { formatInTz } from './ReplayBar';

const fmtAge = (m: number | null): string =>
  m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`;

interface Props {
  snapshot: MachineSnapshot;
  segments: ReplaySegment[];
  cursor: number;
  windowStart: number;
  windowEnd: number;
  timezone: string;
  lang: string;
  onOpenOf: (jobOrderId: string) => void;
  onSeek: (at: number) => void;
}

export default function ReplayMachineDetail({
  snapshot, segments, cursor, windowStart, windowEnd, timezone, lang, onOpenOf, onSeek,
}: Props) {
  const { t } = useTranslation();
  const span = windowEnd - windowStart;
  const seg = snapshot.segment;
  const statusLabel = STATUS_LABEL[snapshot.status]?.[lang as 'en' | 'fr' | 'es'] ?? snapshot.status;
  const run = snapshot.currentRun;

  return (
    <div className="mt-4 pt-3 border-t border-amber-500/20">
      <p className="text-[11px] uppercase tracking-wide text-amber-400/80 mb-2 flex items-center gap-1.5">
        <Clock size={12} /> {t('replay.atTime', { time: formatInTz(cursor, timezone) })}
      </p>

      {/* Faixa de estados da janela inteira — clicável para saltar no tempo */}
      {span > 0 && segments.length > 0 && (
        <>
          <div className="flex h-3 w-full rounded overflow-hidden border border-gray-800 mb-1">
            {segments.map((s, i) => {
              const a = Date.parse(s.start), b = Date.parse(s.end);
              const w = ((Math.min(b, windowEnd) - Math.max(a, windowStart)) / span) * 100;
              if (!(w > 0)) return null;
              const label = STATUS_LABEL[s.status]?.[lang as 'en' | 'fr' | 'es'] ?? s.status;
              return (
                <button
                  key={`${s.start}-${i}`}
                  onClick={() => onSeek(Math.max(a, windowStart))}
                  title={`${formatInTz(a, timezone, false)}–${formatInTz(b, timezone, false)} · ${label}${s.reason ? ` · ${s.reason}` : ''}`}
                  style={{ width: `${w}%`, background: STATUS_HEX[s.status] ?? STATUS_HEX.idle }}
                  className="h-full hover:opacity-80"
                />
              );
            })}
          </div>
          <div className="relative h-2 mb-3">
            <span className="absolute top-0 w-[2px] h-2 bg-amber-300"
              style={{ left: `calc(${((cursor - windowStart) / span) * 100}% - 1px)` }} />
          </div>
        </>
      )}

      {/* Estado no instante + proveniência */}
      <div className="rounded-lg bg-gray-900 border border-gray-800 px-2.5 py-2 space-y-1">
        <div className="flex items-center gap-2">
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: STATUS_HEX[snapshot.status] ?? STATUS_HEX.idle }} />
          <span className="text-sm text-gray-100">{statusLabel}</span>
          {seg && (
            <span className="ml-auto text-[10px] text-gray-500">
              {formatInTz(Date.parse(seg.start), timezone, false)}–{formatInTz(Date.parse(seg.end), timezone, false)}
            </span>
          )}
        </div>
        {seg?.reason && <p className="text-xs text-gray-300">{seg.reason}</p>}
        {seg?.detail?.comments && <p className="text-[11px] text-gray-500 italic">{seg.detail.comments}</p>}
        {snapshot.inheritedFrom && (
          <p className="text-[10px] text-gray-500">{t('replay.inheritedFromParent')}</p>
        )}
        <p className="text-[10px] text-gray-500">
          {t(`replay.source.${seg?.source ?? 'baseline'}`)}
        </p>
      </div>

      {snapshot.technicians.length > 0 && (
        <div className="mt-2 rounded-lg bg-purple-500/10 border border-purple-500/30 px-2.5 py-2">
          <p className="text-[10px] uppercase tracking-wide text-purple-300 mb-1">{t('replay.techniciansOnSite')}</p>
          {snapshot.technicians.map((tech, i) => (
            <p key={`${tech.name}-${i}`} className="text-xs text-purple-100">
              {tech.name}
              {tech.since && <span className="text-purple-300/60"> · {t('replay.since', { time: formatInTz(Date.parse(tech.since), timezone, false) })}</span>}
            </p>
          ))}
        </div>
      )}

      {snapshot.ticket && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-2.5 py-2 text-xs text-amber-200">
          <Wrench size={13} className="flex-shrink-0" />
          <span>{t('replay.ticketOpenAt', { number: snapshot.ticket.ticket_number ?? '—' })}</span>
        </div>
      )}

      {/* OF carregada + produção */}
      <p className="text-[11px] uppercase tracking-wide text-gray-500 mt-4 mb-2">{t('replay.ofAtMachine')}</p>
      {run ? (
        <button onClick={() => onOpenOf(run.job_order_id)}
          className="w-full text-left rounded-lg bg-gray-900 border border-gray-800 hover:border-purple-500/50 px-2.5 py-2">
          <span className="flex items-center gap-2">
            <span className="font-mono text-xs text-purple-300 flex-1 truncate">{run.job_number}</span>
            <ExternalLink size={12} className="text-gray-600" />
          </span>
          {run.product_name && <span className="block text-[10px] text-gray-500 truncate">{run.product_name}</span>}
          <span className="block text-[10px] text-gray-500">
            {t('replay.runSince', { time: formatInTz(Date.parse(run.started_at), timezone, false) })}
            {' · '}{t('replay.runPieces', { count: run.pieces })}
          </span>
        </button>
      ) : (
        <p className="text-xs text-gray-600">{t('replay.noOfLoaded')}</p>
      )}

      {snapshot.parked.length > 0 && (
        <>
          <p className="text-[11px] uppercase tracking-wide text-gray-500 mt-3 mb-1.5 flex items-center gap-1.5">
            <Boxes size={12} /> {t('replay.parkedOfs', { count: snapshot.parked.length })}
          </p>
          <div className="space-y-1">
            {snapshot.parked.slice(0, 8).map((p) => (
              <button key={p.job_order_id} onClick={() => onOpenOf(p.job_order_id)}
                className="w-full flex items-center gap-2 rounded-lg bg-gray-900 border border-gray-800 hover:border-purple-500/50 px-2.5 py-1.5">
                <span className="font-mono text-xs text-purple-300 flex-1 min-w-0 truncate text-left">{p.job_number}</span>
                <span className="text-[10px] text-gray-500 flex-shrink-0">{fmtAge(p.age_minutes)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <p className="text-[11px] uppercase tracking-wide text-gray-500 mt-4 mb-2">{t('replay.windowProduction')}</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-gray-900 border border-gray-800 px-2.5 py-2">
          <p className="text-[10px] text-gray-500">{t('replay.piecesSoFar')}</p>
          <p className="text-sm font-semibold text-gray-200">{snapshot.piecesSoFar}</p>
        </div>
        <div className="rounded-lg bg-gray-900 border border-gray-800 px-2.5 py-2">
          <p className="text-[10px] text-gray-500">{t('replay.rejectsSoFar')}</p>
          <p className="text-sm font-semibold text-gray-200">{snapshot.rejectsSoFar}</p>
        </div>
      </div>
      {snapshot.hourly.length > 0 ? (
        <>
          <div className="flex items-end gap-0.5 h-12 mt-2">
            {(() => {
              const max = Math.max(...snapshot.hourly.map((h) => h.count), 1);
              return snapshot.hourly.map((h) => {
                const at = Date.parse(h.hour);
                const past = at + 3_600_000 <= cursor;
                return (
                  <button key={h.hour} onClick={() => onSeek(Math.max(at, windowStart))}
                    title={`${formatInTz(at, timezone, false)} · ${h.count}`}
                    className="flex-1 min-w-[3px] rounded-sm hover:opacity-80"
                    style={{
                      height: `${Math.max(4, (h.count / max) * 100)}%`,
                      background: past ? '#22c55e' : '#334155',
                    }} />
                );
              });
            })()}
          </div>
          <p className="text-[10px] text-gray-600 mt-1">{t('replay.hourlyHint')}</p>
        </>
      ) : (
        <p className="text-[11px] text-gray-600 mt-2">{t('replay.noProductionFeed')}</p>
      )}
    </div>
  );
}
