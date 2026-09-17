/**
 * Modelo do Replay do Turno — índice em memória + leitura do estado num instante.
 *
 * O backend devolve INTERVALOS (segmentos de estado, passagens de OF, spans de
 * ticket) em vez de amostras: a janela inteira cabe num fetch e a navegação no
 * tempo é local, sem rede. Aqui esses intervalos viram índices ordenados e
 * `overlayAt(t)` produz exatamente a MESMA forma que o push ao vivo do
 * WebSocket entrega a `applyStatus` — é por isso que o replay reaproveita o
 * mapa 2D, o 3D, as cores, a legenda e os filtros sem nenhuma alteração neles.
 */
import type {
  ReplayEvent, ReplayProduction, ReplayRun, ReplaySegment, ReplayTechnician,
  ReplayTicketSpan, ReplayTimeline,
} from '../../../api/factoryReplay';

const HOUR_MS = 3_600_000;

export const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** Ativo do mapa, reduzido ao que a herança de estado precisa. */
export interface ReplayAsset {
  id: string;                          // equipment_id (o mesmo id de MapMachine)
  parent_equipment_id: string | null;
  block_kind: string | null;
  subtype: string | null;
}

/** Uma OF "parqueada" à saída de uma máquina no instante T. */
export interface ParkedOf {
  job_number: string;
  product_name: string | null;
  age_minutes: number | null;
  job_order_id: string;
}

/** A forma que `applyStatus` consome — idêntica ao payload do WS ao vivo. */
export interface ReplayOverlayItem {
  id: string;
  status: string;
  operator: string | null;
  technicians: { name: string; since: string | null }[] | null;
  stop_reason: string | null;
  line_stats: null;
  current_job_number: string | null;
  queued_ofs: ParkedOf[] | null;
  queued_total: number;
  pipeline_ofs: null;
  pipeline_total: number;
  open_ticket: boolean;
  open_ticket_id: string | null;
  open_ticket_number: string | null;
}

interface TrackIndex {
  equipmentId: string;
  machineId: string | null;
  segments: { s: number; e: number; seg: ReplaySegment }[];
  tickets: { s: number; e: number; span: ReplayTicketSpan }[];
}

interface RunIndex extends ReplayRun {
  s: number;
  e: number;          // ended_at, ou +Infinity quando a passagem ainda estava aberta
}

export interface MachineSnapshot {
  equipmentId: string;
  machineId: string | null;
  segment: ReplaySegment | null;
  status: string;
  /** Estado próprio antes da herança do pai — `null` quando não há herança. */
  ownStatus: string | null;
  inheritedFrom: string | null;
  technicians: ReplayTechnician[];
  ticket: ReplayTicketSpan | null;
  operator: string | null;
  currentRun: ReplayRun | null;
  parked: ParkedOf[];
  /** Peças contadas nas horas JÁ COMPLETAS da janela até T (feed ADAM). */
  piecesSoFar: number;
  rejectsSoFar: number;
  hourly: ReplayProduction[];
  events: ReplayEvent[];
}

export interface OfSnapshot {
  jobOrderId: string;
  jobNumber: string;
  productName: string | null;
  runs: ReplayRun[];
  /** Passagem aberta em T (OF estava nesta máquina), se houver. */
  currentRun: ReplayRun | null;
  /** Passagem fechada mais recente até T (OF parqueada à saída), se não houver aberta. */
  lastRun: ReplayRun | null;
  inBuffer: boolean;
  piecesSoFar: number;
  pitEvents: { ts: string; direction: string; quantity: number; components: string[] }[];
}

export class ReplayIndex {
  readonly startMs: number;
  readonly endMs: number;
  readonly timezone: string;
  readonly timeline: ReplayTimeline;

  private tracks = new Map<string, TrackIndex>();
  private runsByEquipment = new Map<string, RunIndex[]>();
  private runsByOf = new Map<string, RunIndex[]>();
  private productionByEquipment = new Map<string, ReplayProduction[]>();
  private eventsByEquipment = new Map<string, ReplayEvent[]>();
  private pitByOf = new Map<string, ReplayTimeline['pit_events']>();
  private pitMovedBefore: Set<string>;

