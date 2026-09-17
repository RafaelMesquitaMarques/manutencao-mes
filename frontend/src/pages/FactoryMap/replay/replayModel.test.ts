/**
 * Testes do modelo do Replay do Turno.
 *
 * O que se verifica é a fidelidade da reprodução: o estado num instante tem de
 * sair dos MESMOS intervalos que o backend reconstruiu, a herança de estado tem
 * de seguir a máquina-mãe como no modo ao vivo, e a fila de OFs parqueadas tem
 * de refletir o ledger de passagens (incluindo o que já tinha seguido para o
 * buffer). O overlay produzido é exatamente a forma que `applyStatus` consome.
 */
import { describe, it, expect } from 'vitest';
import { ReplayIndex } from './replayModel';
import type {
  ReplayRun, ReplaySegment, ReplayTimeline, ReplayTrack,
} from '../../../api/factoryReplay';

const T0 = Date.parse('2026-09-16T12:00:00Z');
const H = 3_600_000;
const iso = (at: number) => new Date(at).toISOString();

const seg = (
  from: number, to: number, status: string,
  extra: Partial<ReplaySegment> = {},
): ReplaySegment => ({
  start: iso(from), end: iso(to), status,
  reason: null, source: 'baseline', ref_id: null, detail: null, ...extra,
});

const track = (equipment_id: string, segments: ReplaySegment[], extra: Partial<ReplayTrack> = {}): ReplayTrack => ({
  equipment_id, machine_id: `m-${equipment_id}`, segments, ticket_spans: [], ...extra,
});

const run = (
  id: string, ofId: string, jobNumber: string, equipmentId: string,
  from: number, to: number | null, extra: Partial<ReplayRun> = {},
): ReplayRun => ({
  id, job_order_id: ofId, job_number: jobNumber, product_name: null, target_quantity: null,
  machine_id: `m-${equipmentId}`, equipment_id: equipmentId, department: null, operator: null,
  started_at: iso(from), ended_at: to === null ? null : iso(to),
  pieces: 0, rejects: 0, last_piece_at: null, carry_in: false, ...extra,
});

const timeline = (over: Partial<ReplayTimeline> = {}): ReplayTimeline => ({
  plant_id: 'p1', timezone: 'America/Toronto',
  start: iso(T0), end: iso(T0 + 8 * H), generated_at: iso(T0 + 8 * H),
  tracks: [], of_runs: [], pit_events: [], pit_moved_before: [], production: [], events: [],
  ...over,
});

const ASSETS = [
  { id: 'saw', parent_equipment_id: null, block_kind: 'beam_saw', subtype: null },
  { id: 'conv', parent_equipment_id: 'saw', block_kind: 'conveyor', subtype: 'Conveyor' },
  { id: 'edge', parent_equipment_id: null, block_kind: null, subtype: null },
];

describe('ReplayIndex — estado num instante', () => {
  const idx = new ReplayIndex(timeline({
    tracks: [
      track('saw', [
        seg(T0, T0 + 2 * H, 'running'),
        seg(T0 + 2 * H, T0 + 3 * H, 'stopped', { source: 'stop', reason: 'Bris de lame', ref_id: 's1' }),
        seg(T0 + 3 * H, T0 + 8 * H, 'running'),
      ]),
      track('conv', [seg(T0, T0 + 8 * H, 'running')]),
      track('edge', [seg(T0, T0 + 8 * H, 'running')]),
    ],
  }));

  it('devolve o segmento que cobre o instante, inclusive nas fronteiras', () => {
    const at = (h: number) => idx.overlayAt(T0 + h * H, ASSETS).find((o) => o.id === 'saw')!;
    expect(at(1).status).toBe('running');
    expect(at(2).status).toBe('stopped');          // início do segmento é inclusivo
    expect(at(2.5).status).toBe('stopped');
    expect(at(3).status).toBe('running');          // fim é exclusivo
    expect(at(2.5).stop_reason).toBe('Bris de lame');
  });

  it('prende o cursor nas extremidades da janela', () => {
    const before = idx.overlayAt(T0 - 5 * H, ASSETS).find((o) => o.id === 'saw')!;
    const after = idx.overlayAt(T0 + 50 * H, ASSETS).find((o) => o.id === 'saw')!;
    expect(before.status).toBe('running');
    expect(after.status).toBe('running');
  });

  it('o transportador herda o estado da máquina-mãe, como no modo ao vivo', () => {
    const at = (h: number) => idx.overlayAt(T0 + h * H, ASSETS).find((o) => o.id === 'conv')!;
    expect(at(1).status).toBe('running');
    expect(at(2.5).status).toBe('stopped');        // a serra parou → o transportador cai com ela
    expect(at(4).status).toBe('running');
    // Um ativo sem pai mantém o seu próprio estado.
    expect(idx.overlayAt(T0 + 2.5 * H, ASSETS).find((o) => o.id === 'edge')!.status).toBe('running');
  });

  it('não inventa estado para ativos sem histórico MES', () => {
    const bare = new ReplayIndex(timeline({
      tracks: [track('hvac', [seg(T0, T0 + 8 * H, 'idle', { source: 'no_history' })], { machine_id: null })],
    }));
    const o = bare.overlayAt(T0 + 4 * H, [{ id: 'hvac', parent_equipment_id: null, block_kind: null, subtype: null }]);
    expect(o[0].status).toBe('idle');
    expect(o[0].current_job_number).toBeNull();
  });
});

