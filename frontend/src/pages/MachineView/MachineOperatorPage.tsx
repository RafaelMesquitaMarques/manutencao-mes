import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Clock, Wrench, CheckCircle, Loader2, Mic, MicOff, Shield, Package, X, Plus, Trash2, Search, Users, UserPlus, Sparkles } from 'lucide-react';
import { INTERVENTION_ICON_MAP } from '../../components/ui/IconLibrary';
import {
  fetchMachineOperatorState,
  fetchInterventionTypes,
  callMaintenance,
  startIntervention,
  completeIntervention,
  fetchChecklist,
  submitChecklist,
  fetchInterventionParts,
  addInterventionPart,
  removeInterventionPart,
  searchInventory,
  fetchKioskTechnicians,
  checkInTechnician,
  checkOutTechnician,
  organizeKioskNote,
} from '../../api/machineOperator';
import type {
  MachineOperatorState,
  MachineIntervention,
  InterventionType,
} from '../../types';
import type {
  ChecklistItem,
  InterventionPartItem,
  InventorySearchItem,
  KioskTechnician,
} from '../../api/machineOperator';
import { useMachineLive } from '../../hooks/useLiveEvents';

// Web Speech API is not in the standard DOM typings — minimal local shape
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: (event: SpeechRecognitionEventLike) => void;
  onend: () => void;
  start: () => void;
  stop: () => void;
}

interface SpeechRecognitionEventLike {
  results: { length: number } & Record<number, Record<number, { transcript: string }>>;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

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

// ── Safety Checklist Modal ────────────────────────────────────────────────────

interface SafetyChecklistModalProps {
  machineId: string;
  interventionId: string;
  items: ChecklistItem[];
  onConfirm: () => void;
  onCancel: () => void;
}

function SafetyChecklistModal({ machineId, interventionId, items, onConfirm, onCancel }: SafetyChecklistModalProps) {
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(items.map((i) => [i.id, false]))
  );
  const [submitting, setSubmitting] = useState(false);

  const toggle = (id: string) => setChecked((prev) => ({ ...prev, [id]: !prev[id] }));