  constructor(timeline: ReplayTimeline) {
    this.timeline = timeline;
    this.startMs = ms(timeline.start);
    this.endMs = ms(timeline.end);
    this.timezone = timeline.timezone;
    this.pitMovedBefore = new Set(timeline.pit_moved_before ?? []);

    for (const tr of timeline.tracks) {
      this.tracks.set(tr.equipment_id, {
        equipmentId: tr.equipment_id,
        machineId: tr.machine_id,
        segments: tr.segments.map((seg) => ({ s: ms(seg.start), e: ms(seg.end), seg })),
        tickets: (tr.ticket_spans ?? []).map((span) => ({ s: ms(span.start), e: ms(span.end), span })),
      });
    }
    for (const run of timeline.of_runs) {
      const idx: RunIndex = { ...run, s: ms(run.started_at), e: run.ended_at ? ms(run.ended_at) : Infinity };
      if (run.equipment_id) {
        const list = this.runsByEquipment.get(run.equipment_id);
        if (list) list.push(idx); else this.runsByEquipment.set(run.equipment_id, [idx]);
      }
      const byOf = this.runsByOf.get(run.job_order_id);
      if (byOf) byOf.push(idx); else this.runsByOf.set(run.job_order_id, [idx]);
    }
    for (const list of this.runsByEquipment.values()) list.sort((a, b) => a.s - b.s);
    for (const list of this.runsByOf.values()) list.sort((a, b) => a.s - b.s);

    for (const p of timeline.production) {
      if (!p.equipment_id) continue;
      const list = this.productionByEquipment.get(p.equipment_id);
      if (list) list.push(p); else this.productionByEquipment.set(p.equipment_id, [p]);
    }
    for (const ev of timeline.events) {
      if (!ev.equipment_id) continue;
      const list = this.eventsByEquipment.get(ev.equipment_id);
      if (list) list.push(ev); else this.eventsByEquipment.set(ev.equipment_id, [ev]);
    }
    for (const pe of timeline.pit_events) {
      const list = this.pitByOf.get(pe.job_order_id);
      if (list) list.push(pe); else this.pitByOf.set(pe.job_order_id, [pe]);
    }
  }

  hasTrack(equipmentId: string): boolean {
    return this.tracks.has(equipmentId);
  }

  /** Segmentos de estado de uma máquina na janela (a faixa do painel de detalhe). */
  segmentsFor(equipmentId: string): ReplaySegment[] {
    return this.tracks.get(equipmentId)?.segments.map((x) => x.seg) ?? [];
  }

  /** Todas as passagens de OF por uma máquina na janela (exclui a fila de arrasto). */
  runsFor(equipmentId: string): ReplayRun[] {
    return (this.runsByEquipment.get(equipmentId) ?? []).filter((r) => !r.carry_in);
  }

