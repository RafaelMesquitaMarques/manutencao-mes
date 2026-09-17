import api from './axios';

// ─── Replay do turno ──────────────────────────────────────────────────────────
// Leitura pura do histórico que a plataforma já grava (paradas, intervenções,
// tickets, passagens de OF, produção horária, ledger do Pit Stop). Nenhuma
// tabela nova: ver backend/app/services/factory_replay.py.

/** Como o estado do segmento foi obtido — a UI mostra a origem em vez de fingir
 *  que tudo foi medido. `baseline` = nenhum evento registado nesse intervalo
 *  (mesma inferência que o modo ao vivo faz); `no_history` = ativo sem camada MES. */
export type ReplaySegmentSource = 'stop' | 'intervention' | 'ticket' | 'baseline' | 'no_history';

export interface ReplayTechnician {
  name: string;
  since: string | null;
  until: string | null;
}

export interface ReplaySegmentDetail {
  comments?: string | null;
  justified_by?: string | null;
  job_number?: string | null;
  operator?: string | null;
  technicians?: ReplayTechnician[];
  ticket_id?: string | null;
  ticket_number?: string | null;
  priority?: string | null;
  called_at?: string | null;
  mechanic_note?: string | null;
}

export interface ReplaySegment {
  start: string;
  end: string;
  status: string;
  reason: string | null;
  source: ReplaySegmentSource | null;
  ref_id: string | null;
  detail: ReplaySegmentDetail | null;
}

export interface ReplayTicketSpan {
  start: string;
  end: string;
  ticket_id: string;
  ticket_number: string | null;
}

export interface ReplayTrack {
  equipment_id: string;
  machine_id: string | null;
  segments: ReplaySegment[];
  ticket_spans: ReplayTicketSpan[];
}

export interface ReplayRun {
  id: string;
  job_order_id: string;
  job_number: string;
  product_name: string | null;
  target_quantity: number | null;
  machine_id: string;
  equipment_id: string | null;
  department: string | null;
  operator: string | null;
  started_at: string;
  ended_at: string | null;
  pieces: number;
  rejects: number;
  last_piece_at: string | null;
  /** Passagem anterior à janela, só para saber o que já estava parqueado no início. */
  carry_in: boolean;
}

export interface ReplayPitEvent {
  ts: string;
  job_order_id: string;
  job_number: string;
  direction: string;           // 'in' | 'out'
  quantity: number;
  components: string[];
  destination_machine_id: string | null;
  destination_equipment_id?: string | null;
}

export interface ReplayProduction {
  machine_id: string;
  equipment_id: string | null;
  hour: string;
  count: number;
  reject_count: number;
  job_number: string | null;
}

export interface ReplayEvent {
  ts: string;
  kind: 'ticket_opened' | 'ticket_closed' | 'alert' | 'reject';
  machine_id: string | null;
  equipment_id: string | null;
  label: string | null;
  ref_id: string | null;
  severity?: string | null;
  quantity?: number;
  job_number?: string | null;
}

export interface ReplayTimeline {
  plant_id: string;
  timezone: string;
  start: string;
  end: string;
  generated_at: string;
  tracks: ReplayTrack[];
  of_runs: ReplayRun[];
  pit_events: ReplayPitEvent[];
  pit_moved_before: string[];
  production: ReplayProduction[];
  events: ReplayEvent[];
}

export interface ReplayWindow {
  key: string;                 // morning | afternoon | night | chave livre da config
  start: string;
  end: string;
  machine_count: number;
}

export interface ReplayWindows {
  plant_id: string;
  timezone: string;
  date: string;
  windows: ReplayWindow[];
  day: { start: string; end: string };
}

export const fetchReplayWindows = async (plantId: string, day: string): Promise<ReplayWindows> => {
  const { data } = await api.get<ReplayWindows>(`/api/factory-replay/${plantId}/windows`, { params: { date: day } });
  return data;
};

export const fetchReplayTimeline = async (plantId: string, start: string, end: string): Promise<ReplayTimeline> => {
  const { data } = await api.get<ReplayTimeline>(`/api/factory-replay/${plantId}/timeline`, { params: { start, end } });
  return data;
};