describe('ReplayIndex — técnicos e ticket no instante', () => {
  const idx = new ReplayIndex(timeline({
    tracks: [track('saw', [
      seg(T0, T0 + 1 * H, 'running'),
      seg(T0 + 1 * H, T0 + 2 * H, 'intervention', {
        source: 'intervention', reason: 'Mécanique',
        detail: {
          technicians: [
            { name: 'Ana', since: iso(T0 + 1 * H), until: iso(T0 + 1.5 * H) },
            { name: 'Bo', since: iso(T0 + 1.5 * H), until: null },
          ],
        },
      }),
      seg(T0 + 2 * H, T0 + 8 * H, 'running'),
    ], {
      ticket_spans: [{ start: iso(T0 + 0.5 * H), end: iso(T0 + 3 * H), ticket_id: 't1', ticket_number: 'TK-9' }],
    })],
  }));
  const at = (h: number) => idx.overlayAt(T0 + h * H, ASSETS).find((o) => o.id === 'saw')!;

  it('mostra apenas os técnicos presentes naquele minuto', () => {
    expect(at(1.2).technicians?.map((x) => x.name)).toEqual(['Ana']);
    expect(at(1.8).technicians?.map((x) => x.name)).toEqual(['Bo']);
    expect(at(0.5).technicians).toBeNull();        // fora da intervenção
  });

  it('o badge de ticket é exato mesmo quando outra camada ganha a cor', () => {
    expect(at(1.2).status).toBe('intervention');   // roxo ganha
    expect(at(1.2).open_ticket).toBe(true);        // …e o ticket continua aberto
    expect(at(1.2).open_ticket_number).toBe('TK-9');
    expect(at(4).open_ticket).toBe(false);
  });
});

