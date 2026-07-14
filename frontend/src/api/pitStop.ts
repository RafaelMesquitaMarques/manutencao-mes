import api from './axios';

// ── Pit Stop (buffer fabrication → assemblage) ────────────────────────────────
// Read model polled by the factory map (~15 s, view mode, only when the plant
// has a block_kind='pit_stop' zone). Everything is derived server-side from the
// movement ledger + BOM — see backend app/services/pit_stop_service.py.

export interface PitStopComponent {
  code: string;
  label: string | null;
  category: string | null;     // PitStopCategory.name → colour of the stack layer
  required: number;
  received: number;            // cumulative Σ in (completeness basis)
  on_hand: number;             // Σ in − Σ out (physical presence / stack height)
  missing: number;
  in_bom: boolean;             // false → received outside the BOM (flagged)
}

export interface PitStopPosition {
  code: string;                // raw SAP/HANA bin code
  lane: number | null;         // parsed from the assumed L##-P## format (null = unknown)
  slot: number | null;
}

// Derived state of an OF inside the buffer.
export type PitStopOfStateKind =
  | 'awaiting' | 'complete' | 'released' | 'hold' | 'quality' | 'rework' | 'cancelled';

export interface PitStopOf {
  job_order_id: string;
  job_number: string;
  product_name: string | null;
  family: 'cg' | 'sg';               // case goods vs soft goods (assumed rule: BOM soft categories)
  equivalent_units: number;          // target_quantity × eu_per_unit (1 EU = 100 s of line time)
  state: PitStopOfStateKind;
  hold_kind: 'hold' | 'quality' | 'rework' | null;
  hold_reason: string | null;
  late: boolean;
  completeness_pct: number | null;   // null = OF has no BOM yet
  in_full: boolean;
  priority: number | null;           // manual for now (lower = release first)
  destination_machine_id: string | null;
  destination_name: string | null;
  positions: PitStopPosition[];      // most recent first — first = primary stack position
  on_hand_total: number;
  first_in_at: string | null;
  age_minutes: number | null;
  released_at: string | null;
  scheduled_date: string | null;
  components: PitStopComponent[];
}

// One availability band of the OTIF PIT table (mirrors the client's report):
// EU available split CG/SG, OTIF %, CG OF count.
export interface PitStopOtifBand {
  cg_eu: number;                     // Σ equivalent units of the CG OFs in the band
  sg_eu: number;                     //   idem soft goods
  otif_pct: number | null;           // % of DUE OFs (scheduled ≤ today) reaching the band; null = none due
  cg_ofs: number;                    // number of CG OFs in the band
}

export interface PitStopKpis {
  total: number;
  in_full: number;
  almost: number;                    // ≥90 % but not in full (OTIF indicator)
  awaiting: number;
  on_hold: number;
  released: number;
  late: number;
  oldest_job_number: string | null;
  oldest_age_minutes: number | null;
  avg_age_minutes: number | null;
  otif: {
    full: PitStopOtifBand;           // OFs 100 % in full
    ge90: PitStopOtifBand;           // OFs ≥90 % — cumulative (includes full)
  };
}

export interface PitStopConfig {
  lanes: number;                     // 41 roller lanes
  lane_length_ft: number;            // 44 ft
  slots_per_lane: number;
  late_after_hours: number;
}

export interface PitStopState {
  plant_id: string;
  equipment_id: string;              // the block_kind='pit_stop' Equipment row
  config: PitStopConfig;
  categories: { name: string; color: string }[];
  ofs: PitStopOf[];
  kpis: PitStopKpis;
  generated_at: string;
}

// 404 = plant has no pit stop configured → caller treats as null.
export const fetchPitStopState = async (plantId: string): Promise<PitStopState | null> => {
  try {
    const { data } = await api.get<PitStopState>(`/api/pit-stop/${plantId}/state`);
    return data;
  } catch (e) {
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 404) return null;
    throw e;
  }
};

export interface PitStopOfPatch {
  priority?: number | null;
  hold_kind?: 'hold' | 'quality' | 'rework' | null;
  hold_reason?: string | null;
  released?: boolean;
}

export const patchPitStopOf = async (jobOrderId: string, patch: PitStopOfPatch): Promise<void> => {
  await api.patch(`/api/pit-stop/of/${jobOrderId}`, patch);
};