  const requiredIds = items.filter((i) => i.is_required).map((i) => i.id);
  const allRequiredChecked = requiredIds.every((id) => checked[id]);
  const checkedCount = Object.values(checked).filter(Boolean).length;

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      const responses = items.map((item) => ({
        item_id: item.id,
        item_text: item.text,
        checked: checked[item.id] ?? false,
      }));
      await submitChecklist(machineId, interventionId, responses);
    } catch {
      // non-blocking — checklist submission failure should not block the start
    }
    onConfirm();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.85)' }}>
      <div className="w-full max-w-lg mx-4 rounded-2xl overflow-hidden"
        style={{ background: '#111318', border: '1.5px solid #30363d' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4"
          style={{ background: '#0d1117', borderBottom: '1px solid #21262d' }}>
          <div className="flex items-center gap-3">
            <Shield className="text-amber-400" size={22} />
            <div>
              <p className="text-white font-semibold">Vérification sécurité</p>
              <p className="text-gray-500 text-xs mt-0.5">{checkedCount} / {items.length} éléments cochés</p>
            </div>
          </div>
          <button onClick={onCancel} className="text-gray-600 hover:text-gray-300 transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Progress bar */}
        <div className="w-full h-1" style={{ background: '#21262d' }}>
          <div
            className="h-1 transition-all duration-300"
            style={{ width: `${items.length ? (checkedCount / items.length) * 100 : 0}%`, background: allRequiredChecked ? '#22c55e' : '#f59e0b' }}
          />
        </div>

        {/* Items */}
        <div className="px-6 py-4 space-y-2 max-h-80 overflow-y-auto">
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => toggle(item.id)}
              className="w-full flex items-start gap-4 p-3 rounded-xl text-left transition-colors"
              style={{
                background: checked[item.id] ? '#0f2a1a' : '#0d1117',
                border: `1px solid ${checked[item.id] ? '#22c55e40' : '#21262d'}`,
              }}>
              <div className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors"
                style={{
                  background: checked[item.id] ? '#22c55e' : '#21262d',
                  border: `1.5px solid ${checked[item.id] ? '#22c55e' : '#30363d'}`,
                }}>
                {checked[item.id] && <CheckCircle size={14} className="text-white" />}
              </div>
              <div className="flex-1">
                <p className={`text-sm ${checked[item.id] ? 'text-gray-400 line-through' : 'text-gray-200'}`}>
                  {item.text}
                </p>
                {item.is_required && !checked[item.id] && (
                  <span className="text-xs text-amber-500">Obligatoire</span>
                )}
              </div>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 flex gap-3" style={{ borderTop: '1px solid #21262d' }}>
          <button onClick={onCancel}
            className="flex-1 py-3 rounded-xl text-sm font-medium text-gray-400 hover:text-gray-200 transition-colors"
            style={{ background: '#21262d', border: '1px solid #30363d' }}>
            Annuler
          </button>
          <button
            disabled={!allRequiredChecked || submitting}
            onClick={handleConfirm}
            className="flex-1 py-3 rounded-xl text-sm font-bold transition-all disabled:opacity-40"
            style={{ background: allRequiredChecked ? '#166534' : '#21262d', border: `1.5px solid ${allRequiredChecked ? '#22c55e' : '#30363d'}`, color: '#fff' }}>
            {submitting ? <Loader2 className="animate-spin mx-auto" size={16} /> : '▶ Démarrer l\'intervention'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Parts Panel ───────────────────────────────────────────────────────────────

interface PartsPanelProps {
  machineId: string;
  interventionId: string;
}

function PartsPanel({ machineId, interventionId }: PartsPanelProps) {
  const [parts, setParts] = useState<InterventionPartItem[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<InventorySearchItem[]>([]);
  const [selected, setSelected] = useState<InventorySearchItem | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [freeText, setFreeText] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadParts = useCallback(async () => {
    try {
      const res = await fetchInterventionParts(machineId, interventionId);
      setParts(res.items);
    } catch {
      // ignore
    }
  }, [machineId, interventionId]);

  useEffect(() => { loadParts(); }, [loadParts]);

  const handleSearch = (q: string) => {
    setQuery(q);
    setSelected(null);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q.trim()) { setResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await searchInventory(q, 10);
        setResults(res.items);
      } catch {
        setResults([]);
      }
    }, 300);
  };

  const handleAdd = async () => {
    setAdding(true);
    try {
      await addInterventionPart(machineId, {
        intervention_id: interventionId,
        stock_item_id: selected?.id,
        item_code: selected?.code || undefined,
        item_description: selected ? selected.name : freeText || undefined,
        quantity_used: parseFloat(quantity) || 1,
        unit: selected?.unit || undefined,
      });
      setShowAdd(false);
      setQuery('');
      setResults([]);
      setSelected(null);
      setQuantity('1');
      setFreeText('');
      await loadParts();
    } catch {
      // ignore
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (partId: string) => {
    setRemoving(partId);
    try {
      await removeInterventionPart(machineId, partId);
      await loadParts();
    } catch {
      // ignore
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="w-full rounded-2xl overflow-hidden" style={{ background: '#0d1117', border: '1px solid #21262d' }}>
      {/* Header */}
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left"
        onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center gap-2">
          <Package size={16} className="text-blue-400" />
          <span className="text-sm font-medium text-gray-300">Pièces utilisées</span>
          {parts.length > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 font-mono">{parts.length}</span>
          )}
        </div>
        <span className="text-gray-600 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-2">
          {parts.length === 0 && !showAdd && (
            <p className="text-gray-600 text-xs text-center py-2">Aucune pièce enregistrée</p>
          )}
          {parts.map((p) => (
            <div key={p.id} className="flex items-center gap-2 py-1.5">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-200 truncate">{p.item_description || p.item_code || '—'}</p>
                <p className="text-xs text-gray-600">{p.item_code} · {p.quantity_used} {p.unit || 'un'} · <span className={p.approval_status === 'approved' ? 'text-green-500' : p.approval_status === 'rejected' ? 'text-red-400' : 'text-amber-400'}>{p.approval_status}</span></p>
              </div>
              <button
                onClick={() => handleRemove(p.id)}
                disabled={removing === p.id}
                className="p-1.5 rounded-lg text-gray-600 hover:text-red-400 transition-colors disabled:opacity-40">
                {removing === p.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              </button>
            </div>
          ))}

          {showAdd ? (
            <div className="space-y-2 mt-2 pt-2" style={{ borderTop: '1px solid #21262d' }}>
              {/* Search */}
              <div className="relative">
                <div className="flex items-center gap-2 bg-[#111318] border border-[#30363d] rounded-lg px-3 py-2">
                  <Search size={14} className="text-gray-500 flex-shrink-0" />
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => handleSearch(e.target.value)}
                    placeholder="Rechercher dans l'inventaire…"
                    className="flex-1 bg-transparent text-sm text-gray-200 placeholder-gray-600 outline-none"
                  />
                </div>
                {results.length > 0 && !selected && (
                  <div className="absolute z-10 w-full mt-1 rounded-lg overflow-hidden shadow-xl"
                    style={{ background: '#161b22', border: '1px solid #30363d' }}>
                    {results.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => { setSelected(r); setQuery(r.code || r.name); setResults([]); }}
                        className="w-full px-3 py-2 text-left hover:bg-white/5 transition-colors"
                        style={{ borderBottom: '0.5px solid #21262d' }}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-mono font-medium text-blue-400">{r.code}</span>
                            {r.description && (
                              <div className="text-xs text-gray-500 mt-0.5 truncate">{r.description}</div>
                            )}
                          </div>
                          <span className="text-xs text-gray-600 flex-shrink-0 whitespace-nowrap">
                            Stock: {r.quantity} {r.unit}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* Free description if no inventory match */}
              {!selected && (
                <input
                  value={freeText}
                  onChange={(e) => setFreeText(e.target.value)}
                  placeholder="Description libre (si hors inventaire)"
                  className="w-full bg-[#111318] border border-[#30363d] rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 outline-none"
                />
              )}
              {/* Quantity */}
              <div className="flex gap-2 items-center">
                <label className="text-xs text-gray-500 w-16">Quantité</label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="w-24 bg-[#111318] border border-[#30363d] rounded-lg px-3 py-1.5 text-sm text-gray-200 outline-none"
                />
                {selected && <span className="text-xs text-gray-500">{selected.unit}</span>}
              </div>
              <div className="flex gap-2">
                <button onClick={() => { setShowAdd(false); setQuery(''); setResults([]); setSelected(null); setFreeText(''); }}
                  className="flex-1 py-2 rounded-lg text-xs text-gray-500 hover:text-gray-300 transition-colors"
                  style={{ background: '#21262d' }}>
                  Annuler
                </button>
                <button
                  disabled={adding || (!selected && !freeText.trim())}
                  onClick={handleAdd}
                  className="flex-1 py-2 rounded-lg text-xs font-semibold text-white transition-all disabled:opacity-40"
                  style={{ background: '#1d4ed8' }}>
                  {adding ? <Loader2 size={14} className="animate-spin mx-auto" /> : 'Ajouter'}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowAdd(true)}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs text-blue-400 hover:text-blue-300 transition-colors mt-1"
              style={{ background: '#0a1628', border: '1px dashed #1d4ed8' }}>
              <Plus size={13} /> Ajouter une pièce
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

// Standalone route wrapper (kept for backward-compat; /machine/:id redirects to the
// unified kiosk, but this still renders the full-screen intervention view if reached).
export default function MachineOperatorPage() {
  const { machine_id } = useParams<{ machine_id: string }>();
  if (!machine_id) return null;
  return <MaintenancePanel machineId={machine_id} />;
}

// ── Technician check-in ───────────────────────────────────────────────────────
// Several technicians can work the same intervention (e.g. two mechanics on one
// ticket). Each one checks in/out here; the factory-map pictograms and the
// intervention's started_by credit follow these check-ins.
function TechnicianCheckinCard({ machineId, intervention, onChanged }: {
  machineId: string;
  intervention: MachineIntervention;
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [allTechs, setAllTechs] = useState<KioskTechnician[]>([]);
  const [busy, setBusy] = useState(false);
  const checkedIn = intervention.technicians ?? [];

  const openPicker = async () => {
    setPickerOpen(true);
    try {
      const d = await fetchKioskTechnicians(machineId);
      setAllTechs(d.items || []);
    } catch {
      setAllTechs([]);
    }
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await onChanged(); } finally { setBusy(false); }
  };

  const available = allTechs.filter((tech) => !checkedIn.some((c) => c.technician_id === tech.id));

  return (
    <div className="w-full rounded-2xl px-5 py-4" style={{ background: '#111318', border: '1px solid #21262d' }}>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-gray-400 uppercase tracking-widest font-semibold flex items-center gap-2">
          <Users size={14} /> {t('kiosk.techniciansOnJob')}
        </p>
        {!pickerOpen && (
          <button disabled={busy} onClick={openPicker}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all active:scale-95 disabled:opacity-50"
            style={{ background: '#1e3a5f', border: '1px solid #3b82f6', color: '#93c5fd' }}>
            <UserPlus size={13} /> {t('kiosk.checkIn')}
          </button>
        )}
      </div>

      {checkedIn.length === 0 && !pickerOpen && (
        <p className="text-gray-600 text-sm">{t('kiosk.noneCheckedIn')}</p>
      )}

      {checkedIn.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {checkedIn.map((c) => (
            <span key={c.id} className="flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-full text-sm"
              style={{ background: '#a855f715', border: '1px solid #a855f750', color: '#d8b4fe' }}>
              {c.name}
              {c.checked_in_at && <span className="text-purple-400/60 text-xs">{elapsed(c.checked_in_at)}</span>}
              {c.technician_id && (
                <button disabled={busy} title={t('kiosk.checkOut')}
                  onClick={() => run(() => checkOutTechnician(machineId, c.technician_id!))}
                  className="p-1 rounded-full hover:bg-purple-500/20 transition-colors disabled:opacity-50">
                  <X size={13} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {pickerOpen && (
        <div className="mt-3">
          <p className="text-gray-400 text-sm mb-2">{t('kiosk.whoChecksIn')}</p>
          <div className="grid grid-cols-2 gap-2 max-h-52 overflow-y-auto">
            {available.map((tech) => (
              <button key={tech.id} disabled={busy}
                onClick={() => run(async () => { await checkInTechnician(machineId, tech.id); setPickerOpen(false); })}
                className="px-3 py-3 rounded-xl text-sm text-left text-gray-200 transition-all active:scale-95 disabled:opacity-50 hover:border-blue-500"
                style={{ background: '#0d1117', border: '1px solid #21262d' }}>
                {tech.name}
                {tech.specialty && <span className="block text-[11px] text-gray-500 mt-0.5">{tech.specialty}</span>}
              </button>
            ))}
            {available.length === 0 && (
              <p className="text-gray-600 text-sm col-span-2">{t('kiosk.noTechniciansAvailable')}</p>
            )}
          </div>
          <button onClick={() => setPickerOpen(false)}
            className="mt-2 text-xs text-gray-600 hover:text-gray-400 transition-colors">
            {t('common.cancel')}
          </button>
        </div>
      )}
    </div>
  );
}

// Intervention flow as an embeddable panel. `embedded` strips the full-screen chrome
// (header/footer/side info) so it can live inside the unified MES kiosk (MachinePage).
export function MaintenancePanel({ machineId, embedded = false }: { machineId: string; embedded?: boolean }) {
  const machine_id = machineId;
  const { t } = useTranslation();
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
  type CompletionStep = 'idle' | 'select_type' | 'add_note';
  const [completionStep, setCompletionStep] = useState<CompletionStep>('idle');
  const [mechNote, setMechNote] = useState('');
  const [organizing, setOrganizing] = useState(false);
  const [organizeHint, setOrganizeHint] = useState('');

  // Safety checklist
  const [checklistItems, setChecklistItems] = useState<ChecklistItem[]>([]);
  const [showChecklist, setShowChecklist] = useState(false);
  const [pendingInterventionId, setPendingInterventionId] = useState<string | null>(null);

  // Voice transcription
  const [isRecording, setIsRecording] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

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
    // Slow fallback only — the live WS below refetches the instant something changes.
    pollRef.current = setInterval(load, 60_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [machine_id]);

  useMachineLive([machine_id, state?.machine?.code], () => load());

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
      setOrganizeHint('');
      setSelectedTypeId(null);
      setSelectedTypeName('');
      setSelectedTypeIcon('');
      setCompletionStep('idle');
    } catch {
      setError('Action échouée');
    } finally {
      setActing(false);
    }
  };

  // Start intervention: fetch checklist first, show modal if items exist
  const handleStartIntervention = async () => {
    if (!machine_id) return;
    setActing(true);
    try {
      const checklist = await fetchChecklist(machine_id);
      if (checklist.items.length > 0) {
        // Need to call the backend to create the intervention first (status=waiting→in_progress)
        // Actually: start creates the intervention. We show modal BEFORE starting.
        // We'll call start, get the intervention_id, then show modal.
        const result = await startIntervention(machine_id, note || undefined);
        const interventionId: string = result?.intervention?.id;
        if (interventionId) {
          setChecklistItems(checklist.items);
          setPendingInterventionId(interventionId);
          setShowChecklist(true);
          await load();
          setNote('');
        } else {
          await load();
          setNote('');
        }
      } else {
        // No checklist — start directly
        await startIntervention(machine_id, note || undefined);
        await load();
        setNote('');
      }
    } catch {
      setError('Action échouée');
    } finally {
      setActing(false);
    }
  };

  // Voice transcription
  const toggleRecording = () => {
    if (isRecording) {
      recognitionRef.current?.stop();
      setIsRecording(false);
      return;
    }
    const win = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const RecognitionCtor = win.SpeechRecognition ?? win.webkitSpeechRecognition;

    if (!RecognitionCtor) {
      alert('Reconnaissance vocale non supportée. Utilisez Chrome.');
      return;
    }
    const recognition = new RecognitionCtor();
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

  // AI tidy-up of the dictated closing note — same organizer as WO notes.
  // Language is pinned to 'fr' to match the hardcoded fr-CA dictation above.
  const organizeClosingNote = async () => {
    if (!machine_id || !mechNote.trim() || organizing) return;
    if (isRecording) {
      recognitionRef.current?.stop();
      setIsRecording(false);
    }
    setOrganizing(true);
    setOrganizeHint('');
    try {
      const res = await organizeKioskNote(machine_id, mechNote.trim(), 'fr');
      setMechNote(res.text);
      if (!res.ai_used) setOrganizeHint(t('workOrders.organizeOffline'));
    } catch {
      setOrganizeHint(t('workOrders.organizeFailed'));
    } finally {
      setOrganizing(false);
    }
  };

  const intervention = state?.active_intervention ?? null;
  const isIdle       = !intervention;
  const isWaiting    = intervention?.status === 'waiting';
  const isInProgress = intervention?.status === 'in_progress';

  const statusLabel = isIdle ? 'En production' : isWaiting ? 'En attente de mécanicien' : 'Intervention en cours';
  const statusColor  = isIdle ? 'text-green-400' : isWaiting ? 'text-amber-400' : 'text-blue-400';
  const statusBorder = isIdle ? 'border-green-700/40' : isWaiting ? 'border-amber-700/40' : 'border-blue-700/40';

  if (loading) return (
    <div className={embedded ? 'flex items-center justify-center py-10' : 'h-screen flex items-center justify-center bg-[#0d1117]'}>
      <Loader2 className="animate-spin text-gray-500" size={embedded ? 24 : 48} />
    </div>
  );

  if (!state) {
    if (embedded) return <p className="text-gray-600 text-sm py-4">⚠ {error ?? 'Machine introuvable'}</p>;
    return (
      <div style={{ background: '#0d1117', height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
        <span style={{ color: '#f85149', fontSize: '16px' }}>⚠ {error ?? 'Machine introuvable'}</span>
        <span style={{ color: '#6e7681', fontSize: '12px', fontFamily: 'monospace' }}>{machine_id}</span>
        <button onClick={() => window.location.reload()}
          style={{ marginTop: '8px', padding: '8px 16px', background: '#21262d', color: '#e6edf3', border: '0.5px solid #30363d', borderRadius: '6px', cursor: 'pointer' }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className={embedded ? '' : 'h-screen flex flex-col bg-[#0d1117] text-white overflow-hidden select-none'}>

      {/* Safety checklist modal */}
      {showChecklist && pendingInterventionId && checklistItems.length > 0 && (
        <SafetyChecklistModal
          machineId={machine_id!}
          interventionId={pendingInterventionId}
          items={checklistItems}
          onConfirm={() => {
            setShowChecklist(false);
            setPendingInterventionId(null);
            setChecklistItems([]);
          }}
          onCancel={() => {
            setShowChecklist(false);
            setPendingInterventionId(null);
            setChecklistItems([]);
          }}
        />
      )}

      {/* TOP BAR (full-screen only) */}
      {!embedded && (
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
      )}

      {/* BODY */}
      <main className={embedded ? 'flex flex-col gap-4' : 'flex-1 flex items-center justify-center px-8 gap-8'}
        style={embedded ? undefined : { height: '78%' }}>

        {/* Left info panel (full-screen only) */}
        {!embedded && (
          <>
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
          </>
        )}

        {/* Action zone */}
        <div className={embedded ? 'w-full flex flex-col gap-4' : 'flex-1 flex flex-col items-center justify-center gap-6 max-w-xl overflow-y-auto'}>
          {error && <p className="text-red-400 text-sm bg-red-500/10 px-4 py-2 rounded-lg">{error}</p>}

          {/* STATE 1 — idle. In the kiosk, "call maintenance" is a stop-justification
              option, so the embedded panel just shows there's nothing active. */}
          {isIdle && (embedded ? (
            state.open_tickets_count > 0 ? (
              <button disabled={acting}
                onClick={() => act(() => callMaintenance(machine_id, note || undefined))}
                className="w-full py-3 rounded-xl text-sm font-bold transition-all active:scale-95 disabled:opacity-50 bg-amber-700/30 border border-amber-500/40 text-amber-300">
                {acting ? <Loader2 className="animate-spin mx-auto" size={18} /> : '🔧 Prendre en charge la maintenance'}
              </button>
            ) : (
              <p className="text-gray-400 text-sm">Aucune maintenance active</p>
            )
          ) : (
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
          ))}

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
              <TechnicianCheckinCard machineId={machine_id!} intervention={intervention!} onChanged={load} />
              <textarea value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="Note mécanicien (optionnel)"
                className="w-full h-20 bg-[#111318] border border-[#21262d] rounded-xl px-4 py-3 text-sm text-gray-300 placeholder-gray-600 resize-none focus:outline-none focus:border-blue-700/60"
              />
              <button disabled={acting}
                onClick={handleStartIntervention}
                className="w-full py-5 rounded-2xl text-xl font-bold transition-all active:scale-95 disabled:opacity-50 bg-green-800 hover:bg-green-700"
                style={{ border: '2px solid #22c55e' }}>
                {acting ? <Loader2 className="animate-spin mx-auto" size={24} /> : '▶ Démarrer l\'intervention'}
              </button>
            </>
          )}

          {/* STATE 3 — in_progress */}
          {isInProgress && (
            <>
              {/* Status card — always visible in state 3 */}
              <div className="w-full rounded-2xl px-6 py-4 text-center"
                style={{ background: '#0a1628', border: '1px solid #1d4ed8' }}>
                <Wrench className="mx-auto text-blue-400 mb-1" size={28} />
                <p className="text-blue-300 text-lg font-semibold">Intervention en cours</p>
                <p className="text-blue-600 text-sm">Démarrée il y a {elapsed(intervention!.started_at!)}</p>
                {intervention!.operator_note && (
                  <p className="text-gray-400 text-xs mt-2 italic">"{intervention!.operator_note}"</p>
                )}
              </div>

              {/* Technicians on the intervention — check-in/out, multi-tech */}
              <TechnicianCheckinCard machineId={machine_id!} intervention={intervention!} onChanged={load} />

              {/* Parts panel — always visible in state 3 */}
              <PartsPanel machineId={machine_id!} interventionId={intervention!.id} />

              {/* STEP idle — single "Terminer" button */}
              {completionStep === 'idle' && (
                <button
                  disabled={acting}
                  onClick={() => setCompletionStep(interventionTypes.length > 0 ? 'select_type' : 'add_note')}
                  className="w-full py-5 rounded-2xl text-xl font-bold transition-all active:scale-95 disabled:opacity-50"
                  style={{ background: '#1e3a5f', border: '2px solid #3b82f6' }}>
                  <CheckCircle className="inline mr-2" size={22} />Terminer l'intervention
                </button>
              )}

              {/* STEP select_type — type grid */}
              {completionStep === 'select_type' && (
                <div className="w-full">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-gray-400 text-sm font-medium tracking-wide uppercase">Type d'intervention</p>
                    <button onClick={() => setCompletionStep('idle')}
                      className="text-xs text-gray-600 hover:text-gray-400 transition-colors">← Retour</button>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    {interventionTypes.map((t) => (
                      <button key={t.id}
                        onClick={() => {
                          setSelectedTypeId(t.id);
                          setSelectedTypeName(t.name);
                          setSelectedTypeIcon(t.icon);
                          setCompletionStep('add_note');
                        }}
                        className="flex flex-col items-center gap-2 p-3 rounded-2xl transition-all active:scale-95"
                        style={{ background: '#111318', border: `1.5px solid ${t.color}40` }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLButtonElement).style.background = `${t.color}15`;
                          (e.currentTarget as HTMLButtonElement).style.border = `1.5px solid ${t.color}`;
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLButtonElement).style.background = '#111318';
                          (e.currentTarget as HTMLButtonElement).style.border = `1.5px solid ${t.color}40`;
                        }}>
                        <div className="w-16 h-16 rounded-full flex items-center justify-center"
                          style={{ background: `${t.color}18`, border: `1.5px solid ${t.color}50`, color: t.color }}>
                          <DynamicIcon name={t.icon} size={28} />
                        </div>
                        <span className="text-xs text-gray-300 text-center leading-tight">{t.name}</span>
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => { setSelectedTypeId(null); setSelectedTypeName(''); setSelectedTypeIcon(''); setCompletionStep('add_note'); }}
                    className="mt-3 w-full text-xs text-gray-600 hover:text-gray-400 transition-colors">
                    Passer sans type →
                  </button>
                </div>
              )}

              {/* STEP add_note — note + voice + confirm */}
              {completionStep === 'add_note' && (
                <div className="w-full flex flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <button
                      onClick={() => setCompletionStep(interventionTypes.length > 0 ? 'select_type' : 'idle')}
                      className="text-xs text-gray-600 hover:text-gray-400 transition-colors">← Retour</button>
                    {selectedTypeName && (
                      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium"
                        style={{ background: '#1e3a5f', border: '1px solid #3b82f6', color: '#93c5fd' }}>
                        <DynamicIcon name={selectedTypeIcon} size={15} />
                        <span>{selectedTypeName}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2 items-start">
                    <textarea value={mechNote} onChange={(e) => setMechNote(e.target.value)}
                      placeholder={t('kiosk.closingNotePlaceholder')}
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

                  {mechNote.trim() && (
                    <button type="button" onClick={organizeClosingNote}
                      disabled={organizing}
                      title={t('workOrders.organizeHint')}
                      className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all active:scale-95 disabled:opacity-60"
                      style={{ background: '#111318', border: '1px solid #3b82f6', color: '#93c5fd' }}>
                      {organizing
                        ? <><Loader2 className="animate-spin" size={16} />{t('workOrders.organizing')}</>
                        : <><Sparkles size={16} />{t('workOrders.organizeAI')}</>}
                    </button>
                  )}
                  {organizeHint && <p className="text-amber-400/90 text-xs -mt-2">{organizeHint}</p>}

                  <button disabled={acting || organizing}
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

        {!embedded && <div className="h-3/4 w-px" style={{ background: '#21262d' }} />}

        {/* Last intervention panel */}
        <div style={embedded ? undefined : { width: '220px', flexShrink: 0 }} className="flex flex-col gap-3 py-6">
          <p className="text-xs text-gray-400 uppercase tracking-widest font-semibold">Dernière intervention</p>
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
            <p className="text-gray-400 text-sm">Aucune</p>
          )}
        </div>
      </main>

      {/* FOOTER (full-screen only) */}
      {!embedded && (
        <footer className="flex items-center justify-between px-8"
          style={{ height: '9%', background: '#111318', borderTop: '1px solid #21262d' }}>
          <p className="text-gray-700 text-sm font-mono">Foliot MES · Poste opérateur</p>
          <p className="text-3xl font-mono font-bold text-gray-300">{formatClock(now)}</p>
          <p className="text-gray-700 text-sm">
            {state.equipment ? `${state.equipment.hour_meter.toLocaleString()} h` : ''}
          </p>
        </footer>
      )}
    </div>
  );
}

function DynamicIcon({ name, size = 28 }: { name: string; size?: number }) {
  const Icon = INTERVENTION_ICON_MAP[name];
  if (Icon) return <Icon size={size} />;
  return <span style={{ fontSize: Math.floor(size * 0.6) }}>{name ? name[0] : '?'}</span>;
}

function InfoCard({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="rounded-lg p-3" style={{ background: '#111318', border: '1px solid #21262d' }}>
      <p className="text-xs text-gray-400 mb-0.5">{label}</p>
      <p className={`text-sm font-semibold ${alert ? 'text-red-400' : 'text-gray-200'}`}>{value}</p>
    </div>
  );
}