describe('ReplayIndex — OFs no tempo', () => {
  //   OF-A: serra 12:00→14:00, depois edge 15:00→(aberta)
  //   OF-B: serra 14:00→(aberta)
  //   OF-C: passagem de arrasto fechada antes da janela (já estava parqueada)
  const idx = new ReplayIndex(timeline({
    tracks: [track('saw', [seg(T0, T0 + 8 * H, 'running')]), track('edge', [seg(T0, T0 + 8 * H, 'running')])],
    of_runs: [
      run('r1', 'of-a', 'OF-A', 'saw', T0, T0 + 2 * H, { pieces: 12 }),
      run('r2', 'of-a', 'OF-A', 'edge', T0 + 3 * H, null, { pieces: 4 }),
      run('r3', 'of-b', 'OF-B', 'saw', T0 + 2 * H, null, { pieces: 7 }),
      run('r0', 'of-c', 'OF-C', 'saw', T0 - 5 * H, T0 - 4 * H, { carry_in: true }),
    ],
  }));
  const saw = (h: number) => idx.overlayAt(T0 + h * H, ASSETS).find((o) => o.id === 'saw')!;

  it('a OF carregada vem da passagem aberta naquele instante', () => {
    expect(saw(1).current_job_number).toBe('OF-A');
    expect(saw(3).current_job_number).toBe('OF-B');
    const edgeAt4 = idx.overlayAt(T0 + 4 * H, ASSETS).find((o) => o.id === 'edge')!;
    expect(edgeAt4.current_job_number).toBe('OF-A');
  });

  it('uma OF cuja passagem fechou fica parqueada à saída, com a idade certa', () => {
    // Às 14:30 a OF-A já saiu da serra (14:00) e ainda não foi scaneada no edge (15:00).
    const s = saw(2.5);
    const parked = s.queued_ofs!.map((p) => p.job_number);
    expect(parked).toContain('OF-A');
    expect(s.queued_ofs!.find((p) => p.job_number === 'OF-A')!.age_minutes).toBe(30);
    // Às 15:30 já está no edge → sai da fila da serra.
    expect((saw(3.5).queued_ofs ?? []).map((p) => p.job_number)).not.toContain('OF-A');
  });

  it('a fila de arrasto conta o que já estava parqueado quando a janela começou', () => {
    expect(saw(0).queued_ofs!.map((p) => p.job_number)).toContain('OF-C');
    expect(saw(0).queued_total).toBeGreaterThan(0);
  });

  it('uma OF que já entrou no buffer deixa de contar como parqueada', () => {
    const moved = new ReplayIndex(timeline({
      tracks: [track('saw', [seg(T0, T0 + 8 * H, 'running')])],
      of_runs: [run('r1', 'of-a', 'OF-A', 'saw', T0, T0 + 1 * H)],
      pit_events: [{
        ts: iso(T0 + 1.5 * H), job_order_id: 'of-a', job_number: 'OF-A',
        direction: 'in', quantity: 3, components: ['PAN'], destination_machine_id: null,
      }],
    }));
    const q = (h: number) => moved.overlayAt(T0 + h * H, ASSETS).find((o) => o.id === 'saw')!.queued_total;
    expect(q(1.2)).toBe(1);   // já saiu da serra, ainda não chegou ao buffer
    expect(q(2)).toBe(0);     // entrou no buffer → seguiu em frente
  });

  it('o percurso da OF distingue passado, presente e futuro do cursor', () => {
    const a1 = idx.ofAt('of-a', T0 + 1 * H)!;
    expect(a1.currentRun?.equipment_id).toBe('saw');
    expect(a1.runs).toHaveLength(2);
    expect(a1.piecesSoFar).toBe(12);          // só a passagem já iniciada conta

    const a2 = idx.ofAt('of-a', T0 + 2.5 * H)!;
    expect(a2.currentRun).toBeNull();         // entre duas passagens: parqueada
    expect(a2.lastRun?.equipment_id).toBe('saw');

    const a3 = idx.ofAt('of-a', T0 + 4 * H)!;
    expect(a3.currentRun?.equipment_id).toBe('edge');
    expect(a3.piecesSoFar).toBe(16);
  });

  it('reconhece a OF dentro do buffer pelo saldo do ledger', () => {
    const buf = new ReplayIndex(timeline({
      of_runs: [run('r1', 'of-a', 'OF-A', 'saw', T0, T0 + 1 * H)],
      pit_events: [
        { ts: iso(T0 + 2 * H), job_order_id: 'of-a', job_number: 'OF-A', direction: 'in', quantity: 5, components: [], destination_machine_id: null },
        { ts: iso(T0 + 5 * H), job_order_id: 'of-a', job_number: 'OF-A', direction: 'out', quantity: 5, components: [], destination_machine_id: null },
      ],
    }));
    expect(buf.ofAt('of-a', T0 + 1 * H)!.inBuffer).toBe(false);
    expect(buf.ofAt('of-a', T0 + 3 * H)!.inBuffer).toBe(true);
    expect(buf.ofAt('of-a', T0 + 6 * H)!.inBuffer).toBe(false);
  });
});

describe('ReplayIndex — produção acumulada', () => {
  const idx = new ReplayIndex(timeline({
    tracks: [track('saw', [seg(T0, T0 + 8 * H, 'running')])],
    production: [
      { machine_id: 'm-saw', equipment_id: 'saw', hour: iso(T0), count: 10, reject_count: 1, job_number: null },
      { machine_id: 'm-saw', equipment_id: 'saw', hour: iso(T0 + 1 * H), count: 20, reject_count: 2, job_number: null },
    ],
  }));

  it('só soma horas JÁ COMPLETAS — nunca reparte a hora em curso', () => {
    expect(idx.machineAt('saw', T0 + 0.5 * H, ASSETS).piecesSoFar).toBe(0);
    expect(idx.machineAt('saw', T0 + 1 * H, ASSETS).piecesSoFar).toBe(10);
    expect(idx.machineAt('saw', T0 + 1.5 * H, ASSETS).piecesSoFar).toBe(10);
    expect(idx.machineAt('saw', T0 + 2 * H, ASSETS).piecesSoFar).toBe(30);
    expect(idx.machineAt('saw', T0 + 2 * H, ASSETS).rejectsSoFar).toBe(3);
  });
});

describe('ReplayIndex — marcadores da régua', () => {
  it('posiciona cada evento entre 0 e 1 e descarta o que cai fora da janela', () => {
    const idx = new ReplayIndex(timeline({
      events: [
        { ts: iso(T0 + 2 * H), kind: 'alert', machine_id: 'm-saw', equipment_id: 'saw', label: 'AL-1', ref_id: 'a1' },
        { ts: iso(T0 + 20 * H), kind: 'reject', machine_id: 'm-saw', equipment_id: 'saw', label: null, ref_id: 'r1' },
      ],
    }));
    const m = idx.markers();
    expect(m).toHaveLength(1);
    expect(m[0].pos).toBeCloseTo(0.25, 5);
  });
});
