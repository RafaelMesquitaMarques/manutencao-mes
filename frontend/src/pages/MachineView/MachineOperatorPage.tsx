import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, Clock, Wrench, CheckCircle, Loader2, Mic, MicOff } from 'lucide-react';
import {
  fetchMachineOperatorState,
  fetchInterventionTypes,
  callMaintenance,
  startIntervention,
  completeIntervention,
} from '../../api/machineOperator';
import type { MachineOperatorState, InterventionType } from '../../types';

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function pad(n: number) { return String(n).padStart(2, '0'); }
function formatClock(d: Date) { return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function formatDate(d: Date) {
  return d.toLocaleDateString('fr-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
function elapsed(from: string) {
  const diff = Math.floor((Date.now() - new Date(from).getTime()) / 1000);
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

export default function MachineOperatorPage() {
  const { machine_id } = useParams<{ machine_id: string }>();
  const [state, setState] = useState<MachineOperatorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Intervention type selection (STATE 3 complete flow)
  const [interventionTypes, setInterventionTypes] = useState<InterventionType[]>([]);
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null);
  const [selectedTypeName, setSelectedTypeName] = useState('');
  const [selectedTypeIcon, setSelectedTypeIcon] = useState('');
  const [completePhase, setCompletePhase] = useState<'type' | 'note'>('type');
  const [mechNote, setMechNote] = useState('');

  // Voice transcription
  const [isRecording, setIsRecording] = useState(false);
  const recognitionRef = useRef<unknown>(null);

  const now = useClock();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async () => {
    if (!machine_id) return;
    try {
      const data = await fetchMachineOperatorState(machine_id);
      setState(data);
      setError(null);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      const msg = e?.response?.data?.detail || e?.message || 'Connexion impossible';
      console.error('[MachineOperatorPage] fetch error:', err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    pollRef.current = setInterval(load, 30_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [machine_id]);

  // Fetch intervention types once on mount
  useEffect(() => {
    if (!machine_id) return;
    fetchInterventionTypes(machine_id)
      .then((d) => setInterventionTypes(d.items || []))
      .catch(() => setInterventionTypes([]));
  }, [machine_id]);

  const act = async (fn: () => Promise<unknown>) => {
    setActing(true);
    try {
      await fn();
      await load();
      setNote('');
      setMechNote('');
      setSelectedTypeId(null);
      setSelectedTypeName('');
      setSelectedTypeIcon('');
      setCompletePhase('type');
    } catch {
      setError('Action échouée');
    } finally {
      setActing(false);
    }
  };

  // Voice transcription
  const toggleRecording = () => {
    if (isRecording) {
      (recognitionRef.current as { stop: () => void } | null)?.stop();
      setIsRecording(false);
      return;
    }
    const SpeechRecognition =
      (window as Record<string, unknown>).SpeechRecognition as (new () => {
        lang: string; continuous: boolean; interimResults: boolean;
        onresult: (e: { results: { [k: number]: { [k: number]: { transcript: string } } } }) => void;
        onend: () => void; start: () => void; stop: () => void;
      }) | undefined ||
      (window as Record<string, unknown>).webkitSpeechRecognition as typeof SpeechRecognition;

    if (!SpeechRecognition) {
      alert('Reconnaissance vocale non supportée. Utilisez Chrome.');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'fr-CA';
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = Array.from(
        { length: event.results.length },
        (_, i) => event.results[i][0].transcript
      ).join(' ');
      setMechNote((prev) => prev + (prev ? ' ' : '') + transcript);
    };
    recognition.onend = () => setIsRecording(false);
    recognition.start();
    recognitionRef.current = recognition;
    setIsRecording(true);
  };

  const intervention = state?.active_intervention ?? null;
  const isIdle       = !intervention;
  const isWaiting    = intervention?.status === 'waiting';
  const isInProgress = intervention?.status === 'in_progress';

  const statusLabel = isIdle ? 'En production' : isWaiting ? 'En attente de mécanicien' : 'Intervention en cours';
  const statusColor  = isIdle ? 'text-green-400' : isWaiting ? 'text-amber-400' : 'text-blue-400';
  const statusBorder = isIdle ? 'border-green-700/40' : isWaiting ? 'border-amber-700/40' : 'border-blue-700/40';

  if (loading) return (
    <div className="h-screen flex items-center justify-center bg-[#0d1117]">
      <Loader2 className="animate-spin text-gray-500" size={48} />
    </div>
  );

  if (!state) return (
    <div style={{ background: '#0d1117', height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
      <span style={{ color: '#f85149', fontSize: '16px' }}>⚠ {error ?? 'Machine introuvable'}</span>
      <span style={{ color: '#6e7681', fontSize: '12px', fontFamily: 'monospace' }}>{machine_id}</span>
      <button onClick={() => window.location.reload()}
        style={{ marginTop: '8px', padding: '8px 16px', background: '#21262d', color: '#e6edf3', border: '0.5px solid #30363d', borderRadius: '6px', cursor: 'pointer' }}>
        Retry
      </button>
    </div>
  );

  return (
    <div className="h-screen flex flex-col bg-[#0d1117] text-white overflow-hidden select-none">

      {/* TOP BAR */}
      <header className="flex items-center justify-between px-8"
        style={{ height: '13%', background: '#111318', borderBottom: '1px solid #21262d' }}>
        <div>
          <p className="text-3xl font-bold leading-none">{state.machine.name}</p>
          <p className="text-gray-500 text-sm font-mono mt-1">{state.machine.code}</p>
        </div>
        <div className={`text-center px-6 py-2 rounded-xl border ${statusBorder}`}>
          <p className={`text-xl font-semibold ${statusColor}`}>{statusLabel}</p>
          {intervention && (
            <p className="text-xs text-gray-500 mt-0.5">depuis {elapsed(intervention.called_at)}</p>
          )}
        </div>
        <div className="text-right">
          <p className="text-gray-400 text-sm">{formatDate(now)}</p>
          {state.machine.location && <p className="text-gray-600 text-xs mt-0.5">{state.machine.location}</p>}
        </div>
      </header>

      {/* BODY */}
      <main className="flex-1 flex items-center justify-center px-8 gap-8" style={{ height: '78%' }}>

        {/* Left info panel */}
        <div className="flex flex-col gap-4 h-full py-6" style={{ width: '240px', flexShrink: 0 }}>
          <InfoCard label="Équipement" value={state.equipment?.name ?? state.machine.name} />
          <InfoCard label="Département" value={state.machine.department || '—'} />
          <InfoCard
            label="Dernière maintenance"
            value={state.last_maintenance_days_ago !== null ? `il y a ${state.last_maintenance_days_ago} j` : '—'}
          />
          <InfoCard label="Tickets ouverts" value={String(state.open_tickets_count)} alert={state.open_tickets_count > 0} />
        </div>

        <div className="h-3/4 w-px" style={{ background: '#21262d' }} />

        {/* Action zone */}
        <div className="flex-1 flex flex-col items-center justify-center gap-6 max-w-xl">
          {error && <p className="text-red-400 text-sm bg-red-500/10 px-4 py-2 rounded-lg">{error}</p>}

          {/* STATE 1 — idle */}
          {isIdle && (
            <>
              <div className="text-center mb-2">
                <AlertTriangle className="mx-auto text-gray-600 mb-3" size={48} />
                <p className="text-gray-400 text-lg">Appuyez pour appeler la maintenance</p>
              </div>
              <textarea
                value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="Description du problème (optionnel)"
                className="w-full h-24 bg-[#111318] border border-[#21262d] rounded-xl px-4 py-3 text-sm text-gray-300 placeholder-gray-600 resize-none focus:outline-none focus:border-red-700/60"
              />
              <button disabled={acting}
                onClick={() => act(() => callMaintenance(machine_id!, note || undefined))}
                className="w-full py-6 rounded-2xl text-2xl font-bold tracking-wide transition-all active:scale-95 disabled:opacity-50"
                style={{ background: '#8b1a1a', border: '2px solid #e74c3c', color: '#fff' }}>
                {acting ? <Loader2 className="animate-spin mx-auto" size={28} /> : '🔧 Appeler la maintenance'}
              </button>
            </>
          )}

          {/* STATE 2 — waiting */}
          {isWaiting && (
            <>
              <div className="w-full rounded-2xl px-6 py-5 text-center"
                style={{ background: '#1a1200', border: '1px solid #78350f' }}>
                <Clock className="mx-auto text-amber-400 mb-2" size={36} />
                <p className="text-amber-300 text-xl font-semibold">En attente de mécanicien</p>
                <p className="text-amber-600 text-sm mt-1">Appelé il y a {elapsed(intervention!.called_at)}</p>
                {intervention!.operator_note && (
                  <p className="text-gray-400 text-sm mt-3 italic">"{intervention!.operator_note}"</p>
                )}
              </div>
              <textarea value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="Note mécanicien (optionnel)"
                className="w-full h-20 bg-[#111318] border border-[#21262d] rounded-xl px-4 py-3 text-sm text-gray-300 placeholder-gray-600 resize-none focus:outline-none focus:border-blue-700/60"
              />
              <button disabled={acting}
                onClick={() => act(() => startIntervention(machine_id!, note || undefined))}
                className="w-full py-5 rounded-2xl text-xl font-bold transition-all active:scale-95 disabled:opacity-50 bg-green-800 hover:bg-green-700"
                style={{ border: '2px solid #22c55e' }}>
                {acting ? <Loader2 className="animate-spin mx-auto" size={24} /> : '▶ Démarrer l\'intervention'}
              </button>
            </>
          )}

          {/* STATE 3 — in_progress */}
          {isInProgress && (
            <>
              {/* Status card */}
              <div className="w-full rounded-2xl px-6 py-4 text-center"
                style={{ background: '#0a1628', border: '1px solid #1d4ed8' }}>
                <Wrench className="mx-auto text-blue-400 mb-1" size={28} />
                <p className="text-blue-300 text-lg font-semibold">Intervention en cours</p>
                <p className="text-blue-600 text-sm">Démarrée il y a {elapsed(intervention!.started_at!)}</p>
                {intervention!.operator_note && (
                  <p className="text-gray-400 text-xs mt-2 italic">"{intervention!.operator_note}"</p>
                )}
              </div>

              {/* Phase A — type selector */}
              {completePhase === 'type' && interventionTypes.length > 0 && (
                <div className="w-full">
                  <p className="text-center text-gray-400 text-sm mb-4 font-medium tracking-wide uppercase">
                    Type d'intervention
                  </p>
                  <div className="grid grid-cols-3 gap-3">
                    {interventionTypes.map((t) => (
                      <button key={t.id}
                        onClick={() => {
                          setSelectedTypeId(t.id);
                          setSelectedTypeName(t.name);
                          setSelectedTypeIcon(t.icon);
                          setCompletePhase('note');
                        }}
                        className="flex flex-col items-center gap-2 p-3 rounded-2xl transition-all active:scale-95"
                        style={{
                          background: '#111318',
                          border: `1.5px solid ${t.color}40`,
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLButtonElement).style.background = `${t.color}15`;
                          (e.currentTarget as HTMLButtonElement).style.border = `1.5px solid ${t.color}`;
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLButtonElement).style.background = '#111318';
                          (e.currentTarget as HTMLButtonElement).style.border = `1.5px solid ${t.color}40`;
                        }}>
                        <div className="w-16 h-16 rounded-full flex items-center justify-center text-2xl"
                          style={{ background: `${t.color}18`, border: `1.5px solid ${t.color}50` }}>
                          {t.icon}
                        </div>
                        <span className="text-xs text-gray-300 text-center leading-tight">{t.name}</span>
                      </button>
                    ))}
                  </div>
                  {/* Skip option if type not mandatory */}
                  <button onClick={() => setCompletePhase('note')}
                    className="mt-3 w-full text-xs text-gray-600 hover:text-gray-400 transition-colors">
                    Passer sans type →
                  </button>
                </div>
              )}

              {/* Phase B — closing note + confirm (also shown if no types) */}
              {(completePhase === 'note' || interventionTypes.length === 0) && (
                <div className="w-full flex flex-col gap-4">
                  {/* Selected type badge */}
                  {selectedTypeName && (
                    <div className="flex items-center gap-2">
                      <button onClick={() => { setSelectedTypeId(null); setCompletePhase('type'); }}
                        className="text-xs text-gray-600 hover:text-gray-400 transition-colors">← Changer</button>
                      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium"
                        style={{ background: '#1e3a5f', border: '1px solid #3b82f6', color: '#93c5fd' }}>
                        <span>{selectedTypeIcon}</span>
                        <span>{selectedTypeName}</span>
                      </div>
                    </div>
                  )}

                  {/* Note field + microphone */}
                  <div className="flex gap-2 items-start">
                    <textarea value={mechNote} onChange={(e) => setMechNote(e.target.value)}
                      placeholder="Note de clôture (optionnel) — ou utilisez le micro 🎤"
                      className="flex-1 h-20 bg-[#111318] border border-[#21262d] rounded-xl px-4 py-3 text-sm text-gray-300 placeholder-gray-600 resize-none focus:outline-none focus:border-blue-700/60"
                    />
                    <button onClick={toggleRecording} title={isRecording ? 'Arrêter' : 'Dicter'}
                      className={`p-3 rounded-full border-2 transition-all self-center flex-shrink-0 ${
                        isRecording
                          ? 'bg-red-700 border-red-400 animate-pulse'
                          : 'bg-[#111318] border-[#21262d] hover:border-blue-500'
                      }`}>
                      {isRecording ? <MicOff size={20} className="text-red-200" /> : <Mic size={20} className="text-gray-400" />}
                    </button>
                  </div>

                  <button disabled={acting}
                    onClick={() => act(() => completeIntervention(machine_id!, {
                      mechanic_note: mechNote || undefined,
                      intervention_type_id: selectedTypeId || undefined,
                    }))}
                    className="w-full py-5 rounded-2xl text-xl font-bold transition-all active:scale-95 disabled:opacity-50"
                    style={{ background: '#1e3a5f', border: '2px solid #3b82f6' }}>
                    {acting
                      ? <Loader2 className="animate-spin mx-auto" size={24} />
                      : <><CheckCircle className="inline mr-2" size={22} />Confirmer la clôture</>}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <div className="h-3/4 w-px" style={{ background: '#21262d' }} />

        {/* Last intervention panel */}
        <div style={{ width: '220px', flexShrink: 0 }} className="flex flex-col gap-3 py-6">
          <p className="text-xs text-gray-600 uppercase tracking-widest font-semibold">Dernière intervention</p>
          {state.last_intervention ? (
            <>
              <InfoCard label="Statut" value="Terminée" />
              {state.last_intervention.intervention_type_name && (
                <InfoCard label="Type" value={state.last_intervention.intervention_type_name} />
              )}
              {state.last_intervention.completed_at && (
                <InfoCard label="Terminée" value={new Date(state.last_intervention.completed_at).toLocaleString('fr-CA', {
                  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                })} />
              )}
              {state.last_intervention.mechanic_note && (
                <div className="rounded-lg p-3" style={{ background: '#111318', border: '1px solid #21262d' }}>
                  <p className="text-xs text-gray-500 mb-1">Note</p>
                  <p className="text-gray-300 text-xs italic">"{state.last_intervention.mechanic_note}"</p>
                </div>
              )}
            </>
          ) : (
            <p className="text-gray-600 text-sm">Aucune</p>
          )}
        </div>
      </main>

      {/* FOOTER */}
      <footer className="flex items-center justify-between px-8"
        style={{ height: '9%', background: '#111318', borderTop: '1px solid #21262d' }}>
        <p className="text-gray-700 text-sm font-mono">Foliot MES · Poste opérateur</p>
        <p className="text-3xl font-mono font-bold text-gray-300">{formatClock(now)}</p>
        <p className="text-gray-700 text-sm">
          {state.equipment ? `${state.equipment.hour_meter.toLocaleString()} h` : ''}
        </p>
      </footer>
    </div>
  );
}

function InfoCard({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="rounded-lg p-3" style={{ background: '#111318', border: '1px solid #21262d' }}>
      <p className="text-xs text-gray-600 mb-0.5">{label}</p>
      <p className={`text-sm font-semibold ${alert ? 'text-red-400' : 'text-gray-200'}`}>{value}</p>
    </div>
  );
}