  private segmentAt(equipmentId: string, t: number): ReplaySegment | null {
    const tr = this.tracks.get(equipmentId);
    if (!tr || tr.segments.length === 0) return null;
    // Busca binária — os segmentos são contíguos e ordenados.
    let lo = 0, hi = tr.segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = tr.segments[mid];
      if (t < s.s) hi = mid - 1;
      else if (t >= s.e) lo = mid + 1;
      else return s.seg;
    }
    // Fora do intervalo coberto: prende nas extremidades da janela.
    if (t < tr.segments[0].s) return tr.segments[0].seg;
    return tr.segments[tr.segments.length - 1].seg;
  }

  private ticketAt(equipmentId: string, t: number): ReplayTicketSpan | null {
    const tr = this.tracks.get(equipmentId);
    if (!tr) return null;
    for (const span of tr.tickets) if (t >= span.s && t < span.e) return span.span;
    return null;
  }

  private techniciansAt(seg: ReplaySegment | null, t: number): ReplayTechnician[] {
    const list = seg?.detail?.technicians;
    if (!list?.length) return [];
    return list.filter((tech) => {
      const since = ms(tech.since);
      const until = tech.until ? ms(tech.until) : Infinity;
      // Sem hora de check-in, o técnico conta durante todo o segmento roxo.
      return Number.isNaN(since) ? true : t >= since && t < until;
    });
  }

  /** Passagem aberta nesta máquina em T (a OF carregada no kiosk nesse momento). */
  private runAt(equipmentId: string, t: number): RunIndex | null {
    const list = this.runsByEquipment.get(equipmentId);
    if (!list) return null;
    let best: RunIndex | null = null;
    for (const r of list) {
      if (r.carry_in) continue;
      if (r.s > t) break;
      if (t < r.e && (best === null || r.s > best.s)) best = r;
    }
    return best;
  }

  /** OFs paradas à saída de cada máquina em T: a última passagem da OF já tinha
   *  fechado e nada a moveu depois (nem outra máquina, nem o Pit Stop). É a
   *  mesma definição do badge +N ao vivo, reconstruída no tempo. */
  private parkedByEquipment(t: number): Map<string, ParkedOf[]> {
    const out = new Map<string, ParkedOf[]>();
    for (const [ofId, runs] of this.runsByOf) {
      let last: RunIndex | null = null;
      for (const r of runs) {
        if (r.s > t) break;
        if (last === null || r.s >= last.s) last = r;
      }
      if (!last || !last.equipment_id) continue;
      if (t < last.e) continue;                      // ainda em passagem → não parqueada
      if (this.pitMovedBefore.has(ofId)) continue;   // já tinha entrado no buffer
      const pit = this.pitByOf.get(ofId);
      if (pit?.some((p) => ms(p.ts) <= t)) continue; // entrou/saiu do buffer antes de T
      const age = Number.isFinite(last.e) ? Math.max(0, Math.floor((t - last.e) / 60000)) : null;
      const item: ParkedOf = {
        job_number: last.job_number, product_name: last.product_name,
        age_minutes: age, job_order_id: ofId,
      };
      const list = out.get(last.equipment_id);
      if (list) list.push(item); else out.set(last.equipment_id, [item]);
    }
    for (const list of out.values()) {
      list.sort((a, b) => (b.age_minutes ?? -1) - (a.age_minutes ?? -1));
    }
    return out;
  }

  /** O overlay completo em T, na forma que `applyStatus` já consome.
   *  `assets` traz o parentesco para que transportadores/cobots sigam a
   *  máquina-mãe, exatamente como no modo ao vivo. */
  overlayAt(t: number, assets: ReplayAsset[]): ReplayOverlayItem[] {
    const parked = this.parkedByEquipment(t);
    const own = new Map<string, string>();
    for (const a of assets) {
      const seg = this.segmentAt(a.id, t);
      own.set(a.id, seg?.status ?? 'idle');
    }
    const out: ReplayOverlayItem[] = [];
    for (const a of assets) {
      const seg = this.segmentAt(a.id, t);
      let status = own.get(a.id) ?? 'idle';
      // Herança: ao vivo, um cobot COM telemetria é independente enquanto a
      // máquina roda e só cai quando ela cai; transportadores (e cobots sem
      // telemetria) seguem-na sempre. No replay não há histórico de
      // `robot_cell_states`, então todos os filhos seguem integralmente o pai —
      // é o ramo `elif pstat` de live_status.py, e a limitação está documentada.
      if (a.parent_equipment_id) {
        const pstat = own.get(a.parent_equipment_id);
        if (pstat) status = pstat;
      }
      const ticket = this.ticketAt(a.id, t);
      const run = this.runAt(a.id, t);
      const techs = status === 'intervention' ? this.techniciansAt(seg, t) : [];
      const list = parked.get(a.id) ?? [];
      out.push({
        id: a.id,
        status,
        operator: run?.operator ?? seg?.detail?.operator ?? null,
        technicians: techs.length ? techs.map((x) => ({ name: x.name, since: x.since })) : null,
        stop_reason: seg && (seg.source === 'stop' || seg.source === 'intervention') ? seg.reason : null,
        line_stats: null,
        current_job_number: run?.job_number ?? null,
        queued_ofs: list.length ? list.slice(0, 8) : null,
        queued_total: list.length,
        pipeline_ofs: null,
        pipeline_total: 0,
        open_ticket: ticket !== null,
        open_ticket_id: ticket?.ticket_id ?? null,
        open_ticket_number: ticket?.ticket_number ?? null,
      });
    }
    return out;
  }

  /** Tudo o que o painel de detalhe mostra sobre UMA máquina no instante T. */
  machineAt(equipmentId: string, t: number, assets: ReplayAsset[]): MachineSnapshot {
    const tr = this.tracks.get(equipmentId);
    const seg = this.segmentAt(equipmentId, t);
    const asset = assets.find((a) => a.id === equipmentId);
    const ownStatus = seg?.status ?? 'idle';
    let status = ownStatus;
    let inheritedFrom: string | null = null;
    if (asset?.parent_equipment_id) {
      const pseg = this.segmentAt(asset.parent_equipment_id, t);
      if (pseg) { status = pseg.status; inheritedFrom = asset.parent_equipment_id; }
    }
    const hourly = this.productionByEquipment.get(equipmentId) ?? [];
    let pieces = 0, rejects = 0;
    for (const h of hourly) {
      // Só horas JÁ COMPLETAS entram no acumulado — a hora em curso seria
      // repartição inventada (o feed grava o total por hora, não por minuto).
      if (ms(h.hour) + HOUR_MS <= t) { pieces += h.count; rejects += h.reject_count; }
    }
    const run = this.runAt(equipmentId, t);
    return {
      equipmentId,
      machineId: tr?.machineId ?? null,
      segment: seg,
      status,
      ownStatus: inheritedFrom ? ownStatus : null,
      inheritedFrom,
      technicians: this.techniciansAt(seg, t),
      ticket: this.ticketAt(equipmentId, t),
      operator: run?.operator ?? seg?.detail?.operator ?? null,
      currentRun: run,
      parked: this.parkedByEquipment(t).get(equipmentId) ?? [],
      piecesSoFar: pieces,
      rejectsSoFar: rejects,
      hourly,
      events: (this.eventsByEquipment.get(equipmentId) ?? []).filter((e) => ms(e.ts) <= t),
    };
  }

  /** O percurso de UMA OF na janela e onde ela estava em T. */
  ofAt(jobOrderId: string, t: number): OfSnapshot | null {
    const runs = this.runsByOf.get(jobOrderId);
    if (!runs?.length) return null;
    const head = runs[runs.length - 1];
    let current: RunIndex | null = null;
    let last: RunIndex | null = null;
    let pieces = 0;
    for (const r of runs) {
      if (r.s > t) break;
      last = r;
      if (t < r.e) current = r;
      if (!r.carry_in) pieces += r.pieces;
    }
    const pit = (this.pitByOf.get(jobOrderId) ?? []).filter((p) => ms(p.ts) <= t);
    let onHand = this.pitMovedBefore.has(jobOrderId) ? 1 : 0;
    for (const p of pit) onHand += p.direction === 'out' ? -p.quantity : p.quantity;
    return {
      jobOrderId,
      jobNumber: head.job_number,
      productName: head.product_name,
      runs: runs.filter((r) => !r.carry_in),
      currentRun: current,
      lastRun: current ? null : last,
      inBuffer: onHand > 0,
      piecesSoFar: pieces,
      pitEvents: pit.map((p) => ({ ts: p.ts, direction: p.direction, quantity: p.quantity, components: p.components })),
    };
  }

  /** Todas as OFs que passaram pela janela (para o seletor do painel de OF). */
  allOfs(): { jobOrderId: string; jobNumber: string; productName: string | null }[] {
    const out: { jobOrderId: string; jobNumber: string; productName: string | null }[] = [];
    for (const [id, runs] of this.runsByOf) {
      if (runs.every((r) => r.carry_in)) continue;
      const head = runs[runs.length - 1];
      out.push({ jobOrderId: id, jobNumber: head.job_number, productName: head.product_name });
    }
    return out.sort((a, b) => a.jobNumber.localeCompare(b.jobNumber));
  }

  /** Marcadores da régua do tempo, já com a posição relativa (0–1) na janela. */
  markers(): { at: number; pos: number; kind: ReplayEvent['kind']; label: string | null; equipmentId: string | null }[] {
    const span = this.endMs - this.startMs;
    if (span <= 0) return [];
    return this.timeline.events
      .map((e) => {
        const at = ms(e.ts);
        return { at, pos: (at - this.startMs) / span, kind: e.kind, label: e.label, equipmentId: e.equipment_id };
      })
      .filter((m) => m.pos >= 0 && m.pos <= 1);
  }
}
