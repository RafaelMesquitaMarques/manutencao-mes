import { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ReactFlow, Background, Controls, MiniMap, NodeResizer,
  useNodesState, type Node, type NodeProps, type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Map as MapIcon, Pencil, Eye, Upload, RefreshCw, Image as ImageIcon,
  Camera, Wrench, RotateCw, Trash2, X, Plus, ExternalLink, Box, Boxes, Maximize2, Minimize2, Move,
  Search, ChevronDown, ChevronUp, Magnet, RotateCcw,
} from 'lucide-react';
import api from '../../api/axios';
import { useTranslation } from 'react-i18next';
import { STATUS_HEX as STATUS_COLORS, STATUS_LABEL as STATUS_LABELS } from '../../utils/statusColors';
import { initials } from '../../utils/initials';
import { uploadFile } from '../../api/uploads';
import {
  fetchFactoryMap, saveMachineLayout, saveFloorPlan, createView, updateView, deleteView,
  fetchPlantWeather, fetchMapSensors,
  type MapMachine, type MapProp, type MapView, type MapSensor, type PlantWeather,
  type MachineLayout, type PropPatch,
} from '../../api/factoryMap';
import { fetchDepartments } from '../../api/departments';
import { fetchKPISummary } from '../../api/workOrders';
import { fetchJobOrders } from '../../api/jobOrders';
import { fetchPitStopState, patchPitStopOf, type PitStopCategory, type PitStopOf, type PitStopState } from '../../api/pitStop';

// Furniture-family accents — mirror CG_ACCENT / SG_ACCENT in Factory3D so the 2D
// legend and the 3D areas read as the same case-goods (amber) / soft-goods (violet) split.
const PIT_CG_ACCENT = '#f59e0b';
const PIT_SG_ACCENT = '#8b5cf6';
import { COMPLETENESS_HEX, OF_LATE_HEX, completenessColor, isDueToday, ofPlateColor, ofStateColor } from '../../utils/pitStopColors';
import type { KPISummary, JobOrder } from '../../types';
import Factory3D, { PROP_CATALOG, ORBIT_MARGIN, type M3D, type P3D, type S3D, type Z3D, type MachinePoint, type Commit, type PropCommit, type SensorCommit, type ZoneCommit3D, type FocusTarget, type CameraPose, type PlacementSpec, type MultiSelection } from './Factory3D';
import { toUnit, tempColor, weatherIcon } from '../../utils/temperature';
import { useAuthStore } from '../../store/authStore';
import { usePlantStore } from '../../store/plantStore';
import { useEditorStore } from './editorStore';
import { useMapEditor, type GroupMove } from './useMapEditor';
import MapEditorPanel, { type PanelSelection } from './MapEditorPanel';
import SaveStatusPill from './SaveStatusPill';
import { BLOCK_KINDS } from './catalog';

interface Plant { id: string; code: string; name: string; }

// Reserved region key for the whole-plant "Overview" pose override, stored in the
// FactoryView.department column (real department names never collide with this).
const OVERVIEW_KEY = '__overview__';

// How an item is drawn in 3D. 'auto' keeps the current behaviour (model/photo/box);
// 'cobot' renders the animated arm. New procedural kinds get added here.
// A machine's orbit rectangle (map px): explicit orbit_* if set, else footprint + margin.
function orbitRectFor(m: { pos_x: number | null; pos_y: number | null; pos_w: number | null; pos_h: number | null; orbit_x: number | null; orbit_y: number | null; orbit_w: number | null; orbit_h: number | null }) {
  const px = m.pos_x ?? 0, py = m.pos_y ?? 0, pw = m.pos_w ?? 152, ph = m.pos_h ?? 64;
  return {
    x: m.orbit_x ?? (px - ORBIT_MARGIN),
    y: m.orbit_y ?? (py - ORBIT_MARGIN),
    w: m.orbit_w ?? (pw + 2 * ORBIT_MARGIN),
    h: m.orbit_h ?? (ph + 2 * ORBIT_MARGIN),
  };
}

// A cobot/conveyor "orbits" a host machine and auto-links to it by position.
// Mirror the backend rule (factory_map.py): match by block_kind OR subtype text,
// because seeded cobots carry subtype='Cobot' with block_kind still null.
function isOrbitChild(m: { block_kind: string | null; subtype: string | null }): boolean {
  const bk = (m.block_kind ?? '').toLowerCase();
  const st = (m.subtype ?? '').toLowerCase();
  return bk === 'cobot' || bk === 'conveyor' || st.includes('cobot') || st.includes('conveyor');
}

function rectContains(r: { x: number; y: number; w: number; h: number }, cx: number, cy: number): boolean {
  return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
}

// Self-heal the saved layout against the orbit invariants, returning the patches to persist
// (and mutating `machines` in place so the very next render already shows the healed state):
//  1. An orbit must surround its own machine — if the machine drifted outside it (e.g. the orbit
//     was dragged away under the old behaviour), drop the explicit orbit_* so it re-hugs the machine.
//  2. A cobot/conveyor's parent_equipment_id must match the orbit it currently sits in (nearest centre).
function healOrbitLayout(machines: MapMachine[]): Array<{ id: string; patch: MachineLayout }> {
  const patches: Array<{ id: string; patch: MachineLayout }> = [];
  const hosts = machines.filter((m) => (m.asset_type ?? 'production') === 'production' && m.pos_x != null && m.pos_y != null);

  // 1. re-anchor orbits that drifted fully off their machine (the old "drag orbit away" bug).
  //    Only reset when the machine footprint no longer overlaps the orbit at all, so intentional
  //    asymmetric shapes that still cover the machine are preserved.
  for (const h of hosts) {
    if (h.orbit_x == null && h.orbit_y == null && h.orbit_w == null && h.orbit_h == null) continue;
    const r = orbitRectFor(h);
    const px = h.pos_x ?? 0, py = h.pos_y ?? 0, pw = h.pos_w ?? 152, ph = h.pos_h ?? 64;
    const overlaps = px < r.x + r.w && px + pw > r.x && py < r.y + r.h && py + ph > r.y;
    if (!overlaps) {
      h.orbit_x = null; h.orbit_y = null; h.orbit_w = null; h.orbit_h = null;
      patches.push({ id: h.id, patch: { orbit_x: null, orbit_y: null, orbit_w: null, orbit_h: null } });
    }
  }

  // 2. fill in MISSING links: a cobot/conveyor with no parent that sits in an orbit gets linked.
  //    Conservative on purpose — never override or clear an existing parent, so manual choices
  //    (and deliberate unlinks) survive. Re-linking on geometry change is handled live by the
  //    drag/resize handlers; this pass only repairs the "never got linked" state.
  for (const c of machines) {
    if (!isOrbitChild(c) || c.parent_equipment_id != null || c.pos_x == null || c.pos_y == null) continue;
    const cx = c.pos_x + (c.pos_w ?? 152) / 2;
    const cy = c.pos_y + (c.pos_h ?? 64) / 2;
    let best: string | null = null, bestDist = Infinity;
    for (const h of hosts) {
      if (h.id === c.id) continue;
      const r = orbitRectFor(h);
      if (rectContains(r, cx, cy)) {
        const dist = (cx - (r.x + r.w / 2)) ** 2 + (cy - (r.y + r.h / 2)) ** 2;
        if (dist < bestDist) { bestDist = dist; best = h.id; }
      }
    }
    if (best != null) {
      c.parent_equipment_id = best;
      patches.push({ id: c.id, patch: { parent_equipment_id: best } });
    }
  }
  return patches;
}

type ResizeParams = { x: number; y: number; width: number; height: number };
type ZoneLite = { id: string; name: string; color: string };

// ── Group-drag bookkeeping ────────────────────────────────────────────────────
// A single drag can carry more than one node: a zone drags the machines inside it,
// and a Shift-selection drags every selected machine at once. We capture each
// carried node's start position so the whole group rides the same delta and every
// final position (machine + its orbit + zone) is persisted on drop.
type XY = { x: number; y: number };
type MachineDragItem = { id: string; mStart: XY; mSize: { w: number; h: number }; orbitId: string | null; oStart: XY; oSize: { w: number; h: number } };
type GroupDrag = {
  primaryId: string;
  moveMachineNodes: boolean;              // true → we move the machine NODES (zone container); false → React Flow already does (single / multi-select)
  startById: Map<string, XY>;             // start position of every carried node (delta = current − start, same for all)
  machines: MachineDragItem[];            // machines carried by the drag (position + orbit persisted on drop)
  zones: { nodeId: string; dbId: string; zStart: XY }[];   // zones carried by the drag (position persisted on drop)
  // 3D-only items with no 2D node (temperature sensors, decorative props). Two ways a zone carries them:
  //   • *Move* — the item sits INSIDE the zone → ride the same delta, keeping its relative position.
  //   • *Snap* — the item belongs to the zone by name/department but sits OUTSIDE → recall it onto the
  //     department's machine cluster (target in start coords, +delta applied on drop) so an orphan
  //     "Zone Assemblage" thermometer lands on the Assemblage machines instead of floating off alone.
  sensors: { id: string; sStart: XY }[];
  props: { id: string; pStart: XY }[];
  sensorSnaps: { id: string; target: XY }[];
  propSnaps: { id: string; target: XY }[];
};

// Buffer dwell time → compact human form ("3 h 05" / "42 min").
const fmtAgeMin = (m: number | null): string =>
  m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`;

// Distinct-ish colour per department name (stable hash → palette) for auto zones.
const ZONE_PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444'];
const ZONE_DEPT_PADDING = 28;   // px breathing room around a department's bounding box
function deptColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return ZONE_PALETTE[h % ZONE_PALETTE.length];
}

type MachineNodeData = { machine: MapMachine; editMode?: boolean; onResize?: (p: ResizeParams) => void; onPickPhoto?: (id: string) => void; onRotate?: (id: string) => void; onPickModel?: (id: string) => void; onSetKind?: (id: string, kind: string) => void };
type ZoneNodeData = { zone: ZoneLite; onResize?: (p: ResizeParams) => void; onDelete?: (id: string) => void };
type FloorPlanData = { url: string };

const iconBtn: React.CSSProperties = {
  width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(13,20,33,0.85)', border: '1px solid #374151', borderRadius: 6, color: '#cbd5e1', cursor: 'pointer',
};

// One technician pictogram: a little person silhouette with the tech's initials
// on the head. Rendered on a machine a technician is actively working (purple).
function TechBadge({ name, size = 30 }: { name: string; size?: number }) {
  const ini = initials(name) || '?';
  const purple = STATUS_COLORS.intervention;
  return (
    <svg viewBox="0 0 40 44" width={size} height={size * 1.1} aria-label={name}>
      {/* shoulders / body */}
      <path d="M3 44 C3 33 12.5 29.5 20 29.5 C27.5 29.5 37 33 37 44 Z"
            fill={purple} stroke="#0d1421" strokeWidth="1.5" />
      {/* head */}
      <circle cx="20" cy="13.5" r="12.5" fill={purple} stroke="#0d1421" strokeWidth="1.5" />
      {/* initials on the head */}
      <text x="20" y="14.5" textAnchor="middle" dominantBaseline="middle"
            fontSize={ini.length > 1 ? 11 : 13} fontWeight="700"
            fill="#ffffff" fontFamily="system-ui, sans-serif">{ini}</text>
    </svg>
  );
}

// All technicians on the machine, one pictogram each, overlapped as a face-pile
// in the corner (2 techs → 2 figures, 10 → 10). Each carries its own tooltip.
function TechBadges({ names }: { names: string[] }) {
  const size = names.length > 4 ? 22 : 28;
  const overlap = size * 0.42;
  return (
    <div style={{
      position: 'absolute', top: 3, right: 3, zIndex: 4, display: 'flex',
      flexDirection: 'row-reverse', pointerEvents: 'none',
      filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))',
    }}>
      {names.map((nm, i) => (
        <div key={`${nm}-${i}`} title={nm}
             style={{ marginRight: i === 0 ? 0 : -overlap, lineHeight: 0 }}>
          <TechBadge name={nm} size={size} />
        </div>
      ))}
    </div>
  );
}

// ── Custom nodes ────────────────────────────────────────────────────────────

// Pit Stop buffer state for the 2D node (the page polls it in view mode and
// provides it around <ReactFlow>; null = edit mode / no data yet).
const PitStop2DCtx = createContext<PitStopState | null>(null);

/** Occupancy grid inside the 2D Pit Stop area — same mapping as the 3D zone:
 * lane → row (top = lane 1), slot → column, OFs sharing a bin split the cell
 * side-by-side, colour = the completeness semaphore of the base plate, orange
 * outline = late / due today. Pure SVG, stretches to the node footprint. */
function PitStopMiniGrid({ state }: { state: PitStopState | null }) {
  const lanes = state?.config.lanes ?? 41;
  const slots = state?.config.slots_per_lane ?? 8;
  // CG/SG split: FIRST `sgLanes` rows = soft-goods area (top band), rest = case goods.
  const sgLanes = Math.min(Math.max(state?.config.sg_lanes ?? 7, 0), lanes - 1);
  const cgLanes = lanes - sgLanes;
  const cells = new Map<string, PitStopOf[]>();
  for (const of of state?.ofs ?? []) {
    const p = of.positions.find((q) => q.lane != null && q.slot != null);
    if (!p) continue;
    const lane = Math.min(Math.max(p.lane!, 1), lanes);
    const slot = Math.min(Math.max(p.slot!, 1), slots);
    const key = `${lane}-${slot}`;
    const g = cells.get(key);
    if (g) g.push(of); else cells.set(key, [of]);
  }
  const CW = 10;                                        // cell unit in viewBox space
  return (
    <svg viewBox={`0 0 ${slots * CW} ${lanes * CW}`} preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 2, width: 'calc(100% - 4px)', height: 'calc(100% - 4px)' }}>
      {/* family area bands: soft goods (top = first lanes) vs case goods (bottom) */}
      {sgLanes > 0 && (
        <rect x={0} y={0} width={slots * CW} height={sgLanes * CW} fill={`${PIT_SG_ACCENT}1f`} />
      )}
      <rect x={0} y={sgLanes * CW} width={slots * CW} height={cgLanes * CW} fill={`${PIT_CG_ACCENT}12`} />
      {Array.from({ length: lanes + 1 }, (_, i) => (
        <line key={`l${i}`} x1={0} x2={slots * CW} y1={i * CW} y2={i * CW}
          stroke="rgba(129,140,248,0.16)" strokeWidth={0.5} />
      ))}
      {Array.from({ length: slots + 1 }, (_, i) => (
        <line key={`s${i}`} x1={i * CW} x2={i * CW} y1={0} y2={lanes * CW}
          stroke="rgba(129,140,248,0.09)" strokeWidth={0.5} />
      ))}
      {sgLanes > 0 && (
        <line x1={0} x2={slots * CW} y1={sgLanes * CW} y2={sgLanes * CW}
          stroke={PIT_SG_ACCENT} strokeWidth={1.4} strokeDasharray="3 2" />
      )}
      {[...cells.entries()].map(([key, group]) => {
        const [lane, slot] = key.split('-').map(Number);
        const gw = CW / group.length;                   // berth split, like the 3D
        return group.map((of, i) => {
          const late = of.late || isDueToday(of.scheduled_date);
          return (
            <rect key={of.job_order_id}
              x={(slot - 1) * CW + i * gw + 0.7} y={(lane - 1) * CW + 1}
              width={Math.max(gw - 1.4, 1.2)} height={CW - 2} rx={1}
              fill={ofPlateColor(of.state, of.completeness_pct, of.in_full)}
              stroke={late ? OF_LATE_HEX : 'none'} strokeWidth={late ? 1.1 : 0}>
              <title>{`${of.job_number} · ${of.completeness_pct != null ? `${Math.round(of.completeness_pct)} %` : '—'}`}</title>
            </rect>
          );
        });
      })}
    </svg>
  );
}

function MachineNode({ data, selected, width, height }: NodeProps) {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || 'en').slice(0, 2);
  const d = data as MachineNodeData;
  const m = d.machine;
  const color = STATUS_COLORS[m.status] ?? STATUS_COLORS.idle;
  // Pit Stop buffer → drawn as an AREA (zone-styled frame + occupancy grid),
  // not a status-coloured machine tile: it's a buffer, not a machine.
  const isPit = (m.block_kind ?? '') === 'pit_stop';
  const pitState = useContext(PitStop2DCtx);
  const rot = m.rotation_deg ?? 0;
  // Only the shape layer rotates. Labels/badges/controls live on a separate
  // unrotated layer sized to the rotated shape's bounding box, so text always
  // reads upright (the layer matches the node box exactly at 0°/180°).
  const w = width ?? m.pos_w ?? 152;
  const h = height ?? m.pos_h ?? 64;
  const rad = (rot * Math.PI) / 180;
  const bw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
  const bh = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
  return (
    <>
      {/* Orbit — drop a cobot/conveyor inside to auto-link it to this machine (Edit only) */}
      {d.editMode && (m.asset_type ?? 'production') === 'production' && (
        <div style={{
          position: 'absolute', left: -ORBIT_MARGIN, top: -ORBIT_MARGIN, right: -ORBIT_MARGIN, bottom: -ORBIT_MARGIN,
          border: '1px dashed rgba(99,102,241,0.55)', background: 'rgba(99,102,241,0.08)', borderRadius: 14,
          pointerEvents: 'none', zIndex: -1,
        }} />
      )}
      <NodeResizer isVisible={!!selected} minWidth={96} minHeight={46} onResizeEnd={(_, p) => d.onResize?.(p)}
        lineStyle={{ borderColor: '#3b82f6' }} handleStyle={{ width: 8, height: 8, background: '#3b82f6', borderRadius: 2 }} />
      {/* Shape layer — the only part that rotates */}
      <div style={{
        position: 'absolute', inset: 0, boxSizing: 'border-box',
        border: isPit ? '1.5px dashed #818cf8' : `2px solid ${color}`, borderRadius: isPit ? 10 : 8,
        background: isPit ? 'rgba(99,102,241,0.06)' : '#0d1421', boxShadow: selected ? '0 0 0 2px #3b82f6' : 'none',
        overflow: 'hidden', transform: rot ? `rotate(${rot}deg)` : undefined,
      }}>
        {isPit ? (
          <PitStopMiniGrid state={pitState} />
        ) : (
          <>
            {m.icon_url && <img src={m.icon_url} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
            {/* status-coloured tint so the whole tile reads green/amber/red at a glance */}
            <div style={{ position: 'absolute', inset: 0, background: color, opacity: 0.2, pointerEvents: 'none' }} />
          </>
        )}
      </div>

      {/* Content layer — never rotates, so labels stay upright */}
      <div style={{
        position: 'absolute', left: (w - bw) / 2, top: (h - bh) / 2, width: bw, height: bh,
        color: '#e5e7eb', borderRadius: 8, overflow: 'hidden',
      }}>
        {m.open_ticket && (
          <span title={`${t('factoryMap.openTicket')} ${m.open_ticket_number ?? ''}`} style={{ position: 'absolute', top: 4, left: 4, width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f59e0b', color: '#3a2a06', borderRadius: 6, zIndex: 2 }}>
            <Wrench size={12} />
          </span>
        )}

        {/* Technician pictograms — one per tech actively working (purple). Hidden
            while selected so they don't sit under the edit controls. */}
        {!selected && m.status === 'intervention' && m.technicians && m.technicians.length > 0 && (
          <TechBadges names={m.technicians.map((tc) => tc.name)} />
        )}

        {isPit ? (
          <>
            {/* zone-style label, like the department areas */}
            <span style={{ position: 'absolute', top: 6, left: 8, fontSize: 12, fontWeight: 600, color: '#a5b4fc', background: 'rgba(13,20,33,0.75)', padding: '1px 6px', borderRadius: 4 }}>
              {m.name}
            </span>
            {pitState && (
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, background: 'rgba(13,20,33,0.82)', padding: '3px 8px', display: 'flex', gap: 10, fontSize: 11, fontWeight: 600, color: '#c7d2fe', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                <span>{pitState.kpis.total} OF</span>
                <span style={{ color: '#4ade80' }}>✓ {pitState.kpis.in_full}</span>
                {pitState.kpis.otif?.full?.otif_pct != null && <span>OTIF {pitState.kpis.otif.full.otif_pct} %</span>}
                {pitState.kpis.late > 0 && <span style={{ color: '#fb923c' }}>⚠ {pitState.kpis.late}</span>}
              </div>
            )}
          </>
        ) : m.icon_url ? (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, background: 'rgba(13,20,33,0.82)', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</span>
          </div>
        ) : (
          <div style={{ padding: '8px 10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</span>
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {STATUS_LABELS[m.status]?.[lang as 'en' | 'fr' | 'es'] ?? m.status}{m.operator ? ` · ${m.operator}` : ''}
            </div>
          </div>
        )}

        {selected && (
          <div style={{ position: 'absolute', top: 4, right: 4, display: 'flex', gap: 4, alignItems: 'center' }}>
            <select
              title={t('factoryMap.shape3d')}
              value={m.block_kind ?? 'auto'}
              onChange={(e) => { e.stopPropagation(); d.onSetKind?.(m.id, e.target.value); }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              style={{ ...iconBtn, width: 'auto', padding: '0 4px', fontSize: 11 }}
            >
              {BLOCK_KINDS.map((k) => <option key={k} value={k}>{t(`factoryMap.block_${k}`)}</option>)}
            </select>
            <button title={t('factoryMap.rotate15')} onClick={(e) => { e.stopPropagation(); d.onRotate?.(m.id); }} style={iconBtn}><RotateCw size={13} /></button>
            <button title={t('factoryMap.model3d')} onClick={(e) => { e.stopPropagation(); d.onPickModel?.(m.id); }} style={iconBtn}><Box size={13} /></button>
            <button title={t('factoryMap.setPhoto')} onClick={(e) => { e.stopPropagation(); d.onPickPhoto?.(m.id); }} style={iconBtn}><Camera size={13} /></button>
          </div>
        )}
      </div>
    </>
  );
}

function ZoneNode({ data, selected }: NodeProps) {
  const { t } = useTranslation();
  const d = data as ZoneNodeData;
  const z = d.zone;
  return (
    <>
      <NodeResizer isVisible={!!selected} minWidth={80} minHeight={60} onResizeEnd={(_, p) => d.onResize?.(p)}
        lineStyle={{ borderColor: z.color }} handleStyle={{ width: 8, height: 8, background: z.color, borderRadius: 2 }} />
      <div
        style={{ width: '100%', height: '100%', boxSizing: 'border-box', border: `1.5px dashed ${z.color}`, borderRadius: 10, background: `${z.color}14`, position: 'relative' }}
      >
        <span style={{ position: 'absolute', top: 6, left: 8, fontSize: 12, fontWeight: 600, color: z.color, background: 'rgba(13,20,33,0.7)', padding: '1px 6px', borderRadius: 4 }}>{z.name}</span>
        {selected && (
          <button title={t('factoryMap.deleteZone')} onClick={(e) => { e.stopPropagation(); d.onDelete?.(z.id); }} style={{ ...iconBtn, position: 'absolute', top: 4, right: 4 }}><Trash2 size={13} /></button>
        )}
      </div>
    </>
  );
}

function FloorPlanNode({ data }: NodeProps) {
  const url = (data as FloorPlanData).url;
  return <img src={url} alt="floor plan" draggable={false} style={{ width: 1600, maxWidth: 'none', opacity: 0.85, pointerEvents: 'none', userSelect: 'none' }} />;
}

type OrbitNodeData = { machineId: string; machineName: string; onResize?: (p: ResizeParams) => void };
// Resizable "orbit" around a machine — drop a cobot/conveyor inside to auto-link it.
function OrbitNode({ data, selected }: NodeProps) {
  const d = data as OrbitNodeData;
  return (
    <>
      <NodeResizer isVisible={!!selected} minWidth={80} minHeight={80} onResizeEnd={(_, p) => d.onResize?.(p)}
        lineStyle={{ borderColor: '#6366f1' }} handleStyle={{ width: 8, height: 8, background: '#6366f1', borderRadius: 2 }} />
      <div style={{
        width: '100%', height: '100%', boxSizing: 'border-box',
        border: '1px dashed rgba(99,102,241,0.6)', background: 'rgba(99,102,241,0.08)', borderRadius: 12,
      }}>
        <span style={{ position: 'absolute', top: 4, left: 8, fontSize: 10, color: 'rgba(165,180,252,0.9)' }}>orbit · {d.machineName}</span>
      </div>
    </>
  );
}

const nodeTypes = { machine: MachineNode, zone: ZoneNode, floorplan: FloorPlanNode, orbit: OrbitNode };

// ── Page ────────────────────────────────────────────────────────────────────
export default function FactoryMap() {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || 'en').slice(0, 2);
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [plantId, setPlantId] = useState<string>('');
  const [floorPlanUrl, setFloorPlanUrl] = useState<string | null>(null);
  // Efficiency-colour thresholds for the assembly-line TVs (plant-wide config).
  const [tvThresholds, setTvThresholds] = useState<{ green_from: number; amber_from: number } | undefined>(undefined);
  // The GLOBAL clock (Σ measured vs the plant's own global objective).
  const [globalStats, setGlobalStats] = useState<MapMachine['line_stats']>(null);
  const [unplaced, setUnplaced] = useState<MapMachine[]>([]);
  const [editMode, setEditMode] = useState(false);
  const [assetFilter, setAssetFilter] = useState<'production' | 'auxiliary' | 'all'>('production');
  const [mode3d, setMode3d] = useState(false);
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const focusNonce = useRef(0);
  const [views, setViews] = useState<MapView[]>([]);
  const [deptOptions, setDeptOptions] = useState<string[]>([]);   // registry departments (for linking views)
  const poseReaderRef = useRef<(() => CameraPose) | null>(null);
  const [isFull, setIsFull] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const [sel3d, setSel3d] = useState<string | null>(null);
  const [props, setProps] = useState<MapProp[]>([]);
  const [selProp, setSelProp] = useState<string | null>(null);
  // Temperature sensors + the badge state: the sensor the camera is nearest to
  // (null → show outdoor weather) and the plant's cached outdoor weather.
  const [sensors, setSensors] = useState<MapSensor[]>([]);
  const [selSensor, setSelSensor] = useState<string | null>(null);
  const [nearestSensorId, setNearestSensorId] = useState<string | null>(null);
  const [weather, setWeather] = useState<PlantWeather | null>(null);
  const tempUnit = useAuthStore((s) => s.user?.temp_unit ?? 'C');
  const can = useAuthStore((s) => s.can);
  // Pit Stop buffer — polled state (view mode, only when the plant has the zone),
  // the selected OF (side panel), the zone KPI panel, search and the map legend.
  const [pitStop, setPitStop] = useState<PitStopState | null>(null);
  const [pitStopOfId, setPitStopOfId] = useState<string | null>(null);
  const [pitStopZone, setPitStopZone] = useState(false);
  const [pitStopSearch, setPitStopSearch] = useState('');
  const [pitStopSearchMiss, setPitStopSearchMiss] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [transformMode, setTransformMode] = useState<'translate' | 'rotate' | 'scale'>('translate');
  const [unplacedSearch, setUnplacedSearch] = useState('');
  // Zone selected in the 3D editor (zones are React Flow nodes in 2D, floor areas in 3D).
  const [selZone3d, setSelZone3d] = useState<string | null>(null);
  // Click-to-place: the item riding the 3D ghost cursor (block from the palette
  // or an unplaced machine). Esc cancels; blocks stay armed for rapid stamping.
  const [placement, setPlacement] = useState<{ type: 'prop'; kind: string } | { type: 'machine'; m: MapMachine } | null>(null);
  const snap = useEditorStore((s) => s.snap);
  const setSnap = useEditorStore((s) => s.setSnap);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<MapMachine | null>(null);
  const [kpi, setKpi] = useState<KPISummary | null>(null);
  const [kpiLoading, setKpiLoading] = useState(false);
  // OF (Ordre de fabrication) panel — opened by clicking a conveyor tied to a machine.
  const [ofPanel, setOfPanel] = useState<{ machineId: string; name: string; role: string | null } | null>(null);
  const [ofList, setOfList] = useState<JobOrder[] | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const photoTargetRef = useRef<string | null>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const modelTargetRef = useRef<string | null>(null);
  const propModelTargetRef = useRef<string | null>(null);
  // auto-link-by-orbit, accessed via ref so the early drag/commit handlers always call the latest
  const autoLinkRef = useRef<(id: string, x: number, y: number, w: number, h: number) => void>(() => {});
  // relink the cobots/conveyors sitting in a host's orbit after that orbit's geometry changes
  const reconcileChildrenRef = useRef<(hostId: string, rect: { x: number; y: number; w: number; h: number }) => void>(() => {});
  const editModeRef = useRef(editMode);
  useEffect(() => { editModeRef.current = editMode; }, [editMode]);
  // latest nodes, for handlers that fire outside React's render closure (drag/resize commits)
  const nodesRef = useRef<Node[]>([]);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  // latest sensors/props — 3D-only items with no 2D node, carried when a zone drags over them
  const sensorsRef = useRef<MapSensor[]>([]);
  useEffect(() => { sensorsRef.current = sensors; }, [sensors]);
  const propsRef = useRef<MapProp[]>([]);
  useEffect(() => { propsRef.current = props; }, [props]);
  const unplacedRef = useRef<MapMachine[]>([]);
  useEffect(() => { unplacedRef.current = unplaced; }, [unplaced]);
  // a drag can carry a group along (a machine + its orbit, a zone + the machines it contains,
  // or a whole Shift-selection): capture every carried node's start position on drag start
  const dragRef = useRef<GroupDrag | null>(null);
  // reflect Edit/View: machine nodes get the flag; orbit rectangles only show in Edit
  useEffect(() => {
    setNodes((nds) => nds.map((n) => {
      if (n.type === 'machine') return { ...n, data: { ...n.data, editMode } };
      if (n.type === 'orbit') return { ...n, hidden: !editMode };
      return n;
    }));
  }, [editMode, setNodes]);

  // ── editor plumbing ──
  // Per-node callbacks fire before `editor` exists (node factories capture them),
  // so they reach it through a ref.
  const editorRef = useRef<ReturnType<typeof useMapEditor> | null>(null);

  // ── per-node action callbacks (stable) ──
  const pickPhoto = useCallback((id: string) => { photoTargetRef.current = id; photoInputRef.current?.click(); }, []);

  const onPhotoSelected = useCallback(async (file: File) => {
    const id = photoTargetRef.current;
    if (!id) return;
    try {
      const up = await uploadFile(file);
      editorRef.current?.patchMachine(id, { icon_url: up.url }, { label: 'photo' });
    } catch (e) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      window.alert(`${t('factoryMap.modelUploadFailed')}: ${msg ?? 'error'}`);
    }
  }, [t]);

  const pickModel = useCallback((id: string) => { propModelTargetRef.current = null; modelTargetRef.current = id; modelInputRef.current?.click(); }, []);
  const pickPropModel = useCallback((id: string) => { modelTargetRef.current = null; propModelTargetRef.current = id; modelInputRef.current?.click(); }, []);

  const onModelSelected = useCallback(async (file: File) => {
    const propId = propModelTargetRef.current;
    const id = modelTargetRef.current;
    if (!propId && !id) return;
    try {
      const up = await uploadFile(file);
      if (propId) {                                     // .glb for a decorative prop
        editorRef.current?.patchProp(propId, { model_url: up.url }, { label: 'model' });
        propModelTargetRef.current = null;
        return;
      }
      editorRef.current?.patchMachine(id!, { model_url: up.url }, { label: 'model' });
    } catch (e) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      window.alert(`${t('factoryMap.modelUploadFailed')}: ${msg ?? 'error'}`);
    }
  }, [t]);

  const setKind = useCallback((id: string, kind: string) => {
    editorRef.current?.patchMachine(id, { block_kind: kind === 'auto' ? null : kind }, { label: 'shape' });
  }, []);

  const rotateMachine = useCallback((id: string) => {
    const n = nodesRef.current.find((x) => x.id === id);
    if (!n) return;
    const deg = (((n.data as MachineNodeData).machine.rotation_deg ?? 0) + 15) % 360;
    editorRef.current?.patchMachine(id, { rotation_deg: deg }, { label: 'rotate' });
  }, []);

  const removeZone = useCallback((zoneId: string) => {
    setSelZone3d((z) => (z === zoneId ? null : z));
    editorRef.current?.deleteZoneTracked(zoneId);
  }, []);

  // ── node factories (shared by initial load and place/undo flows) ──
  const makeOrbitNode = useCallback((m: MapMachine): Node | null => {
    if ((m.asset_type ?? 'production') !== 'production') return null;
    const r = orbitRectFor(m);
    return {
      // An orbit belongs to its machine — never independently draggable (it would drift away).
      // Reshape it with the resize handles; it follows the machine when the machine is moved.
      id: `orbit-${m.id}`, type: 'orbit', position: { x: r.x, y: r.y }, width: r.w, height: r.h,
      zIndex: 0, hidden: !editModeRef.current, deletable: false, draggable: false,
      data: {
        machineId: m.id, machineName: m.name,
        onResize: (p: ResizeParams) => {
          const patch = { orbit_x: Math.round(p.x), orbit_y: Math.round(p.y), orbit_w: Math.round(p.width), orbit_h: Math.round(p.height) };
          editorRef.current?.patchMachine(m.id, patch, { label: 'orbit' });
          // a redrawn orbit may now cover (or release) cobots — relink them
          reconcileChildrenRef.current(m.id, { x: p.x, y: p.y, w: p.width, h: p.height });
        },
      },
    };
  }, []);

  const makeMachineNode = useCallback((m: MapMachine): Node => ({
    id: m.id, type: 'machine', position: { x: m.pos_x ?? 0, y: m.pos_y ?? 0 },
    width: m.pos_w ?? 152, height: m.pos_h ?? 64, zIndex: 1,
    data: {
      machine: m, editMode: editModeRef.current, onPickPhoto: pickPhoto, onRotate: rotateMachine, onPickModel: pickModel, onSetKind: setKind,
      onResize: (p: ResizeParams) => editorRef.current?.patchMachine(m.id, { pos_x: Math.round(p.x), pos_y: Math.round(p.y), pos_w: Math.round(p.width), pos_h: Math.round(p.height) }, { label: 'resize' }),
    },
  }), [pickPhoto, rotateMachine, pickModel, setKind]);

  // ── the editor: every mutation funnels through here (optimistic + tracked + undoable) ──
  // makeZoneNode is defined below (it needs removeZone) — reach it via ref.
  const makeZoneNodeRef = useRef<(z: { id: string; name: string; color: string; pos_x: number; pos_y: number; pos_w: number; pos_h: number }) => Node>(() => { throw new Error('makeZoneNode not ready'); });
  const editorIO = useMemo(() => ({
    getNodes: () => nodesRef.current,
    setNodes: (updater: (nds: Node[]) => Node[]) => setNodes(updater),
    getProps: () => propsRef.current,
    setProps: (updater: (ps: MapProp[]) => MapProp[]) => setProps(updater),
    getSensors: () => sensorsRef.current,
    setSensors: (updater: (ss: MapSensor[]) => MapSensor[]) => setSensors(updater),
    getUnplaced: () => unplacedRef.current,
    setUnplaced: (updater: (ms: MapMachine[]) => MapMachine[]) => setUnplaced(updater),
    makeMachineNode, makeOrbitNode,
    makeZoneNode: (z: { id: string; name: string; color: string; pos_x: number; pos_y: number; pos_w: number; pos_h: number }) => makeZoneNodeRef.current(z),
    onPropGone: (id: string) => setSelProp((cur) => (cur === id ? null : cur)),
    onMachineGone: (id: string) => { setSel3d((cur) => (cur === id ? null : cur)); setDetail((d) => (d?.id === id ? null : d)); },
  }), [setNodes, makeMachineNode, makeOrbitNode]);

  const editor = useMapEditor(editorIO, plantId);
  useEffect(() => { editorRef.current = editor; }, [editor]);

  const makeZoneNode = useCallback((z: { id: string; name: string; color: string; pos_x: number; pos_y: number; pos_w: number; pos_h: number }): Node => ({
    id: `zone-${z.id}`, type: 'zone', position: { x: z.pos_x, y: z.pos_y },
    width: z.pos_w, height: z.pos_h, zIndex: 0,
    data: {
      zone: { id: z.id, name: z.name, color: z.color },
      onDelete: removeZone,
      onResize: (p: ResizeParams) => editorRef.current?.patchZone(z.id, { pos_x: Math.round(p.x), pos_y: Math.round(p.y), pos_w: Math.round(p.width), pos_h: Math.round(p.height) }, { label: 'resize' }),
    },
  }), [removeZone]);
  useEffect(() => { makeZoneNodeRef.current = makeZoneNode; }, [makeZoneNode]);

  const buildNodes = useCallback((data: Awaited<ReturnType<typeof fetchFactoryMap>>): Node[] => {
    const out: Node[] = [];
    if (data.floor_plan_url) {
      out.push({ id: 'floorplan', type: 'floorplan', position: { x: 0, y: 0 }, data: { url: data.floor_plan_url }, draggable: false, selectable: false, deletable: false, zIndex: -1 });
    }
    for (const z of data.zones) out.push(makeZoneNode(z));
    for (const m of data.machines) {
      if (m.pos_x == null || m.pos_y == null) continue;
      const orbit = makeOrbitNode(m);
      if (orbit) out.push(orbit);
      out.push(makeMachineNode(m));
    }
    return out;
  }, [makeZoneNode, makeOrbitNode, makeMachineNode]);

  useEffect(() => {
    api.get<Plant[] | { items: Plant[] }>('/api/plants/')
      .then(({ data }) => {
        const list = Array.isArray(data) ? data : (data.items ?? []);
        // Follow the header's active plant; fall back to Saint-Jérôme (QS) first.
        const isSJ = (p: Plant) => p.code === 'QS' || /j[eé]r/i.test(p.name);
        const sorted = [...list].sort((a, b) => (isSJ(a) ? 0 : 1) - (isSJ(b) ? 0 : 1) || a.name.localeCompare(b.name));
        setPlants(sorted);
        const active = usePlantStore.getState().activePlantId;
        const preferred = (active && sorted.find((p) => p.id === active)) ? active : sorted[0]?.id;
        if (preferred) setPlantId((p) => p || preferred);
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true);
    try {
      const data = await fetchFactoryMap(id, assetFilter);
      setFloorPlanUrl(data.floor_plan_url);
      setTvThresholds(data.line_tv_thresholds);
      setGlobalStats(data.global_line_stats ?? null);
      // Enforce the orbit invariants once per edit-mode load: re-anchor drifted orbits and
      // link cobots to whatever orbit they sit in. Mutates data.machines so buildNodes renders
      // the healed state immediately; persists the diffs in the background. Edit-mode only —
      // viewers may lack machines:update and the WS reload would re-fire it pointlessly.
      if (editModeRef.current) {
        for (const { id: mid, patch } of healOrbitLayout(data.machines)) {
          saveMachineLayout(mid, patch).catch(() => {});
        }
      }
      setNodes(buildNodes(data));
      setUnplaced(data.machines.filter((m) => !m.placed));
      setProps(data.props ?? []);
      setSensors(data.sensors ?? []);
      setViews(data.views ?? []);
    } finally {
      setLoading(false);
    }
  }, [buildNodes, setNodes, assetFilter]);

  // Reload on plant change and on edit-mode toggle — entering edit mode triggers the orbit self-heal.
  useEffect(() => { if (plantId) load(plantId); }, [plantId, load, editMode]);

  // Registry departments (for linking a saved view to a department) — includes ones
  // with no machines yet (e.g. Edge/Coupe), which is exactly what linking needs.
  useEffect(() => {
    if (!plantId) return;
    fetchDepartments().then((ds) => setDeptOptions(ds.map((d) => d.name))).catch(() => setDeptOptions([]));
  }, [plantId]);

  useEffect(() => {
    if (editMode || !plantId) return;
    const t = setInterval(() => load(plantId), 30000);   // slow fallback; WS does the live push
    return () => clearInterval(t);
  }, [editMode, plantId, load]);

  const applyStatus = useCallback((list: Array<{ id: string; status: string; operator: string | null; technicians?: MapMachine['technicians']; stop_reason?: string | null; line_stats?: MapMachine['line_stats']; current_job_number?: string | null; queued_ofs?: MapMachine['queued_ofs']; queued_total?: number; pipeline_ofs?: MapMachine['pipeline_ofs']; pipeline_total?: number; open_ticket: boolean; open_ticket_id: string | null; open_ticket_number: string | null }>) => {
    const byId = new Map(list.map((s) => [s.id, s]));
    setNodes((nds) => {
      let changed = false;
      const next = nds.map((n) => {
        if (n.type !== 'machine') return n;
        const s = byId.get(n.id);
        if (!s) return n;
        const mm = (n.data as MachineNodeData).machine;
        // Keep the same node reference when the push carries no actual change —
        // the memoized 3D blocks then skip re-rendering the whole scene every 4 s.
        const same = mm.status === s.status && mm.operator === s.operator
          && mm.open_ticket === s.open_ticket && mm.open_ticket_id === s.open_ticket_id
          && mm.open_ticket_number === s.open_ticket_number
          && (mm.stop_reason ?? null) === (s.stop_reason ?? null)
          && (mm.current_job_number ?? null) === (s.current_job_number ?? null)
          && (mm.queued_total ?? 0) === (s.queued_total ?? 0)
          && (mm.pipeline_total ?? 0) === (s.pipeline_total ?? 0)
          && JSON.stringify(mm.technicians ?? null) === JSON.stringify(s.technicians ?? null)
          && JSON.stringify(mm.line_stats ?? null) === JSON.stringify(s.line_stats ?? null)
          && JSON.stringify(mm.queued_ofs ?? null) === JSON.stringify(s.queued_ofs ?? null)
          && JSON.stringify(mm.pipeline_ofs ?? null) === JSON.stringify(s.pipeline_ofs ?? null);
        if (same) return n;
        changed = true;
        return { ...n, data: { ...n.data, machine: { ...mm, status: s.status, operator: s.operator, technicians: s.technicians ?? null, stop_reason: s.stop_reason ?? null, line_stats: s.line_stats ?? null, current_job_number: s.current_job_number ?? null, queued_ofs: s.queued_ofs ?? null, queued_total: s.queued_total ?? 0, pipeline_ofs: s.pipeline_ofs ?? null, pipeline_total: s.pipeline_total ?? 0, open_ticket: s.open_ticket, open_ticket_id: s.open_ticket_id, open_ticket_number: s.open_ticket_number } } };
      });
      return changed ? next : nds;
    });
    setUnplaced((u) => {
      let changed = false;
      const next = u.map((m) => {
        const s = byId.get(m.id);
        if (!s || m.status === s.status) return m;
        changed = true;
        return { ...m, status: s.status };
      });
      return changed ? next : u;
    });
  }, [setNodes]);

  // Live status push over WebSocket (view mode only)
  useEffect(() => {
    if (editMode || !plantId || !token) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(`${proto}://${window.location.host}/api/factory-map/ws/${plantId}?token=${token}`);
      ws.onmessage = (ev) => { try { const d = JSON.parse(ev.data); if (d.machines) applyStatus(d.machines); if (d.line_tv_thresholds) setTvThresholds(d.line_tv_thresholds); if ('global_line_stats' in d) setGlobalStats(d.global_line_stats ?? null); } catch { /* ignore */ } };
      ws.onclose = () => { if (!closed) retry = setTimeout(connect, 5000); };
      ws.onerror = () => { ws?.close(); };
    };
    connect();
    return () => { closed = true; if (retry) clearTimeout(retry); ws?.close(); };
  }, [editMode, plantId, token, applyStatus]);

  // Snapshot a machine node (its start position + size + its orbit's start/size) so the
  // whole thing can ride a group delta and be persisted on drop.
  const snapshotMachine = useCallback((mNode: Node): MachineDragItem => {
    const orbit = nodesRef.current.find((n) => n.id === `orbit-${mNode.id}`);
    return {
      id: mNode.id,
      mStart: { ...mNode.position }, mSize: { w: mNode.width ?? 152, h: mNode.height ?? 64 },
      orbitId: orbit?.id ?? null,
      oStart: orbit ? { ...orbit.position } : { x: 0, y: 0 },
      oSize: { w: orbit?.width ?? 0, h: orbit?.height ?? 0 },
    };
  }, []);

  // Capture the drag group at drag start. Three shapes:
  //  • a zone dragged alone → it's a container: carry every machine whose centre sits inside it;
  //  • a Shift-selection (>1 node) → React Flow moves the selected machine/zone nodes, we ride the orbits;
  //  • a single machine → the classic case (machine + its orbit).
  const onNodeDragStart = useCallback((_: unknown, node: Node, dragged: Node[]) => {
    if (node.id === 'floorplan' || node.type === 'orbit') { dragRef.current = null; return; }
    const group = dragged && dragged.length ? dragged : [node];
    const startById = new Map<string, XY>();

    if (node.type === 'zone' && group.length === 1) {
      const rect = { x: node.position.x, y: node.position.y, w: node.width ?? 0, h: node.height ?? 0 };
      const machines = nodesRef.current
        .filter((n) => n.type === 'machine'
          && rectContains(rect, n.position.x + (n.width ?? 152) / 2, n.position.y + (n.height ?? 64) / 2))
        .map(snapshotMachine);
      // 3D-only items (temperature sensors, decorative props) have no 2D node, so they don't ride
      // along automatically. An item INSIDE the zone moves with it (keeps its relative position); an
      // item that belongs to the zone by name/department but sits OUTSIDE gets recalled onto the
      // department's machine cluster, so an orphan "Zone Assemblage" thermometer lands on the
      // Assemblage machines instead of floating alone in the middle of the plant.
      const zoneName = ((node.data as ZoneNodeData).zone.name ?? '').trim().toLowerCase();
      const belongsToZone = (label: string | null, dept: string | null): boolean => {
        if (!zoneName) return false;
        const nm = (label ?? '').trim().toLowerCase();
        const dp = (dept ?? '').trim().toLowerCase();
        return dp === zoneName || nm === zoneName || nm === `zone ${zoneName}` || nm === `zona ${zoneName}`;
      };
      // Centre of the carried machines (start coords) — where recalled items land. Falls back to the
      // zone centre when the zone has no machines. `slot` fans multiple recalled items out vertically.
      const cluster = machines.length
        ? (() => {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            machines.forEach((m) => { minX = Math.min(minX, m.mStart.x); minY = Math.min(minY, m.mStart.y); maxX = Math.max(maxX, m.mStart.x + m.mSize.w); maxY = Math.max(maxY, m.mStart.y + m.mSize.h); });
            return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
          })()
        : { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      let snapSlot = 0;
      const snapTarget = () => ({ x: cluster.x, y: cluster.y + (snapSlot++) * 70 });

      const sensors: GroupDrag['sensors'] = [];
      const sensorSnaps: GroupDrag['sensorSnaps'] = [];
      sensorsRef.current.forEach((s) => {
        if (s.pos_x == null || s.pos_y == null) return;
        if (rectContains(rect, s.pos_x, s.pos_y)) sensors.push({ id: s.id, sStart: { x: s.pos_x, y: s.pos_y } });
        else if (belongsToZone(s.name, s.department)) sensorSnaps.push({ id: s.id, target: snapTarget() });
      });
      const props: GroupDrag['props'] = [];
      const propSnaps: GroupDrag['propSnaps'] = [];
      propsRef.current.forEach((p) => {
        if (rectContains(rect, p.pos_x + (p.pos_w ?? 0) / 2, p.pos_y + (p.pos_h ?? 0) / 2)) props.push({ id: p.id, pStart: { x: p.pos_x, y: p.pos_y } });
        else if (belongsToZone(p.label, null)) propSnaps.push({ id: p.id, target: snapTarget() });
      });
      startById.set(node.id, { ...node.position });
      machines.forEach((m) => startById.set(m.id, m.mStart));
      dragRef.current = {
        primaryId: node.id, moveMachineNodes: true, startById, machines,
        zones: [{ nodeId: node.id, dbId: (node.data as ZoneNodeData).zone.id, zStart: { ...node.position } }],
        sensors, props, sensorSnaps, propSnaps,
      };
      return;
    }

    const machines = group.filter((n) => n.type === 'machine').map(snapshotMachine);
    const zones = group.filter((n) => n.type === 'zone')
      .map((z) => ({ nodeId: z.id, dbId: (z.data as ZoneNodeData).zone.id, zStart: { ...z.position } }));
    machines.forEach((m) => startById.set(m.id, m.mStart));
    zones.forEach((z) => startById.set(z.nodeId, z.zStart));
    dragRef.current = { primaryId: node.id, moveMachineNodes: false, startById, machines, zones, sensors: [], props: [], sensorSnaps: [], propSnaps: [] };
  }, [snapshotMachine]);

  // While the group drags, ride the orbits along by the same delta — and, for a zone
  // container, the contained machine nodes too (React Flow doesn't move those itself).
  const onNodeDrag = useCallback((_: unknown, node: Node) => {
    const d = dragRef.current;
    if (!d || !d.machines.length) return;
    const start = d.startById.get(node.id);
    if (!start) return;
    const dx = node.position.x - start.x, dy = node.position.y - start.y;
    const orbitOwner = new Map(d.machines.filter((m) => m.orbitId).map((m) => [m.orbitId as string, m]));
    const machineById = d.moveMachineNodes ? new Map(d.machines.map((m) => [m.id, m])) : null;
    if (!orbitOwner.size && !machineById) return;
    setNodes((nds) => nds.map((n) => {
      const ow = orbitOwner.get(n.id);
      if (ow) return { ...n, position: { x: ow.oStart.x + dx, y: ow.oStart.y + dy } };
      const mm = machineById?.get(n.id);
      if (mm) return { ...n, position: { x: mm.mStart.x + dx, y: mm.mStart.y + dy } };
      return n;
    }));
  }, [setNodes]);

  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (node.id === 'floorplan' || node.type === 'orbit') return;
    if (!d) {   // defensive: persist just the node that moved
      if (node.type === 'zone') editor.patchZone((node.data as ZoneNodeData).zone.id, { pos_x: Math.round(node.position.x), pos_y: Math.round(node.position.y) }, { label: 'move' });
      else if (node.type === 'machine') editor.patchMachine(node.id, { pos_x: Math.round(node.position.x), pos_y: Math.round(node.position.y) }, { label: 'move' });
      return;
    }
    const start = d.startById.get(node.id) ?? { x: node.position.x, y: node.position.y };
    const dx = node.position.x - start.x, dy = node.position.y - start.y;

    // Build ONE undoable group move: every carried machine (with its orbit), zone,
    // and 3D-only item (rode-along or recalled) with its before/after position.
    const mv: GroupMove = { machines: [], zones: [], sensors: [], props: [] };
    for (const m of d.machines) {
      const nx = Math.round(m.mStart.x + dx), ny = Math.round(m.mStart.y + dy);
      const before: GroupMove['machines'][number]['before'] = { pos_x: Math.round(m.mStart.x), pos_y: Math.round(m.mStart.y) };
      const after: GroupMove['machines'][number]['after'] = { pos_x: nx, pos_y: ny };
      if (m.orbitId) {
        before.orbit_x = Math.round(m.oStart.x); before.orbit_y = Math.round(m.oStart.y);
        after.orbit_x = Math.round(m.oStart.x + dx); after.orbit_y = Math.round(m.oStart.y + dy);
      }
      mv.machines.push({ id: m.id, before, after });
    }
    for (const z of d.zones) {
      mv.zones.push({ dbId: z.dbId, before: { x: Math.round(z.zStart.x), y: Math.round(z.zStart.y) }, after: { x: Math.round(z.zStart.x + dx), y: Math.round(z.zStart.y + dy) } });
    }
    d.sensors.forEach((s) => mv.sensors.push({ id: s.id, before: { x: Math.round(s.sStart.x), y: Math.round(s.sStart.y) }, after: { x: Math.round(s.sStart.x + dx), y: Math.round(s.sStart.y + dy) } }));
    d.sensorSnaps.forEach((s) => {
      const cur = sensorsRef.current.find((x) => x.id === s.id);
      mv.sensors.push({ id: s.id, before: { x: Math.round(cur?.pos_x ?? s.target.x), y: Math.round(cur?.pos_y ?? s.target.y) }, after: { x: Math.round(s.target.x + dx), y: Math.round(s.target.y + dy) } });
    });
    d.props.forEach((p) => mv.props.push({ id: p.id, before: { x: Math.round(p.pStart.x), y: Math.round(p.pStart.y) }, after: { x: Math.round(p.pStart.x + dx), y: Math.round(p.pStart.y + dy) } }));
    d.propSnaps.forEach((p) => {
      const cur = propsRef.current.find((x) => x.id === p.id);
      mv.props.push({ id: p.id, before: { x: Math.round(cur?.pos_x ?? p.target.x), y: Math.round(cur?.pos_y ?? p.target.y) }, after: { x: Math.round(p.target.x + dx), y: Math.round(p.target.y + dy) } });
    });
    editor.commitGroupMove(mv);

    // Auto-link is a POSITION-derived effect, deliberately outside the history:
    // relink each moved machine and the cobots covered by its orbit.
    for (const m of d.machines) {
      const nx = Math.round(m.mStart.x + dx), ny = Math.round(m.mStart.y + dy);
      autoLinkRef.current(m.id, nx, ny, m.mSize.w, m.mSize.h);
      if (m.orbitId) reconcileChildrenRef.current(m.id, { x: Math.round(m.oStart.x + dx), y: Math.round(m.oStart.y + dy), w: m.oSize.w, h: m.oSize.h });
    }
  }, [editor]);

  const onNodeClick: NodeMouseHandler = useCallback((_, node) => {
    if (editMode || node.id === 'floorplan' || node.type === 'zone') return;
    const mm = (node.data as MachineNodeData).machine;
    // Pit Stop area → the buffer KPI panel (a buffer, not a machine) — same as 3D.
    if (mm.block_kind === 'pit_stop') {
      setDetail(null); setOfPanel(null); setPitStopOfId(null); setPitStopZone(true);
      return;
    }
    setDetail(mm);
  }, [editMode]);

  // 2D list click: drop near the top-left in a small cascade (the 3D editor
  // offers true click-to-place via the ghost instead).
  const placeMachine = useCallback((m: MapMachine) => {
    const placedCount = nodesRef.current.filter((n) => n.type === 'machine').length;
    const x = 60 + (placedCount % 6) * 40;
    const y = 60 + (placedCount % 6) * 40;
    editor.placeMachine(m, x, y);
  }, [editor]);

  const onUploadFloorPlan = useCallback(async (file: File) => {
    if (!plantId) return;
    setLoading(true);
    try { const up = await uploadFile(file); await saveFloorPlan(plantId, up.url); await load(plantId); }
    finally { setLoading(false); }
  }, [plantId, load]);

  const addZone = useCallback(() => {
    if (!plantId) return;
    editor.createZoneTracked(plantId, { name: 'Zone', pos_x: 40, pos_y: 40, pos_w: 320, pos_h: 220, color: '#6366f1' }, (z) => {
      setNodes((nds) => [...nds, makeZoneNode({ id: z.id, name: z.name ?? 'Zone', color: z.color ?? '#6366f1', pos_x: z.pos_x ?? 40, pos_y: z.pos_y ?? 40, pos_w: z.pos_w ?? 320, pos_h: z.pos_h ?? 220 })]);
    });
  }, [plantId, editor, setNodes, makeZoneNode]);

  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {};
    nodes.forEach((n) => { if (n.type === 'machine') { const s = (n.data as MachineNodeData).machine.status; c[s] = (c[s] ?? 0) + 1; } });
    return c;
  }, [nodes]);

  // Zones present on the map — the edit sidebar lists them with a delete button, so a zone
  // can be removed even when machines/other zones cover it and it can't be click-selected.
  const zoneList = useMemo(() => nodes
    .filter((n) => n.type === 'zone')
    .map((n) => (n.data as ZoneNodeData).zone as ZoneLite)
    .sort((a, b) => a.name.localeCompare(b.name)), [nodes]);

  // M3D objects are cached per node REFERENCE: applyStatus keeps untouched nodes
  // identical, so an unchanged machine hands the memoized 3D block the exact same
  // object and its whole subtree skips re-rendering on the 4 s status push.
  const m3dCache = useRef(new Map<string, { node: Node; m: M3D }>());
  const machines3d = useMemo<M3D[]>(() => {
    const cache = m3dCache.current;
    const seen = new Set<string>();
    const out: M3D[] = [];
    for (const n of nodes) {
      if (n.type !== 'machine') continue;
      seen.add(n.id);
      const hit = cache.get(n.id);
      if (hit && hit.node === n) { out.push(hit.m); continue; }
      const mm = (n.data as MachineNodeData).machine;
      const m: M3D = { id: mm.id, name: mm.name, status: mm.status, technicians: mm.technicians, stop_reason: mm.stop_reason, line_stats: mm.line_stats, pipeline_ofs: mm.pipeline_ofs, pipeline_total: mm.pipeline_total, open_ticket_number: mm.open_ticket_number, pos_x: n.position.x, pos_y: n.position.y, pos_w: n.width ?? 152, pos_h: n.height ?? 64, icon_url: mm.icon_url, model_url: mm.model_url, height_3d: mm.height_3d, model_scale: mm.model_scale, scale_y: mm.scale_y, scale_z: mm.scale_z, rotation_deg: mm.rotation_deg, family: mm.family, subtype: mm.subtype, function_label: mm.function_label, block_kind: mm.block_kind, asset_type: mm.asset_type, orbit_x: mm.orbit_x, orbit_y: mm.orbit_y, orbit_w: mm.orbit_w, orbit_h: mm.orbit_h };
      cache.set(n.id, { node: n, m });
      out.push(m);
    }
    for (const k of [...cache.keys()]) if (!seen.has(k)) cache.delete(k);
    return out;
  }, [nodes]);

  // ── Saved department views ──
  // One view per department (bounding box of its placed machines) + an "overview"
  // spanning the whole plant. Clicking one flies the 3D camera to frame it.
  type ViewBox = { minX: number; minY: number; maxX: number; maxY: number };
  const departmentViews = useMemo<{ name: string; count: number; box: ViewBox }[]>(() => {
    const groups = new Map<string, ViewBox & { count: number }>();
    nodes.forEach((n) => {
      if (n.type !== 'machine') return;
      const dept = ((n.data as MachineNodeData).machine.department ?? '').trim();
      if (!dept) return;
      const x = n.position.x, y = n.position.y, w = n.width ?? 152, h = n.height ?? 64;
      const g = groups.get(dept) ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, count: 0 };
      g.minX = Math.min(g.minX, x); g.minY = Math.min(g.minY, y);
      g.maxX = Math.max(g.maxX, x + w); g.maxY = Math.max(g.maxY, y + h);
      g.count += 1;
      groups.set(dept, g);
    });
    return Array.from(groups.entries())
      .map(([name, { count, ...box }]) => ({ name, count, box }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [nodes]);

  // Wrap every placed machine of a department in a labelled zone (its bounding box +
  // breathing room). The zone is a plain rectangle — membership stays geometric, so
  // later dragging the zone carries whatever machines currently sit inside it.
  const addZoneForDepartment = useCallback((deptName: string) => {
    if (!plantId) return;
    const dv = departmentViews.find((d) => d.name === deptName);
    if (!dv) return;
    const { box } = dv;
    editor.createZoneTracked(plantId, {
      name: deptName, color: deptColor(deptName),
      pos_x: Math.round(box.minX - ZONE_DEPT_PADDING),
      pos_y: Math.round(box.minY - ZONE_DEPT_PADDING),
      pos_w: Math.round(box.maxX - box.minX + ZONE_DEPT_PADDING * 2),
      pos_h: Math.round(box.maxY - box.minY + ZONE_DEPT_PADDING * 2),
    }, (z) => {
      setNodes((nds) => [...nds, makeZoneNode({ id: z.id, name: z.name ?? deptName, color: z.color ?? deptColor(deptName), pos_x: z.pos_x ?? 0, pos_y: z.pos_y ?? 0, pos_w: z.pos_w ?? 320, pos_h: z.pos_h ?? 220 })]);
    });
  }, [plantId, departmentViews, editor, setNodes, makeZoneNode]);

  const overviewBox = useMemo<ViewBox | null>(() => {
    const ms = nodes.filter((n) => n.type === 'machine');
    if (!ms.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ms.forEach((n) => {
      const w = n.width ?? 152, h = n.height ?? 64;
      minX = Math.min(minX, n.position.x); minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + w); maxY = Math.max(maxY, n.position.y + h);
    });
    return { minX, minY, maxX, maxY };
  }, [nodes]);

  // Views split by role: region overrides (department set — pinned camera pose for
  // the Overview or a department, keyed by that value) vs free named views (department null).
  const overrideByRegion = useMemo(() => {
    const m = new Map<string, MapView>();
    views.forEach((v) => { if (v.department) m.set(v.department, v); });
    return m;
  }, [views]);
  const customViews = useMemo(() => views.filter((v) => !v.department), [views]);

  // Region chips = every department that either HAS placed machines (auto frame) or
  // is LINKED by a saved view (e.g. Edge/Coupe adopted a machineless department).
  // count/box come from the machines; a linked-but-machineless region has count 0 / no box.
  const regions = useMemo<{ name: string; count: number; box: ViewBox | null }[]>(() => {
    const byName = new Map<string, { name: string; count: number; box: ViewBox | null }>();
    departmentViews.forEach((d) => byName.set(d.name, { name: d.name, count: d.count, box: d.box }));
    views.forEach((v) => {
      if (v.department && v.department !== OVERVIEW_KEY && !byName.has(v.department)) {
        byName.set(v.department, { name: v.department, count: 0, box: null });
      }
    });
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [departmentViews, views]);

  const focusOn = useCallback((box: ViewBox) => {
    focusNonce.current += 1;
    setFocus({ kind: 'box', ...box, nonce: focusNonce.current });
  }, []);

  // Fly to an exact saved camera pose (custom or region-pinned view).
  const focusView = useCallback((v: MapView) => {
    focusNonce.current += 1;
    setFocus({
      kind: 'pose', nonce: focusNonce.current,
      targetPxX: v.target_px_x, targetPxY: v.target_px_y, targetY: v.target_y,
      offsetX: v.offset_x, offsetY: v.offset_y, offsetZ: v.offset_z,
    });
  }, []);

  // Click a region chip (Overview / department): use its pinned pose if one exists,
  // otherwise frame its auto bounding box (skip if it has neither — machineless & unpinned).
  const focusRegion = useCallback((regionKey: string, box: ViewBox | null) => {
    const pinned = overrideByRegion.get(regionKey);
    if (pinned) focusView(pinned); else if (box) focusOn(box);
  }, [overrideByRegion, focusView, focusOn]);

  // Capture the current camera pose and save it as a free named view.
  // The name comes from an inline popover on the views bar (no window.prompt).
  const [viewNameDraft, setViewNameDraft] = useState<string | null>(null);   // null = closed
  const saveCurrentView = useCallback(async (name: string) => {
    const pose = poseReaderRef.current?.();
    if (!pose || !plantId || !name.trim()) return;
    try {
      const v = await createView(plantId, {
        name: name.trim(),
        target_px_x: pose.targetPxX, target_px_y: pose.targetPxY, target_y: pose.targetY,
        offset_x: pose.offsetX, offset_y: pose.offsetY, offset_z: pose.offsetZ,
      });
      setViews((vs) => [...vs, v]);
    } catch { /* permission / network — leave the bar unchanged */ }
  }, [plantId]);

  // Pin (or re-pin) the current camera pose to a region — the Overview or a
  // department — overriding its auto frame. Upserts the region's FactoryView.
  const pinRegionView = useCallback(async (regionKey: string, label: string) => {
    const pose = poseReaderRef.current?.();
    if (!pose || !plantId) return;
    const patch = {
      target_px_x: pose.targetPxX, target_px_y: pose.targetPxY, target_y: pose.targetY,
      offset_x: pose.offsetX, offset_y: pose.offsetY, offset_z: pose.offsetZ,
    };
    const existing = overrideByRegion.get(regionKey);
    try {
      if (existing) {
        await updateView(existing.id, patch);
        setViews((vs) => vs.map((x) => (x.id === existing.id ? { ...x, ...patch } : x)));
      } else {
        const v = await createView(plantId, { name: label, department: regionKey, ...patch });
        setViews((vs) => [...vs, v]);
      }
    } catch { /* permission / network — leave the bar unchanged */ }
  }, [plantId, overrideByRegion]);

  // Reset a region's pinned pose. Machine-backed department → delete the pose so it
  // reverts to the auto bounding-box frame. Machineless department (a free view that
  // adopted it) → unlink instead of delete, so the view returns to the free bookmarks.
  const resetRegionView = useCallback((regionKey: string) => {
    const existing = overrideByRegion.get(regionKey);
    if (!existing) return;
    const hasAutoFrame = departmentViews.some((d) => d.name === regionKey);
    if (hasAutoFrame || regionKey === OVERVIEW_KEY) {
      setViews((vs) => vs.filter((x) => x.id !== existing.id));
      deleteView(existing.id).catch(() => {});
    } else {
      setViews((vs) => vs.map((x) => (x.id === existing.id ? { ...x, department: null } : x)));
      updateView(existing.id, { department: null }).catch(() => {});
    }
  }, [overrideByRegion, departmentViews]);

  // Link (or unlink, with null) a free saved view to a department — it then adopts
  // that department's machines (count + framing) and moves to the region chips.
  const linkViewToDepartment = useCallback((view: MapView, dept: string | null) => {
    setViews((vs) => vs.map((x) => (x.id === view.id ? { ...x, department: dept } : x)));
    updateView(view.id, { department: dept }).catch(() => {});
  }, []);

  const removeView = useCallback((v: MapView) => {
    if (!window.confirm(t('factoryMap.deleteViewConfirm', { name: v.name }))) return;
    setViews((vs) => vs.filter((x) => x.id !== v.id));
    deleteView(v.id).catch(() => {});
  }, [t]);

  // A machine is no longer on screen after a plant / asset-filter change — drop any stale focus.
  useEffect(() => { setFocus(null); setSelSensor(null); setNearestSensorId(null); }, [plantId, assetFilter]);

  // A region chip (Overview or a department): click flies to its pinned pose or its
  // auto frame; in edit mode a camera button pins/updates the current pose and (once
  // pinned) an undo button reverts to the auto frame. `primary` styles the Overview.
  const renderRegionChip = (regionKey: string, label: string, box: ViewBox | null, count?: number, primary = false) => {
    const pinned = overrideByRegion.has(regionKey);
    const hasAutoFrame = departmentViews.some((d) => d.name === regionKey);
    const base = primary
      ? 'bg-indigo-600/90 text-white border-indigo-600 hover:bg-indigo-600'
      : pinned
        ? 'bg-indigo-500/15 text-indigo-100 border-indigo-500/40 hover:border-indigo-400/70'
        : 'bg-gray-800 text-gray-200 border-gray-700 hover:border-indigo-500/60';
    const divider = primary ? 'border-indigo-400/50' : pinned ? 'border-indigo-500/40' : 'border-gray-700';
    return (
      <span key={regionKey} className={`group inline-flex items-center rounded-md border transition-colors overflow-hidden ${base}`}>
        <button onClick={() => focusRegion(regionKey, box)} title={t('factoryMap.focusDepartment', { name: label })}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs">
          <span className="truncate max-w-[140px]">{label}</span>
          {count != null && <span className={`text-[10px] ${primary ? 'text-indigo-200/80' : 'text-gray-500'}`}>{count}</span>}
          {pinned && <Camera size={10} className={primary ? 'text-white/80' : 'text-indigo-300'} />}
        </button>
        {editMode && (
          <>
            <button onClick={() => pinRegionView(regionKey, label)}
              title={pinned ? t('factoryMap.updatePinnedView') : t('factoryMap.pinCurrentView')}
              className={`px-1.5 py-1 border-l ${divider} ${primary ? 'text-white/80 hover:text-white hover:bg-white/10' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}>
              <Camera size={12} />
            </button>
            {pinned && (
              <button onClick={() => resetRegionView(regionKey)}
                title={hasAutoFrame || primary ? t('factoryMap.resetView') : t('factoryMap.unlinkView')}
                className={`px-1.5 py-1 border-l ${divider} ${primary ? 'text-white/70 hover:text-white hover:bg-white/10' : 'text-indigo-300/70 hover:text-red-400 hover:bg-red-500/10'}`}>
                <RotateCcw size={12} />
              </button>
            )}
          </>
        )}
      </span>
    );
  };

  // Placement mode swallows selection clicks (the click is meant for the ghost).
  const placementRef = useRef(placement);
  useEffect(() => { placementRef.current = placement; }, [placement]);

  // Live mirrors of the selection state for handlers bound outside React's render.
  const sel3dRef = useRef(sel3d); useEffect(() => { sel3dRef.current = sel3d; }, [sel3d]);
  const selPropRef = useRef(selProp); useEffect(() => { selPropRef.current = selProp; }, [selProp]);
  const selSensorRef = useRef(selSensor); useEffect(() => { selSensorRef.current = selSensor; }, [selSensor]);
  const selZoneRef = useRef(selZone3d); useEffect(() => { selZoneRef.current = selZone3d; }, [selZone3d]);
  const mode3dRef = useRef(mode3d); useEffect(() => { mode3dRef.current = mode3d; }, [mode3d]);

  // Ctrl-click multi-selection (3D edit mode): machines + blocks move as one group.
  const [multiSel, setMultiSel] = useState<MultiSelection | null>(null);
  const multiSelRef = useRef(multiSel);
  useEffect(() => { multiSelRef.current = multiSel; }, [multiSel]);

  // Grow/shrink the group: the current single selection (if any) seeds it, the
  // clicked item toggles; back down to ONE member → collapse to single selection.
  const toggleMulti = useCallback((kind: 'machines' | 'props', id: string) => {
    const cur = multiSelRef.current ?? {
      machines: sel3dRef.current ? [sel3dRef.current] : [],
      props: selPropRef.current ? [selPropRef.current] : [],
    };
    const next: MultiSelection = { machines: [...cur.machines], props: [...cur.props] };
    const arr = next[kind];
    const at = arr.indexOf(id);
    if (at >= 0) arr.splice(at, 1); else arr.push(id);
    const total = next.machines.length + next.props.length;
    setSel3d(null); setSelProp(null); setSelSensor(null); setSelZone3d(null);
    if (total === 0) { setMultiSel(null); return; }
    if (total === 1) {
      setMultiSel(null);
      if (next.machines.length) setSel3d(next.machines[0]); else setSelProp(next.props[0]);
      return;
    }
    setMultiSel(next);
  }, []);

  const onMachine3d = useCallback((id: string, additive?: boolean) => {
    if (placementRef.current) return;
    if (editModeRef.current && additive && id) { toggleMulti('machines', id); return; }
    setMultiSel(null);
    setSelProp(null);                                   // selecting a machine clears any other selection
    setSelSensor(null); setSelZone3d(null);
    if (editModeRef.current) { setSel3d(id || null); return; }
    if (!id) { setPitStopOfId(null); setPitStopZone(false); return; }
    const n = nodesRef.current.find((x) => x.id === id);
    if (!n) return;
    const mm = (n.data as MachineNodeData).machine;
    // Clicking the Pit Stop zone opens its KPI panel (a buffer, not a machine).
    if (mm.block_kind === 'pit_stop') {
      setDetail(null); setOfPanel(null); setPitStopOfId(null); setPitStopZone(true);
      return;
    }
    setOfPanel(null); setPitStopOfId(null); setPitStopZone(false); setDetail(mm);
  }, [toggleMulti]);

  const onCommit3d = useCallback<Commit>((id, patch) => {
    const node = nodesRef.current.find((n) => n.id === id);
    editor.patchMachine(id, patch, { label: 'transform' });
    autoLinkRef.current(id, patch.pos_x, patch.pos_y, node?.width ?? 152, node?.height ?? 64);
  }, [editor]);

  // ── Decorative props (3D-only) ──
  // Spawn point = centre of the placed machines' bounding box (matches Factory3D's centroid).
  const mapCenter = useMemo(() => {
    const ms = nodes.filter((n) => n.type === 'machine');
    if (!ms.length) return { x: 400, y: 300 };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    ms.forEach((n) => {
      const w = n.width ?? 152, h = n.height ?? 64;
      minX = Math.min(minX, n.position.x); maxX = Math.max(maxX, n.position.x + w);
      minY = Math.min(minY, n.position.y); maxY = Math.max(maxY, n.position.y + h);
    });
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }, [nodes]);

  // Equipment currently loaded on the map (placed + unplaced) → for linking & live status.
  const equipById = useMemo(() => {
    const m = new Map<string, MapMachine>();
    nodes.forEach((n) => { if (n.type === 'machine') m.set(n.id, (n.data as MachineNodeData).machine); });
    unplaced.forEach((u) => { if (!m.has(u.id)) m.set(u.id, u); });
    return m;
  }, [nodes, unplaced]);

  const equipOptions = useMemo(
    () => Array.from(equipById.values()).map((e) => ({ id: e.id, name: e.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [equipById],
  );

  // Kiosk machines on the map (those with a machine_id) → for tying a conveyor to a
  // machine so clicking it opens that machine's OFs.
  const machineOptions = useMemo(
    () => Array.from(equipById.values())
      .filter((e) => e.machine_id)
      .map((e) => ({ id: e.machine_id as string, name: e.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [equipById],
  );

  // Resolve each prop's live status from its linked equipment, and — for
  // conveyors tied to a kiosk machine — the OF loaded there right now (both
  // update as the WS pushes status). Cached per (prop ref + derived fields) so
  // an unchanged prop keeps its P3D reference and the memoized block skips work.
  const p3dCache = useRef(new Map<string, { src: MapProp; out: P3D }>());
  const props3d = useMemo<P3D[]>(() => {
    const byMachineId = new Map<string, MapMachine>();
    equipById.forEach((e) => { if (e.machine_id) byMachineId.set(e.machine_id, e); });
    const cache = p3dCache.current;
    const seen = new Set<string>();
    const out = props.map((p) => {
      seen.add(p.id);
      const m = p.machine_id ? byMachineId.get(p.machine_id) : undefined;
      const status = p.equipment_id ? (equipById.get(p.equipment_id)?.status ?? null) : null;
      const job_number = m?.current_job_number ?? null;
      const queued_ofs = m?.queued_ofs ?? null;
      const queued_total = m?.queued_total ?? 0;
      const hit = cache.get(p.id);
      if (hit && hit.src === p && hit.out.status === status && hit.out.job_number === job_number
          && hit.out.queued_ofs === queued_ofs && hit.out.queued_total === queued_total) {
        return hit.out;
      }
      const next: P3D = { ...p, status, job_number, queued_ofs, queued_total };
      cache.set(p.id, { src: p, out: next });
      return next;
    });
    for (const k of [...cache.keys()]) if (!seen.has(k)) cache.delete(k);
    return out;
  }, [props, equipById]);

  // ── Pit Stop buffer ──
  // The plant's zone block (block_kind='pit_stop'), if placed on this map.
  const pitStopEq = useMemo(
    () => Array.from(equipById.values()).find((m) => m.block_kind === 'pit_stop') ?? null,
    [equipById],
  );
  const pitStopEqId = pitStopEq?.id ?? null;

  // Dedicated slow poll (~15 s) — deliberately OUTSIDE the 4 s status WS: buffer
  // data is heavier and does not need machine-status latency.
  useEffect(() => {
    if (!plantId || editMode || !pitStopEqId) { setPitStop(null); return; }
    let cancelled = false;
    const tick = () => fetchPitStopState(plantId)
      .then((s) => { if (!cancelled) setPitStop(s); })
      .catch(() => { /* keep the last good state; the next tick retries */ });
    tick();
    const iv = setInterval(tick, 15000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [plantId, editMode, pitStopEqId]);

  // Immediate refresh after an action (release / hold / priority).
  const refreshPitStop = useCallback(() => {
    if (!plantId) return;
    fetchPitStopState(plantId).then(setPitStop).catch(() => {});
  }, [plantId]);

  const onSelectPitStopOf = useCallback((id: string) => {
    setDetail(null); setOfPanel(null); setPitStopZone(false);
    setPitStopOfId(id || null);
  }, []);

  // Fly the camera to an OF's stack: lane/slot → local px inside the zone rect,
  // rotated with the block, then a tight FocusTarget box around that point.
  const focusPitStopOf = useCallback((of: PitStopOf) => {
    if (!pitStopEq || pitStopEq.pos_x == null || pitStopEq.pos_y == null) return;
    const rect = { x: pitStopEq.pos_x, y: pitStopEq.pos_y, w: pitStopEq.pos_w ?? 320, h: pitStopEq.pos_h ?? 1280 };
    const lanes = pitStop?.config.lanes ?? 41;
    const slots = pitStop?.config.slots_per_lane ?? 8;
    const p = of.positions.find((pp) => pp.lane != null && pp.slot != null);
    const lx = p ? ((Math.min(p.slot!, slots) - 0.5) / slots) * rect.w : -20;   // no position → entry edge
    const ly = p ? ((Math.min(p.lane!, lanes) - 0.5) / lanes) * rect.h : rect.h / 2;
    const cxr = rect.x + rect.w / 2, cyr = rect.y + rect.h / 2;
    const rad = ((pitStopEq.rotation_deg ?? 0) * Math.PI) / 180;
    const dx = rect.x + lx - cxr, dy = rect.y + ly - cyr;
    const px = cxr + dx * Math.cos(rad) - dy * Math.sin(rad);
    const py = cyr + dx * Math.sin(rad) + dy * Math.cos(rad);
    focusNonce.current += 1;
    setFocus({ kind: 'box', minX: px - 90, maxX: px + 90, minY: py - 90, maxY: py + 90, nonce: focusNonce.current });
    onSelectPitStopOf(of.job_order_id);
  }, [pitStopEq, pitStop, onSelectPitStopOf]);

  const submitPitStopSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const q = pitStopSearch.trim().toLowerCase();
    if (!q || !pitStop) return;
    const of = pitStop.ofs.find((o) => o.job_number.toLowerCase() === q)
      ?? pitStop.ofs.find((o) => o.job_number.toLowerCase().includes(q));
    setPitStopSearchMiss(!of);
    if (of) focusPitStopOf(of);
  }, [pitStopSearch, pitStop, focusPitStopOf]);

  const equipByIdRef = useRef(equipById);
  useEffect(() => { equipByIdRef.current = equipById; }, [equipById]);

  const onSelectProp = useCallback((id: string, additive?: boolean) => {
    if (placementRef.current) return;
    if (editModeRef.current && additive && id) { toggleMulti('props', id); return; }
    setMultiSel(null);
    setSel3d(null);                                     // selecting a prop clears any other selection
    setSelSensor(null); setSelZone3d(null);
    if (!editModeRef.current) {                         // view mode
      if (!id) { setSelProp(null); return; }
      const pr = propsRef.current.find((p) => p.id === id);
      // A conveyor tied to a machine opens that machine's OFs (Ordres de fabrication).
      if (pr?.machine_id) {
        const mm = Array.from(equipByIdRef.current.values()).find((e) => e.machine_id === pr.machine_id);
        setDetail(null);
        setOfPanel({ machineId: pr.machine_id, name: mm?.name ?? '', role: pr.role ?? null });
        return;
      }
      const eq = pr?.equipment_id ? equipByIdRef.current.get(pr.equipment_id) : null;
      if (eq) { setOfPanel(null); setDetail(eq); }
      return;
    }
    setSelProp(id || null);
  }, [toggleMulti]);

  // Fetch the machine's OFs whenever the conveyor OF panel opens.
  useEffect(() => {
    if (!ofPanel) { setOfList(null); return; }
    let cancelled = false;
    setOfList(null);
    fetchJobOrders({ machine_id: ofPanel.machineId })
      .then((r) => { if (!cancelled) setOfList(r); })
      .catch(() => { if (!cancelled) setOfList([]); });
    return () => { cancelled = true; };
  }, [ofPanel]);

  // Set the parent machine a cobot/conveyor serves (drives "stop with the machine").
  // Auto-link calls pass history:false — a position-derived effect shouldn't pollute undo.
  const setParent = useCallback((id: string, parent_equipment_id: string | null, history = true) => {
    editor.patchMachine(id, { parent_equipment_id: parent_equipment_id as MapMachine['parent_equipment_id'] }, { label: 'parent', history });
  }, [editor]);

  // The production machine whose orbit (footprint + margin) contains a point — nearest centre wins.
  const findOrbitParent = useCallback((cx: number, cy: number, selfId: string): string | null => {
    let best: string | null = null, bestDist = Infinity;
    nodes.forEach((n) => {
      if (n.type !== 'machine' || n.id === selfId) return;
      const mm = (n.data as MachineNodeData).machine;
      if ((mm.asset_type ?? 'production') !== 'production') return;   // orbit hosts = real machines
      const r = orbitRectFor({ ...mm, pos_x: n.position.x, pos_y: n.position.y, pos_w: n.width ?? 152, pos_h: n.height ?? 64 });
      if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) {
        const dist = (cx - (r.x + r.w / 2)) ** 2 + (cy - (r.y + r.h / 2)) ** 2;
        if (dist < bestDist) { bestDist = dist; best = n.id; }
      }
    });
    return best;
  }, [nodes]);

  // Auto-link a dropped cobot/conveyor to whatever machine orbit it landed in (or clear it).
  const autoLinkByOrbit = useCallback((id: string, posX: number, posY: number, w: number, h: number) => {
    const node = nodesRef.current.find((n) => n.id === id);
    const mm = node ? (node.data as MachineNodeData).machine : null;
    if (!mm || !isOrbitChild(mm)) return;
    const parentId = findOrbitParent(posX + w / 2, posY + h / 2, id);
    if ((mm.parent_equipment_id ?? null) !== (parentId ?? null)) setParent(id, parentId, false);
  }, [findOrbitParent, setParent]);
  useEffect(() => { autoLinkRef.current = autoLinkByOrbit; }, [autoLinkByOrbit]);

  // After a host's orbit is reshaped/moved, relink the cobots inside it and release ones that left.
  const reconcileHostChildren = useCallback((hostId: string, rect: { x: number; y: number; w: number; h: number }) => {
    for (const n of nodesRef.current) {
      if (n.type !== 'machine' || n.id === hostId) continue;
      const mm = (n.data as MachineNodeData).machine;
      if (!isOrbitChild(mm)) continue;
      const cx = n.position.x + (n.width ?? 152) / 2, cy = n.position.y + (n.height ?? 64) / 2;
      const inside = rectContains(rect, cx, cy);
      const cur = mm.parent_equipment_id ?? null;
      if (inside && cur !== hostId) setParent(n.id, hostId, false);
      else if (!inside && cur === hostId) setParent(n.id, null, false);
    }
  }, [setParent]);
  useEffect(() => { reconcileChildrenRef.current = reconcileHostChildren; }, [reconcileHostChildren]);

  // Palette click arms the ghost — the block is created where the user clicks the floor.
  const startPropPlacement = useCallback((kind: string) => {
    setSel3d(null); setSelProp(null); setSelSensor(null); setSelZone3d(null); setMultiSel(null);
    setPlacement({ type: 'prop', kind });
  }, []);

  const startMachinePlacement = useCallback((m: MapMachine) => {
    setSel3d(null); setSelProp(null); setSelSensor(null); setSelZone3d(null); setMultiSel(null);
    setPlacement({ type: 'machine', m });
  }, []);

  // Ghost click → create/place at that spot. Blocks STAY armed for rapid stamping
  // (Esc to stop); a machine is unique, so placing it ends its placement.
  const onPlace3d = useCallback((posX: number, posY: number) => {
    if (!placement || !plantId) return;
    if (placement.type === 'prop') {
      const cat = PROP_CATALOG.find((c) => c.kind === placement.kind) ?? PROP_CATALOG[PROP_CATALOG.length - 1];
      editor.createPropTracked(plantId, {
        kind: cat.kind, pos_w: cat.w, pos_h: cat.h, height_3d: cat.height,
        pos_x: posX, pos_y: posY,
      }, undefined, (created) => { setSel3d(null); setSelProp(created.id); });
    } else {
      editor.placeMachine(placement.m, posX, posY);
      setPlacement(null);
      setSelProp(null);
      setSel3d(placement.m.id);
    }
  }, [placement, plantId, editor]);

  const onPropCommit = useCallback<PropCommit>((id, patch) => {
    editor.patchProp(id, patch, { label: 'transform' });
  }, [editor]);


  // ── Temperature sensors (3D thermometers + the bottom badge) ──
  const sensors3d = useMemo<S3D[]>(
    () => sensors.map((s) => ({
      id: s.id, name: s.name, department: s.department,
      pos_x: s.pos_x ?? 0, pos_y: s.pos_y ?? 0,
      height_3d: s.height_3d, last_value_c: s.last_value_c,
    })),
    [sensors],
  );

  // Placed machines' centres + departments — the badge uses these to resolve which
  // department the camera (and each sensor) is in, so a sensor's label never leaks
  // into a neighbouring department.
  const machinePoints = useMemo<MachinePoint[]>(() =>
    nodes
      .filter((n) => n.type === 'machine' && ((n.data as MachineNodeData).machine.department ?? '').trim())
      .map((n) => ({
        x: n.position.x + (n.width ?? 152) / 2,
        y: n.position.y + (n.height ?? 64) / 2,
        dept: ((n.data as MachineNodeData).machine.department as string).trim(),
      })),
    [nodes]);

  const onSelectSensor = useCallback((id: string) => {
    if (placementRef.current) return;
    setMultiSel(null);
    setSel3d(null); setSelProp(null); setSelZone3d(null);
    setSelSensor(id || null);
  }, []);

  // ── Zones on the 3D floor (edit mode) ──
  const zones3d = useMemo<Z3D[]>(() => nodes
    .filter((n) => n.type === 'zone')
    .map((n) => {
      const z = (n.data as ZoneNodeData).zone;
      return { id: z.id, name: z.name, color: z.color, pos_x: n.position.x, pos_y: n.position.y, pos_w: n.width ?? 320, pos_h: n.height ?? 220 };
    }), [nodes]);

  const onSelectZone3d = useCallback((id: string) => {
    if (placementRef.current) return;
    setMultiSel(null);
    setSel3d(null); setSelProp(null); setSelSensor(null);
    setSelZone3d(id || null);
  }, []);

  // 2D selection → properties panel: exactly ONE machine/zone node selected.
  // (Multi-select keeps the group-drag behaviour, no panel.)
  const [sel2d, setSel2d] = useState<{ kind: 'machine' | 'zone'; id: string } | null>(null);
  const onSelectionChange = useCallback(({ nodes: sel }: { nodes: Node[] }) => {
    if (!editModeRef.current || sel.length !== 1) { setSel2d(null); return; }
    const n = sel[0];
    if (n.type === 'machine') setSel2d({ kind: 'machine', id: n.id });
    else if (n.type === 'zone') setSel2d({ kind: 'zone', id: (n.data as ZoneNodeData).zone.id });
    else setSel2d(null);
  }, []);
  const clear2dSelection = useCallback(() => {
    setSel2d(null);
    setNodes((nds) => (nds.some((n) => n.selected) ? nds.map((n) => (n.selected ? { ...n, selected: false } : n)) : nds));
  }, [setNodes]);

  const onZoneCommit3d = useCallback<ZoneCommit3D>((id, patch) => {
    editor.patchZone(id, patch, { label: 'zone' });
  }, [editor]);

  // Group-gizmo release → ONE undoable move for every member (explicit orbits ride along).
  const onMultiCommit3d = useCallback((dxPx: number, dyPx: number) => {
    const sel = multiSelRef.current;
    if (!sel || (dxPx === 0 && dyPx === 0)) return;
    const mv: GroupMove = { machines: [], zones: [], sensors: [], props: [] };
    for (const id of sel.machines) {
      const n = nodesRef.current.find((x) => x.id === id && x.type === 'machine');
      if (!n) continue;
      const mm = (n.data as MachineNodeData).machine;
      const before: GroupMove['machines'][number]['before'] = { pos_x: Math.round(n.position.x), pos_y: Math.round(n.position.y) };
      const after: GroupMove['machines'][number]['after'] = { pos_x: Math.round(n.position.x) + dxPx, pos_y: Math.round(n.position.y) + dyPx };
      if (mm.orbit_x != null || mm.orbit_y != null) {
        before.orbit_x = mm.orbit_x; before.orbit_y = mm.orbit_y;
        after.orbit_x = (mm.orbit_x ?? 0) + dxPx; after.orbit_y = (mm.orbit_y ?? 0) + dyPx;
      }
      mv.machines.push({ id, before, after });
    }
    for (const id of sel.props) {
      const p = propsRef.current.find((x) => x.id === id);
      if (!p) continue;
      mv.props.push({ id, before: { x: Math.round(p.pos_x), y: Math.round(p.pos_y) }, after: { x: Math.round(p.pos_x) + dxPx, y: Math.round(p.pos_y) + dyPx } });
    }
    editor.commitGroupMove(mv);
    for (const m of mv.machines) {
      const n = nodesRef.current.find((x) => x.id === m.id);
      autoLinkRef.current(m.id, m.after.pos_x ?? 0, m.after.pos_y ?? 0, n?.width ?? 152, n?.height ?? 64);
    }
  }, [editor]);

  // Delete the whole group as ONE composite undo step.
  const deleteMultiSelection = useCallback(() => {
    const sel = multiSelRef.current;
    if (!sel) return;
    useEditorStore.getState().batch('delete selection', () => {
      for (const id of sel.props) editor.deletePropTracked(id);
      for (const id of sel.machines) editor.unplaceMachine(id);
    });
    setMultiSel(null);
  }, [editor]);

  const onSensorCommit = useCallback<SensorCommit>((id, patch) => {
    editor.patchSensor(id, patch, { label: 'move' });
  }, [editor]);

  // Cached outdoor weather for the overview badge — refreshed on plant change + every 10 min.
  useEffect(() => {
    if (!plantId) { setWeather(null); return; }
    let alive = true;
    const pull = () => fetchPlantWeather(plantId).then((w) => { if (alive) setWeather(w); }).catch(() => {});
    pull();
    const iv = setInterval(pull, 10 * 60 * 1000);
    return () => { alive = false; clearInterval(iv); };
  }, [plantId]);

  // Keep the thermometer readings live (values change every ~30s server-side).
  // Merge only the reading fields so an in-progress drag position is never yanked.
  useEffect(() => {
    if (!plantId || !mode3d) return;
    let alive = true;
    const pull = () => fetchMapSensors(plantId).then((fresh) => {
      if (!alive) return;
      const byId = new Map(fresh.map((s) => [s.id, s]));
      setSensors((ss) => ss.map((s) => {
        const f = byId.get(s.id);
        return f ? { ...s, last_value_c: f.last_value_c, status: f.status } : s;
      }));
    }).catch(() => {});
    const iv = setInterval(pull, 45 * 1000);
    return () => { alive = false; clearInterval(iv); };
  }, [plantId, mode3d]);

  // The badge: the sensor the camera is nearest to (indoor), else outdoor weather.
  const nearestSensor = useMemo(
    () => sensors.find((s) => s.id === nearestSensorId) ?? null,
    [sensors, nearestSensorId],
  );

  // Duplicate the selected block — exact same size/scale/rotation, offset a little
  // so the copy is visible. Starts UNLINKED (a clone shouldn't share the original's
  // equipment link). createProp can't set the scale fields, so they're patched after.
  const duplicateSelProp = useCallback(() => {
    if (!selProp || !plantId) return;
    const src = propsRef.current.find((p) => p.id === selProp);
    if (!src) return;
    const OFFSET = 30;   // px, so the clone doesn't sit exactly on top of the original
    const scalePatch: PropPatch = {};
    if (src.model_scale != null) scalePatch.model_scale = src.model_scale;
    if (src.scale_y != null) scalePatch.scale_y = src.scale_y;
    if (src.scale_z != null) scalePatch.scale_z = src.scale_z;
    editor.createPropTracked(plantId, {
      kind: src.kind,
      label: src.label,
      model_url: src.model_url,
      pos_x: Math.round(src.pos_x + OFFSET),
      pos_y: Math.round(src.pos_y + OFFSET),
      pos_w: src.pos_w,
      pos_h: src.pos_h,
      rotation_deg: src.rotation_deg ?? 0,
      height_3d: src.height_3d,
    }, scalePatch, (copy) => { setSel3d(null); setSelProp(copy.id); });
  }, [selProp, plantId, editor]);

  // Live maintenance KPIs for the selected machine (real data from /api/kpis)
  useEffect(() => {
    const mid = detail?.machine_id;
    if (!mid) { setKpi(null); return; }
    let cancelled = false;
    setKpiLoading(true);
    setKpi(null);
    fetchKPISummary(30, mid)
      .then((k) => { if (!cancelled) setKpi(k); })
      .catch(() => { if (!cancelled) setKpi(null); })
      .finally(() => { if (!cancelled) setKpiLoading(false); });
    return () => { cancelled = true; };
  }, [detail?.machine_id]);

  useEffect(() => { if (!mode3d || !editMode) { setSel3d(null); setSelProp(null); setSelSensor(null); setSelZone3d(null); setPlacement(null); setMultiSel(null); } }, [mode3d, editMode]);

  // ── permission gate: only users who can update machines may edit the layout ──
  const canEdit = can('machines', 'update');
  useEffect(() => { if (!canEdit && editMode) setEditMode(false); }, [canEdit, editMode]);

  // Fresh plant → fresh undo history and save ledger (old ids are meaningless here).
  useEffect(() => {
    useEditorStore.getState().reset();
    setPlacement(null);
    setMultiSel(null);
  }, [plantId]);

  // Never lose work silently: block tab close while writes are in flight or failed.
  const savesPending = useEditorStore((s) => s.pending);
  const savesFailed = useEditorStore((s) => s.failed.length);
  useEffect(() => {
    if (savesPending === 0 && savesFailed === 0) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [savesPending, savesFailed]);

  // ── keyboard: Esc cancel/deselect · Del delete/remove · M/R/S gizmo modes ·
  //    Ctrl+Z/Y undo/redo · Ctrl+D duplicate · arrows nudge (Shift ×10) ──
  // One nudge "burst" (repeated arrow presses) becomes ONE undo entry and ONE save.
  const nudgeRef = useRef<{ kind: 'machine' | 'prop' | 'sensor' | 'zone'; id: string; start: XY; cur: XY; timer: ReturnType<typeof setTimeout> } | null>(null);

  const nudgeSelected = useCallback((dx: number, dy: number) => {
    const kind = selPropRef.current ? 'prop' : sel3dRef.current ? 'machine' : selSensorRef.current ? 'sensor' : selZoneRef.current ? 'zone' : null;
    if (!kind) return;
    const id = (selPropRef.current ?? sel3dRef.current ?? selSensorRef.current ?? selZoneRef.current)!;
    const n = nudgeRef.current;
    if (n && (n.kind !== kind || n.id !== id)) { clearTimeout(n.timer); nudgeRef.current = null; }
    if (!nudgeRef.current) {
      // capture the burst's starting position for the single undo entry
      let start: XY | null = null;
      if (kind === 'machine' || kind === 'zone') {
        const node = nodesRef.current.find((x) => x.id === (kind === 'zone' ? `zone-${id}` : id));
        if (node) start = { x: node.position.x, y: node.position.y };
      } else if (kind === 'prop') {
        const p = propsRef.current.find((x) => x.id === id);
        if (p) start = { x: p.pos_x, y: p.pos_y };
      } else {
        const s = sensorsRef.current.find((x) => x.id === id);
        if (s && s.pos_x != null && s.pos_y != null) start = { x: s.pos_x, y: s.pos_y };
      }
      if (!start) return;
      nudgeRef.current = { kind, id, start, cur: { ...start }, timer: setTimeout(() => {}, 0) };
    }
    const st = nudgeRef.current;
    st.cur = { x: st.cur.x + dx, y: st.cur.y + dy };
    const pos = { pos_x: Math.round(st.cur.x), pos_y: Math.round(st.cur.y) };
    // instant optimistic preview…
    if (kind === 'machine') editor.applyMachinePatch(id, pos);
    else if (kind === 'prop') editor.applyPropPatch(id, pos);
    else if (kind === 'zone') editor.applyZonePatch(id, pos);
    else editor.applySensorPatch(id, pos);
    // …and one persisted, undoable commit when the burst settles
    clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      const before = { pos_x: Math.round(st.start.x), pos_y: Math.round(st.start.y) };
      if (kind === 'machine') editor.patchMachine(id, pos, { label: 'nudge', before });
      else if (kind === 'prop') editor.patchProp(id, pos, { label: 'nudge', before });
      else if (kind === 'zone') editor.patchZone(id, pos, { label: 'nudge', before });
      else editor.patchSensor(id, pos, { label: 'nudge', before });
      nudgeRef.current = null;
    }, 500);
  }, [editor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!editModeRef.current) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const store = useEditorStore.getState();
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo(); else store.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); return; }
      if (e.key === 'Escape') {
        if (placementRef.current) { setPlacement(null); return; }
        setMultiSel(null);
        setSel3d(null); setSelProp(null); setSelSensor(null); setSelZone3d(null);
        clear2dSelection();
        return;
      }
      if (!mode3dRef.current) return;                      // the rest is 3D-editor only
      if (mod && e.key.toLowerCase() === 'd') {
        if (selPropRef.current) { e.preventDefault(); duplicateSelProp(); }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (multiSelRef.current) { e.preventDefault(); deleteMultiSelection(); }
        else if (selPropRef.current) { e.preventDefault(); editor.deletePropTracked(selPropRef.current); }
        else if (selZoneRef.current) { e.preventDefault(); removeZone(selZoneRef.current); }
        else if (sel3dRef.current) { e.preventDefault(); editor.unplaceMachine(sel3dRef.current); }
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 'm' || k === 'g') { setTransformMode('translate'); return; }
      if (k === 'r') { setTransformMode('rotate'); return; }
      if (k === 's') { setTransformMode('scale'); return; }
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeSelected(-step, 0); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); nudgeSelected(step, 0); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); nudgeSelected(0, -step); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); nudgeSelected(0, step); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, duplicateSelProp, removeZone, nudgeSelected, clear2dSelection, deleteMultiSelection]);

  // Ghost footprint for the item being placed (blocks: catalog default; machines: saved/default footprint).
  const placementSpec = useMemo<PlacementSpec | null>(() => {
    if (!placement) return null;
    if (placement.type === 'prop') {
      const cat = PROP_CATALOG.find((c) => c.kind === placement.kind) ?? PROP_CATALOG[PROP_CATALOG.length - 1];
      return { w: cat.w, h: cat.h, height: cat.height, label: t(`factoryMap.block_${cat.kind}`) };
    }
    return { w: placement.m.pos_w ?? 152, h: placement.m.pos_h ?? 64, height: placement.m.height_3d ?? 3, label: placement.m.name };
  }, [placement, t]);

  // What the properties panel shows (edit mode, 2D and 3D). Machine position/size
  // come from the NODE — the live source of truth while editing.
  const panelSelection = useMemo<PanelSelection | null>(() => {
    if (!editMode) return null;
    const machineSel = mode3d ? sel3d : (sel2d?.kind === 'machine' ? sel2d.id : null);
    const zoneSel = mode3d ? selZone3d : (sel2d?.kind === 'zone' ? sel2d.id : null);
    if (mode3d && selProp) { const p = props.find((x) => x.id === selProp); return p ? { kind: 'prop', p } : null; }
    if (machineSel) {
      const n = nodes.find((x) => x.id === machineSel);
      if (!n) return null;
      const mm = (n.data as MachineNodeData).machine;
      return { kind: 'machine', m: { ...mm, pos_x: n.position.x, pos_y: n.position.y, pos_w: n.width ?? mm.pos_w ?? 152, pos_h: n.height ?? mm.pos_h ?? 64 } };
    }
    if (mode3d && selSensor) { const s = sensors.find((x) => x.id === selSensor); return s ? { kind: 'sensor', s } : null; }
    if (zoneSel) { const z = zones3d.find((x) => x.id === zoneSel); return z ? { kind: 'zone', z } : null; }
    return null;
  }, [mode3d, editMode, selProp, sel3d, selSensor, selZone3d, sel2d, props, nodes, sensors, zones3d]);

  // Fullscreen for the 3D view (real browser fullscreen; Esc exits). The R3F Canvas
  // auto-resizes to its container, so toggling fullscreen just works.
  const toggleFullscreen = useCallback(() => {
    const el = viewRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => {});
  }, []);
  useEffect(() => {
    const onFs = () => setIsFull(document.fullscreenElement === viewRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const openMachinePage = (m: MapMachine) => {
    const path = m.page_slug ? `/machines/${m.page_slug}` : `/equipment/${m.id}`;
    window.open(path, '_blank', 'noopener');   // open the machine page in a new tab, keep the map open
  };

  return (
    <div className="h-full flex flex-col bg-gray-950 text-gray-100">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 flex-wrap">
        <div className="flex items-center gap-2">
          <MapIcon size={20} className="text-indigo-400" />
          <span className="text-base font-semibold text-white">{t('factoryMap.title')}</span>
        </div>
        <select value={plantId} onChange={(e) => setPlantId(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-sm text-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-indigo-500">
          {plants.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <span className="inline-flex rounded-lg border border-gray-700 overflow-hidden text-sm">
          {(['production', 'auxiliary', 'all'] as const).map((f) => (
            <button key={f} onClick={() => { setAssetFilter(f); setDetail(null); }}
              className={`px-3 py-1.5 ${assetFilter === f ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
              {t(`factoryMap.filter_${f}`)}
            </button>
          ))}
        </span>

        <span className="inline-flex rounded-lg border border-gray-700 overflow-hidden text-sm">
          <button onClick={() => setMode3d(false)} className={`px-3 py-1.5 ${!mode3d ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>2D</button>
          <button onClick={() => { setMode3d(true); setSel3d(null); }} className={`px-3 py-1.5 ${mode3d ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>3D</button>
        </span>

        {canEdit && (
          <span className="inline-flex rounded-lg border border-gray-700 overflow-hidden text-sm">
            <button onClick={() => setEditMode(false)} className={`flex items-center gap-1.5 px-3 py-1.5 ${!editMode ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}><Eye size={14} /> {t('factoryMap.view')}</button>
            <button onClick={() => { setEditMode(true); setDetail(null); }} className={`flex items-center gap-1.5 px-3 py-1.5 ${editMode ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}><Pencil size={14} /> {t('factoryMap.edit')}</button>
          </span>
        )}
        {editMode && <SaveStatusPill />}

        {editMode && !mode3d && (
          <>
            <button onClick={addZone} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-300 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg">
              <Plus size={14} /> {t('factoryMap.addZone')}
            </button>
            {departmentViews.length > 0 && (
              <select value="" title={t('factoryMap.zoneFromDepartmentHint')}
                onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v) addZoneForDepartment(v); }}
                className="px-3 py-1.5 text-sm text-gray-300 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg focus:outline-none focus:border-indigo-500 cursor-pointer">
                <option value="">{t('factoryMap.zoneFromDepartment')}</option>
                {departmentViews.map((d) => <option key={d.name} value={d.name} className="bg-gray-800">{d.name} ({d.count})</option>)}
              </select>
            )}
            <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-300 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg">
              <Upload size={14} /> {floorPlanUrl ? t('factoryMap.replaceFloorPlan') : t('factoryMap.uploadFloorPlan')}
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onUploadFloorPlan(f); e.target.value = ''; }} />
          </>
        )}

        <button onClick={() => load(plantId)} className="p-2 text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-lg">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>

        <div className="flex items-center gap-3 ml-auto text-xs text-gray-400 flex-wrap">
          {Object.entries(STATUS_LABELS).map(([k, label]) => (
            <span key={k} className="flex items-center gap-1.5">
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: STATUS_COLORS[k], display: 'inline-block' }} />
              {label[lang as 'en' | 'fr' | 'es'] ?? k}{statusCounts[k] ? ` (${statusCounts[k]})` : ''}
            </span>
          ))}
        </div>
      </div>

      <input ref={photoInputRef} type="file" accept="image/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onPhotoSelected(f); e.target.value = ''; }} />
      <input ref={modelInputRef} type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onModelSelected(f); e.target.value = ''; }} />

      {/* Body */}
      <div className="flex-1 flex min-h-0">
        {editMode && !mode3d && (
          <aside className="w-56 flex-shrink-0 border-r border-gray-800 overflow-y-auto p-3">
            <p className="text-xs text-gray-500 mb-2">{t('factoryMap.unplaced')} · {unplaced.length}</p>
            <input value={unplacedSearch} onChange={(e) => setUnplacedSearch(e.target.value)} placeholder={t('factoryMap.searchMachines')}
              className="w-full mb-2 px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
            <div className="space-y-1.5">
              {unplaced.filter((m) => m.name.toLowerCase().includes(unplacedSearch.toLowerCase())).map((m) => (
                <button key={m.id} onClick={() => placeMachine(m)} title={t('factoryMap.clickToDrop')}
                  className="w-full flex items-center gap-2 text-left text-xs text-gray-200 border border-gray-700 rounded-lg px-2.5 py-2 bg-gray-900 hover:border-indigo-500/50 hover:bg-gray-800 transition-colors">
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLORS[m.status] ?? STATUS_COLORS.idle, flexShrink: 0 }} />
                  <span className="truncate">{m.name}</span>
                </button>
              ))}
              {unplaced.length === 0 && <p className="text-xs text-gray-600">{t('factoryMap.allPlaced')}</p>}
            </div>

            {zoneList.length > 0 && (
              <div className="mt-5 pt-3 border-t border-gray-800">
                <p className="text-xs text-gray-500 mb-2">{t('factoryMap.zonesSection')} · {zoneList.length}</p>
                <div className="space-y-1.5">
                  {zoneList.map((z) => (
                    <div key={z.id} className="w-full flex items-center gap-2 text-xs text-gray-200 border border-gray-700 rounded-lg px-2.5 py-2 bg-gray-900">
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: z.color, flexShrink: 0 }} />
                      <span className="truncate flex-1">{z.name}</span>
                      <button title={`${t('factoryMap.deleteZone')} (Ctrl+Z ${t('factoryMap.undo')})`}
                        onClick={() => removeZone(z.id)}
                        className="text-gray-500 hover:text-red-400 flex-shrink-0">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </aside>
        )}

        <div ref={viewRef} className="flex-1 min-w-0 relative bg-gray-950">
          {mode3d && (
            <button onClick={toggleFullscreen}
              title={isFull ? t('factoryMap.exitFullscreen') : t('factoryMap.fullscreen')}
              className="absolute top-3 right-3 z-20 p-2 text-gray-300 bg-gray-900/90 border border-gray-700 rounded-lg hover:text-white hover:bg-gray-800">
              {isFull ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          )}
          {/* Saved views — overview + auto per-department frames + user-saved poses */}
          {mode3d && (overviewBox || views.length > 0 || editMode) && (
            <div className="absolute top-3 left-3 z-20 max-w-[62%] flex flex-col items-start gap-2">
              <div className="flex flex-wrap items-center gap-1.5 max-w-full bg-gray-900/90 border border-gray-700 rounded-lg p-1.5">
                <span className="flex items-center gap-1 pl-1 pr-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                  <Eye size={12} className="text-indigo-400" /> {t('factoryMap.savedViews')}
                </span>
                {overviewBox && renderRegionChip(OVERVIEW_KEY, t('factoryMap.overview'), overviewBox, undefined, true)}
                {regions.map((r) => renderRegionChip(r.name, r.name, r.box, r.count))}
                {customViews.length > 0 && <span className="w-px h-4 bg-gray-700 mx-0.5" />}
                {/* free user-saved camera poses (click flies to the exact pose); in edit
                    mode a department picker links a view to a department → it adopts that
                    department's machines and moves into the region chips above. */}
                {customViews.map((v) => (
                  <span key={v.id}
                    className="group inline-flex items-center rounded-md bg-indigo-500/10 text-indigo-200 border border-indigo-500/30 hover:border-indigo-400/70 transition-colors overflow-hidden">
                    <button onClick={() => focusView(v)} title={v.name}
                      className="px-2.5 py-1 text-xs">
                      <span className="truncate max-w-[140px] inline-block align-middle">{v.name}</span>
                    </button>
                    {editMode && (
                      <>
                        <select
                          value=""
                          onChange={(e) => { if (e.target.value) linkViewToDepartment(v, e.target.value); }}
                          title={t('factoryMap.linkViewHint')}
                          className="bg-transparent text-indigo-300/80 text-[10px] border-l border-indigo-500/30 pl-1 pr-0.5 py-1 focus:outline-none hover:text-white cursor-pointer"
                        >
                          <option value="">{t('factoryMap.linkToDepartment')}</option>
                          {deptOptions.map((d) => <option key={d} value={d} className="text-gray-200 bg-gray-800">{d}</option>)}
                        </select>
                        <button onClick={() => removeView(v)} title={t('common.delete')}
                          className="px-1.5 py-1 text-indigo-300/60 hover:text-red-400 hover:bg-red-500/10 border-l border-indigo-500/30">
                          <X size={12} />
                        </button>
                      </>
                    )}
                  </span>
                ))}
                {editMode && (viewNameDraft === null ? (
                  <button onClick={() => setViewNameDraft('')} title={t('factoryMap.saveViewHint')}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md bg-gray-800 text-gray-200 border border-dashed border-gray-600 hover:border-indigo-500/60 hover:text-white transition-colors">
                    <Camera size={13} /> {t('factoryMap.saveView')}
                  </button>
                ) : (
                  <form
                    onSubmit={(e) => { e.preventDefault(); saveCurrentView(viewNameDraft); setViewNameDraft(null); }}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-gray-800 border border-indigo-500/60">
                    <Camera size={13} className="text-indigo-300" />
                    <input
                      autoFocus value={viewNameDraft}
                      onChange={(e) => setViewNameDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Escape') { setViewNameDraft(null); (e.target as HTMLInputElement).blur(); } e.stopPropagation(); }}
                      placeholder={t('factoryMap.viewNamePlaceholder')}
                      className="w-32 bg-transparent text-xs text-gray-100 placeholder-gray-500 focus:outline-none py-0.5"
                    />
                    <button type="submit" disabled={!viewNameDraft.trim()}
                      className="px-1 text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-30">✓</button>
                    <button type="button" onClick={() => setViewNameDraft(null)}
                      className="px-1 text-xs text-gray-400 hover:text-gray-200">✕</button>
                  </form>
                ))}
              </div>
              {/* 3D transform toolbar — stacked UNDER the views row (same column)
                  so the wrapping views bar never covers the edit controls. All
                  per-item controls live in the properties panel on the right. */}
              {editMode && (
                <div className="flex flex-wrap items-center gap-2 max-w-full bg-gray-900/90 border border-gray-700 rounded-lg px-2 py-1.5">
                  <span className="inline-flex rounded border border-gray-700 overflow-hidden text-xs">
                    <button onClick={() => setTransformMode('translate')} title={`${t('factoryMap.move')} (M)`} className={`px-2 py-1 ${transformMode === 'translate' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>{t('factoryMap.move')}</button>
                    <button onClick={() => setTransformMode('rotate')} title={`${t('factoryMap.rotate')} (R)`} className={`px-2 py-1 ${transformMode === 'rotate' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>{t('factoryMap.rotate')}</button>
                    <button onClick={() => setTransformMode('scale')} title={`${t('factoryMap.scale')} (S)`} className={`px-2 py-1 ${transformMode === 'scale' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>{t('factoryMap.scale')}</button>
                  </span>
                  <button onClick={() => setSnap(!snap)} title={t('factoryMap.snapHint')}
                    className={`flex items-center gap-1 px-2 py-1 rounded border text-xs ${snap ? 'bg-indigo-600/20 border-indigo-500/60 text-indigo-200' : 'border-gray-700 text-gray-400 hover:text-gray-200'}`}>
                    <Magnet size={12} /> {t('factoryMap.snap')}
                  </button>
                  <span className="text-xs text-gray-500">
                    {multiSel ? t('factoryMap.hintMulti', { count: multiSel.machines.length + multiSel.props.length })
                      : selSensor ? t('factoryMap.hintSensor') : selProp ? t('factoryMap.hintBlock') : sel3d ? t('factoryMap.hintMachine') : selZone3d ? t('factoryMap.hintZone') : t('factoryMap.hintNone')}
                  </span>
                  {(sel3d || selProp || selSensor || selZone3d || multiSel) && (
                    <button onClick={() => { setSel3d(null); setSelProp(null); setSelSensor(null); setSelZone3d(null); setMultiSel(null); }}
                      title={`${t('factoryMap.deselect')} (Esc)`} className="text-xs text-gray-400 hover:text-gray-200">✕</button>
                  )}
                </div>
              )}
            </div>
          )}
          {/* Camera controls hint — Shift+drag pans (moves) instead of rotating.
              While placing, it flips into the placement instruction. */}
          {mode3d && (
            placement ? (
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 text-[11px] text-indigo-100 bg-indigo-600/90 border border-indigo-400 rounded-full px-3 py-1 pointer-events-none">
                <Plus size={12} /> {t('factoryMap.placementHint')}
              </div>
            ) : (
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 text-[11px] text-gray-300 bg-gray-900/85 border border-gray-700 rounded-full px-3 py-1 pointer-events-none">
                <Move size={12} className="text-indigo-400" /> {t('factoryMap.shiftToPan')}
              </div>
            )
          )}
          {/* Temperature badge (bottom-right): the nearest sensor's indoor reading as
              you navigate; away from any sensor (overview) the plant's outdoor weather. */}
          {mode3d && (() => {
            const indoorC = nearestSensor?.last_value_c ?? null;
            const isIndoor = !!nearestSensor && indoorC != null;
            const celsius = isIndoor ? indoorC : (weather?.temp_c ?? null);
            if (celsius == null) return null;
            const ring = tempColor(celsius);
            // Outdoor label = the plant's city (from the parenthetical in its name,
            // e.g. "Foliot Furniture (Saint-Jérôme)" → "Saint-Jérôme"), else the name.
            const plantName = plants.find((p) => p.id === plantId)?.name ?? '';
            const city = plantName.match(/\(([^)]+)\)/)?.[1] ?? plantName;
            return (
              <div className="absolute bottom-3 right-3 z-10 flex items-center gap-2.5 bg-gray-900/90 border border-gray-700 rounded-full pl-2 pr-4 py-1.5 pointer-events-none">
                <div className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 bg-gray-950"
                  style={{ border: `3px solid ${ring}`, boxShadow: `0 0 12px ${ring}55` }}>
                  <span className="text-base font-black text-white">{toUnit(celsius, tempUnit)}°</span>
                </div>
                <div className="leading-tight">
                  <div className="text-xs font-semibold text-gray-100 flex items-center gap-1">
                    <span>{isIndoor ? '🌡️' : weatherIcon(weather?.code)}</span>
                    {isIndoor ? nearestSensor!.name : city}
                  </div>
                  <div className="text-[10px] text-gray-500">
                    {isIndoor ? t('factoryMap.indoorTemp') : t('factoryMap.outdoorTemp')}
                  </div>
                </div>
              </div>
            );
          })()}
          {/* Pit Stop — OF search (fly-to) below the fullscreen button */}
          {mode3d && !editMode && pitStop && (
            <form onSubmit={submitPitStopSearch}
              className="absolute top-14 right-3 z-10 flex items-center gap-1.5 bg-gray-900/90 border border-gray-700 rounded-lg pl-2 pr-1 py-1">
              <Search size={13} className={pitStopSearchMiss ? 'text-red-400' : 'text-gray-500'} />
              <input
                value={pitStopSearch}
                onChange={(e) => { setPitStopSearch(e.target.value); setPitStopSearchMiss(false); }}
                placeholder={t('pitStop.searchPlaceholder')}
                title={pitStopSearchMiss ? t('pitStop.searchNotFound') : undefined}
                className={`w-36 bg-transparent text-xs focus:outline-none placeholder-gray-600 ${pitStopSearchMiss ? 'text-red-300' : 'text-gray-200'}`}
              />
              {pitStopSearchMiss && <span className="text-[10px] text-red-400 pr-1">{t('pitStop.searchNotFound')}</span>}
            </form>
          )}
          {/* Pit Stop — collapsible legend (OF states + component categories) */}
          {mode3d && !editMode && pitStop && (
            <div className="absolute bottom-3 left-3 z-10 max-w-[240px] bg-gray-900/90 border border-gray-700 rounded-lg text-xs">
              <button onClick={() => setLegendOpen((v) => !v)}
                className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-gray-300 hover:text-white">
                <span className="flex items-center gap-1.5 font-semibold">
                  <Boxes size={13} className="text-indigo-400" /> {t('pitStop.legend')}
                </span>
                {legendOpen ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
              </button>
              {legendOpen && (
                <div className="px-2.5 pb-2.5 space-y-2">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">{t('pitStop.completeness')}</p>
                    <div className="space-y-0.5">
                      {([
                        { color: COMPLETENESS_HEX.full, label: t('pitStop.kpi.inFull') },
                        { color: COMPLETENESS_HEX.almost, label: '> 90 %' },
                        { color: COMPLETENESS_HEX.low, label: '< 90 %' },
                        { color: COMPLETENESS_HEX.unknown, label: t('pitStop.noBom') },
                      ]).map((e) => (
                        <div key={e.label} className="flex items-center gap-1.5 text-gray-300">
                          <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: e.color }} />
                          {e.label}
                        </div>
                      ))}
                      <div className="flex items-center gap-1.5 text-gray-300">
                        {/* little traffic cone marker (matches the 3D cone) */}
                        <span className="flex-shrink-0" style={{ width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderBottom: `10px solid ${OF_LATE_HEX}` }} />
                        {t('pitStop.late')} · {t('pitStop.dueToday')}
                      </div>
                    </div>
                  </div>
                  {pitStop.categories.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] uppercase tracking-wide text-gray-500">{t('pitStop.legendCategories')}</p>
                      {([
                        { label: t('pitStop.family.caseGoods'), accent: PIT_CG_ACCENT,
                          cats: pitStop.categories.filter((c) => c.family === 'cg' || c.family === 'both') },
                        { label: t('pitStop.family.softGoods'), accent: PIT_SG_ACCENT,
                          cats: pitStop.categories.filter((c) => c.family === 'sg' || c.family === 'both') },
                      ] as { label: string; accent: string; cats: PitStopCategory[] }[])
                        .filter((g) => g.cats.length > 0)
                        .map((g) => (
                          <div key={g.label}>
                            <p className="text-[10px] uppercase tracking-wide mb-0.5 flex items-center gap-1" style={{ color: g.accent }}>
                              <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: g.accent }} />{g.label}
                            </p>
                            <div className="space-y-0.5 pl-3">
                              {g.cats.map((c) => (
                                <div key={c.name} className="flex items-center gap-1.5 text-gray-300">
                                  <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: c.color }} />
                                  {c.name}
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {!mode3d && !floorPlanUrl && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 text-xs text-gray-500 bg-gray-900/80 border border-gray-800 rounded-full px-3 py-1">
              <ImageIcon size={12} /> {t('factoryMap.noFloorPlan')}{editMode ? t('factoryMap.noFloorPlanEdit') : ''}
            </div>
          )}
          {!mode3d && editMode && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 text-[11px] text-gray-300 bg-gray-900/85 border border-gray-700 rounded-full px-3 py-1 pointer-events-none">
              <Move size={12} className="text-indigo-400" /> {t('factoryMap.multiSelectHint')}
            </div>
          )}
          {mode3d ? (
            <Factory3D key={plantId} machines={machines3d} floorPlanUrl={floorPlanUrl} onSelect={onMachine3d}
              tvThresholds={tvThresholds} globalLineStats={globalStats}
              editMode={editMode} selectedId={sel3d} mode={transformMode} onCommit={onCommit3d}
              props={props3d} onSelectProp={onSelectProp} selectedPropId={selProp} onPropCommit={onPropCommit}
              sensors={sensors3d} tempUnit={tempUnit} selectedSensorId={selSensor}
              onSelectSensor={onSelectSensor} onSensorCommit={onSensorCommit}
              onNearestSensorChange={setNearestSensorId}
              machinePoints={machinePoints}
              pitStop={pitStop} onSelectPitStopOf={onSelectPitStopOf} selectedPitStopOfId={pitStopOfId}
              zones={zones3d} selectedZoneId={selZone3d} onSelectZone={onSelectZone3d} onZoneCommit={onZoneCommit3d}
              snap={snap} placement={editMode ? placementSpec : null} onPlace={onPlace3d}
              multiSelection={multiSel} onMultiCommit={onMultiCommit3d}
              infoId={!editMode ? (detail?.id ?? null) : null} infoKpi={kpi} focus={focus}
              onPoseReader={(r) => { poseReaderRef.current = r; }} />
          ) : (
          <PitStop2DCtx.Provider value={pitStop}>
          <ReactFlow
            nodes={nodes} onNodesChange={onNodesChange} nodeTypes={nodeTypes}
            onNodeDragStart={onNodeDragStart} onNodeDrag={onNodeDrag} onNodeDragStop={onNodeDragStop} onNodeClick={onNodeClick}
            onSelectionChange={onSelectionChange}
            nodesDraggable={editMode} nodesConnectable={false} elementsSelectable={editMode}
            deleteKeyCode={null}
            colorMode="dark" fitView minZoom={0.2} proOptions={{ hideAttribution: true }} style={{ background: 'transparent' }}
          >
            <Background gap={24} color="#1f2937" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => n.type === 'machine' ? ((n.data as MachineNodeData).machine?.block_kind === 'pit_stop' ? '#818cf8' : (STATUS_COLORS[(n.data as MachineNodeData).machine?.status] ?? '#6b7280')) : (n.type === 'zone' ? (n.data as ZoneNodeData).zone.color : 'transparent')} />
          </ReactFlow>
          </PitStop2DCtx.Provider>
          )}
          {/* Add panel — blocks AND unplaced machines, both placed by clicking the
              floor (the armed item highlights; Esc disarms). */}
          {mode3d && editMode && (
            <div className="absolute bottom-3 left-3 z-10 w-[230px] max-h-[55%] overflow-y-auto bg-gray-900/90 border border-gray-700 rounded-lg p-2">
              <p className="text-[11px] text-gray-500 mb-1.5 px-0.5">{t('factoryMap.addBlock')}</p>
              <div className="flex flex-wrap gap-1.5">
                {PROP_CATALOG.map((c) => {
                  const active = placement?.type === 'prop' && placement.kind === c.kind;
                  return (
                    <button key={c.kind}
                      onClick={() => (active ? setPlacement(null) : startPropPlacement(c.kind))}
                      title={`${t('factoryMap.add')} ${t(`factoryMap.block_${c.kind}`)} — ${t('factoryMap.placementHint')}`}
                      className={`flex items-center gap-1 px-2 py-1 text-[11px] border rounded ${active ? 'bg-indigo-600 border-indigo-400 text-white' : 'text-gray-200 bg-gray-800 hover:bg-indigo-600 border-gray-700'}`}>
                      <Plus size={11} /> {t(`factoryMap.block_${c.kind}`)}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2.5 pt-2 border-t border-gray-800">
                <p className="text-[11px] text-gray-500 mb-1.5 px-0.5">{t('factoryMap.unplaced')} · {unplaced.length}</p>
                {unplaced.length > 0 && (
                  <input value={unplacedSearch} onChange={(e) => setUnplacedSearch(e.target.value)} placeholder={t('factoryMap.searchMachines')}
                    className="w-full mb-1.5 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-[11px] text-gray-200 placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
                )}
                <div className="space-y-1">
                  {unplaced.filter((m) => m.name.toLowerCase().includes(unplacedSearch.toLowerCase())).map((m) => {
                    const active = placement?.type === 'machine' && placement.m.id === m.id;
                    return (
                      <button key={m.id}
                        onClick={() => (active ? setPlacement(null) : startMachinePlacement(m))}
                        title={t('factoryMap.placementHint')}
                        className={`w-full flex items-center gap-2 text-left text-[11px] border rounded px-2 py-1.5 transition-colors ${active ? 'bg-indigo-600 border-indigo-400 text-white' : 'text-gray-200 border-gray-700 bg-gray-900 hover:border-indigo-500/50 hover:bg-gray-800'}`}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLORS[m.status] ?? STATUS_COLORS.idle, flexShrink: 0 }} />
                        <span className="truncate">{m.name}</span>
                      </button>
                    );
                  })}
                  {unplaced.length === 0 && <p className="text-[11px] text-gray-600 px-0.5">{t('factoryMap.allPlaced')}</p>}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Group panel — Ctrl-click selection: count + group actions */}
        {editMode && mode3d && multiSel && (
          <aside className="w-72 flex-shrink-0 border-l border-gray-800 overflow-y-auto p-3.5 bg-gray-950">
            <div className="flex items-start justify-between mb-3">
              <h3 className="text-white font-semibold text-sm leading-snug">
                {t('factoryMap.multiTitle', { count: multiSel.machines.length + multiSel.props.length })}
              </h3>
              <button onClick={() => setMultiSel(null)} title={`${t('common.close')} (Esc)`} className="text-gray-500 hover:text-gray-300 flex-shrink-0 ml-2"><X size={16} /></button>
            </div>
            <p className="text-[11px] text-gray-500 mb-3">{t('factoryMap.multiHelp')}</p>
            <ul className="space-y-1 mb-4 max-h-64 overflow-y-auto">
              {multiSel.machines.map((id) => {
                const n = nodes.find((x) => x.id === id);
                const nm = n ? (n.data as MachineNodeData).machine.name : id;
                return (
                  <li key={id} className="flex items-center gap-2 text-xs text-gray-300 bg-gray-900 border border-gray-800 rounded px-2 py-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 flex-shrink-0" />
                    <span className="truncate flex-1">{nm}</span>
                    <button onClick={() => toggleMulti('machines', id)} className="text-gray-600 hover:text-gray-300 flex-shrink-0">✕</button>
                  </li>
                );
              })}
              {multiSel.props.map((id) => {
                const p = props.find((x) => x.id === id);
                const nm = p ? (p.label || t(`factoryMap.block_${p.kind}`)) : id;
                return (
                  <li key={id} className="flex items-center gap-2 text-xs text-gray-300 bg-gray-900 border border-gray-800 rounded px-2 py-1">
                    <span className="w-1.5 h-1.5 rounded-sm bg-gray-500 flex-shrink-0" />
                    <span className="truncate flex-1">{nm}</span>
                    <button onClick={() => toggleMulti('props', id)} className="text-gray-600 hover:text-gray-300 flex-shrink-0">✕</button>
                  </li>
                );
              })}
            </ul>
            <button onClick={deleteMultiSelection} title={`${t('common.delete')} (Del)`}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs text-red-300 bg-red-500/10 border border-red-500/30 hover:bg-red-500/20">
              <Trash2 size={13} /> {t('factoryMap.deleteSelection')}
            </button>
          </aside>
        )}

        {/* Properties panel (edit mode, single selection) — exact numbers, links & actions */}
        {!multiSel && panelSelection && (
          <MapEditorPanel
            selection={panelSelection}
            editor={editor}
            equipOptions={equipOptions}
            machineOptions={machineOptions}
            onClose={() => { setSel3d(null); setSelProp(null); setSelSensor(null); setSelZone3d(null); clear2dSelection(); }}
            onPickMachinePhoto={pickPhoto}
            onPickMachineModel={pickModel}
            onPickPropModel={pickPropModel}
            onDuplicateProp={() => duplicateSelProp()}
            onDeleteProp={(id) => editor.deletePropTracked(id)}
            onUnplaceMachine={(id) => editor.unplaceMachine(id)}
            onDeleteZone={removeZone}
          />
        )}

        {/* Detail panel (View mode) */}
        {!editMode && detail && (
          <aside className="w-80 flex-shrink-0 border-l border-gray-800 overflow-y-auto p-4">
            <div className="flex items-start justify-between mb-3">
              <h3 className="text-white font-semibold text-sm leading-snug">{detail.name}</h3>
              <button onClick={() => setDetail(null)} className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
            </div>
            <p className="text-xs text-gray-600 font-mono mb-3">{detail.code ?? '—'}</p>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: STATUS_COLORS[detail.status] ?? STATUS_COLORS.idle }} />
                <span className="text-gray-200">{STATUS_LABELS[detail.status]?.[lang as 'en' | 'fr' | 'es'] ?? detail.status}</span>
              </div>
              <p className="text-gray-400 text-xs">{t('factoryMap.operator')}: <span className="text-gray-200">{detail.operator ?? '—'}</span></p>
              <p className="text-gray-400 text-xs">{t('factoryMap.department')}: <span className="text-gray-200">{detail.department ?? '—'}</span></p>
              {(detail.function_label || detail.subtype || detail.family) && (
                <p className="text-gray-400 text-xs">{t('common.type')}: <span className="text-gray-200">{detail.function_label ?? detail.subtype ?? detail.family}</span></p>
              )}
              {detail.open_ticket && (
                <button onClick={() => detail.open_ticket_id && navigate(`/tickets/${detail.open_ticket_id}`)}
                  className="w-full flex items-center gap-2 mt-1 px-3 py-2 rounded-lg text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 hover:bg-amber-500/20">
                  <Wrench size={13} /> {t('factoryMap.openTicket')} {detail.open_ticket_number ?? ''}
                </button>
              )}
            </div>

            {/* Live maintenance KPIs (last 30 days) — only for items linked to a machine */}
            {detail.machine_id && (
              <div className="mt-4 pt-3 border-t border-gray-800">
                <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">{t('factoryMap.liveKpis')}</p>
                {kpiLoading ? (
                  <p className="text-xs text-gray-600">{t('factoryMap.loading')}</p>
                ) : kpi ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { label: t('factoryMap.oee'), value: kpi.oee_pct != null ? `${Math.round(kpi.oee_pct)}%` : '—' },
                        { label: t('factoryMap.availability'), value: kpi.availability_pct != null ? `${Math.round(kpi.availability_pct)}%` : '—' },
                        { label: t('factoryMap.performance'), value: kpi.performance_pct != null ? `${Math.round(kpi.performance_pct)}%` : '—' },
                        { label: t('factoryMap.quality'), value: kpi.quality_pct != null ? `${Math.round(kpi.quality_pct)}%` : '—' },
                        { label: t('factoryMap.partsPerHour'), value: kpi.parts_per_hour != null ? String(Math.round(kpi.parts_per_hour)) : '—' },
                      ].map((m) => (
                        <div key={m.label} className="rounded-lg bg-gray-900 border border-gray-800 px-2.5 py-2">
                          <p className="text-[10px] text-gray-500">{m.label}</p>
                          <p className="text-sm font-semibold text-gray-200">{m.value}</p>
                        </div>
                      ))}
                    </div>

                    <p className="text-[11px] uppercase tracking-wide text-gray-500 mt-4 mb-2">{t('factoryMap.reliability')}</p>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { label: t('factoryMap.mtbf'), value: kpi.mtbf_hours != null ? `${Math.round(kpi.mtbf_hours)} h` : '—' },
                        { label: t('factoryMap.mttr'), value: kpi.mttr_hours != null ? `${kpi.mttr_hours.toFixed(1)} h` : '—' },
                        { label: t('factoryMap.downtime'), value: kpi.downtime_hours != null ? `${Math.round(kpi.downtime_hours)} h` : '—' },
                        { label: t('factoryMap.failures'), value: kpi.failures != null ? String(kpi.failures) : '—' },
                        { label: t('factoryMap.backlog'), value: String(kpi.backlog_count) },
                        { label: t('factoryMap.pmCompliance'), value: kpi.pm_compliance_pct != null ? `${Math.round(kpi.pm_compliance_pct)}%` : '—' },
                        { label: t('factoryMap.maintCost'), value: kpi.total_cost_cad != null ? `$${Math.round(kpi.total_cost_cad).toLocaleString()}` : '—' },
                      ].map((m) => (
                        <div key={m.label} className="rounded-lg bg-gray-900 border border-gray-800 px-2.5 py-2">
                          <p className="text-[10px] text-gray-500">{m.label}</p>
                          <p className="text-sm font-semibold text-gray-200">{m.value}</p>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-gray-600">{t('factoryMap.noKpi')}</p>
                )}
              </div>
            )}

            <button onClick={() => openMachinePage(detail)}
              className="w-full flex items-center justify-center gap-1.5 mt-4 px-3 py-2 rounded-lg text-sm text-white bg-indigo-600 hover:bg-indigo-500">
              <ExternalLink size={14} /> {t('factoryMap.openMachinePage')}
            </button>
          </aside>
        )}

        {/* OF panel (View mode) — a conveyor tied to a machine lists its Ordres de fabrication */}
        {!editMode && ofPanel && (
          <aside className="w-80 flex-shrink-0 border-l border-gray-800 overflow-y-auto p-4">
            <div className="flex items-start justify-between mb-1">
              <h3 className="text-white font-semibold text-sm leading-snug flex items-center gap-2">
                <Boxes size={16} className="text-purple-400" />
                {ofPanel.role === 'input' ? t('factoryMap.ofInput')
                  : ofPanel.role === 'output' ? t('factoryMap.ofOutput')
                  : t('factoryMap.ofTitle')}
              </h3>
              <button onClick={() => setOfPanel(null)} className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
            </div>
            <p className="text-xs text-gray-500 mb-3">{ofPanel.name}</p>
            {ofList === null ? (
              <p className="text-xs text-gray-600">{t('factoryMap.loading')}</p>
            ) : ofList.length === 0 ? (
              <p className="text-xs text-gray-600">{t('jobOrders.empty')}</p>
            ) : (
              <div className="space-y-2">
                {ofList.map((of) => (
                  <button key={of.id} onClick={() => navigate(`/job-orders/${of.id}`)}
                    className="w-full text-left rounded-lg bg-gray-900 border border-gray-800 hover:border-indigo-600 px-3 py-2 transition-colors">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-purple-300">{of.job_number}</span>
                      <span className="text-[10px] text-gray-500">{t(`jobOrders.status_${of.status}`)}</span>
                    </div>
                    {of.product_name && <p className="text-xs text-gray-400 truncate mt-0.5">{of.product_name}</p>}
                  </button>
                ))}
              </div>
            )}
            <button onClick={() => navigate('/job-orders')}
              className="w-full flex items-center justify-center gap-1.5 mt-4 px-3 py-2 rounded-lg text-sm text-white bg-indigo-600 hover:bg-indigo-500">
              <ExternalLink size={14} /> {t('factoryMap.ofOpenPage')}
            </button>
          </aside>
        )}

        {/* Pit Stop — zone panel (View mode): buffer KPIs + the OFs present */}
        {!editMode && pitStopZone && (
          <aside className="w-80 flex-shrink-0 border-l border-gray-800 overflow-y-auto p-4">
            <div className="flex items-start justify-between mb-3">
              <h3 className="text-white font-semibold text-sm leading-snug flex items-center gap-2">
                <Boxes size={16} className="text-cyan-400" /> {t('pitStop.title')}
              </h3>
              <button onClick={() => setPitStopZone(false)} className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
            </div>
            {!pitStop ? (
              <p className="text-xs text-gray-600">{t('pitStop.loadError')}</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: t('pitStop.kpi.total'), value: String(pitStop.kpis.total) },
                    { label: t('pitStop.kpi.inFull'), value: String(pitStop.kpis.in_full), color: COMPLETENESS_HEX.full },
                    { label: t('pitStop.kpi.almost'), value: String(pitStop.kpis.almost), color: COMPLETENESS_HEX.almost },
                    { label: t('pitStop.kpi.awaiting'), value: String(pitStop.kpis.awaiting) },
                    { label: t('pitStop.kpi.onHold'), value: String(pitStop.kpis.on_hold) },
                    { label: t('pitStop.kpi.released'), value: String(pitStop.kpis.released), color: ofStateColor('released') },
                    { label: t('pitStop.kpi.late'), value: String(pitStop.kpis.late), color: pitStop.kpis.late > 0 ? OF_LATE_HEX : undefined },
                    { label: t('pitStop.kpi.avgAge'), value: fmtAgeMin(pitStop.kpis.avg_age_minutes) },
                  ].map((m) => (
                    <div key={m.label} className="rounded-lg bg-gray-900 border border-gray-800 px-2.5 py-2">
                      <p className="text-[10px] text-gray-500">{m.label}</p>
                      <p className="text-sm font-semibold" style={{ color: m.color ?? '#e5e7eb' }}>{m.value}</p>
                    </div>
                  ))}
                </div>
                {pitStop.kpis.oldest_job_number && (
                  <p className="text-[11px] text-gray-500 mt-2">
                    {t('pitStop.kpi.oldest')}: <span className="text-gray-300 font-mono">{pitStop.kpis.oldest_job_number}</span>
                    {' · '}{fmtAgeMin(pitStop.kpis.oldest_age_minutes)}
                  </p>
                )}
                <p className="text-[11px] uppercase tracking-wide text-gray-500 mt-4 mb-2">{t('pitStop.zonePanelOfs')}</p>
                {pitStop.ofs.length === 0 ? (
                  <p className="text-xs text-gray-600">{t('pitStop.emptyBuffer')}</p>
                ) : (
                  <div className="space-y-1.5">
                    {pitStop.ofs.map((of) => (
                      <button key={of.job_order_id} onClick={() => focusPitStopOf(of)}
                        className="w-full text-left rounded-lg bg-gray-900 border border-gray-800 hover:border-cyan-600 px-3 py-2 transition-colors">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: ofPlateColor(of.state, of.completeness_pct, of.in_full) }} />
                            <span className="font-mono text-xs text-gray-200 truncate">{of.job_number}</span>
                            {of.late ? (
                              <span className="text-[9px] font-bold px-1 rounded" style={{ background: `${OF_LATE_HEX}22`, color: OF_LATE_HEX }}>{t('pitStop.late')}</span>
                            ) : isDueToday(of.scheduled_date) ? (
                              <span className="text-[9px] font-bold px-1 rounded" style={{ background: `${OF_LATE_HEX}22`, color: OF_LATE_HEX }}>{t('pitStop.dueToday')}</span>
                            ) : null}
                            <span className="text-[9px] font-bold px-1 rounded flex-shrink-0"
                              style={{ background: `${of.family === 'sg' ? PIT_SG_ACCENT : PIT_CG_ACCENT}22`, color: of.family === 'sg' ? PIT_SG_ACCENT : PIT_CG_ACCENT }}>
                              {of.family.toUpperCase()}
                            </span>
                          </span>
                          <span className="text-[11px] text-gray-400 flex-shrink-0">
                            {of.completeness_pct != null ? `${Math.round(of.completeness_pct)} %` : '—'}
                          </span>
                        </div>
                        {of.product_name && <p className="text-[11px] text-gray-500 truncate mt-0.5">{of.product_name}</p>}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </aside>
        )}

        {/* Pit Stop — OF detail panel (View mode): completeness per component + actions */}
        {!editMode && pitStopOfId && pitStop && (() => {
          const of = pitStop.ofs.find((o) => o.job_order_id === pitStopOfId) ?? null;
          const catColor = (name: string | null) =>
            pitStop.categories.find((c) => c.name === name)?.color ?? '#9ca3af';
          const canAct = can('pit_stop', 'update');
          const act = (patch: Parameters<typeof patchPitStopOf>[1]) =>
            patchPitStopOf(pitStopOfId, patch).then(refreshPitStop).catch(() => {});
          return (
            <aside className="w-80 flex-shrink-0 border-l border-gray-800 overflow-y-auto p-4">
              <div className="flex items-start justify-between mb-1">
                <h3 className="text-white font-semibold text-sm leading-snug flex items-center gap-2 min-w-0">
                  <span className="w-3 h-3 rounded-sm flex-shrink-0"
                    style={{ background: of ? ofPlateColor(of.state, of.completeness_pct, of.in_full) : COMPLETENESS_HEX.unknown }} />
                  <span className="font-mono truncate">{of?.job_number ?? ''}</span>
                </h3>
                <button onClick={() => setPitStopOfId(null)} className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
              </div>
              {!of ? (
                <p className="text-xs text-gray-600 mt-2">{t('pitStop.ofGone')}</p>
              ) : (
                <>
                  {of.product_name && <p className="text-xs text-gray-400 mb-2">{of.product_name}</p>}
                  <div className="flex flex-wrap items-center gap-1.5 mb-3">
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                      style={{ background: `${ofStateColor(of.state)}22`, color: ofStateColor(of.state) }}>
                      {t(`pitStop.state.${of.state}`)}
                    </span>
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                      style={{ background: `${of.family === 'sg' ? PIT_SG_ACCENT : PIT_CG_ACCENT}22`, color: of.family === 'sg' ? PIT_SG_ACCENT : PIT_CG_ACCENT }}>
                      {of.family === 'sg' ? t('pitStop.family.softGoods') : t('pitStop.family.caseGoods')}
                    </span>
                    {of.late && (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                        style={{ background: `${OF_LATE_HEX}22`, color: OF_LATE_HEX }}>{t('pitStop.late')}</span>
                    )}
                    {!of.late && isDueToday(of.scheduled_date) && (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                        style={{ background: `${OF_LATE_HEX}22`, color: OF_LATE_HEX }}>{t('pitStop.dueToday')}</span>
                    )}
                  </div>
                  {/* completeness bar */}
                  <div className="mb-3">
                    <div className="flex items-center justify-between text-[11px] text-gray-500 mb-1">
                      <span>{t('pitStop.completeness')}</span>
                      <span className="text-gray-300 font-semibold">
                        {of.completeness_pct != null ? `${Math.round(of.completeness_pct)} %` : t('pitStop.noBom')}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden">
                      <div className="h-full rounded-full" style={{
                        width: `${Math.min(of.completeness_pct ?? 0, 100)}%`,
                        background: completenessColor(of.completeness_pct, of.in_full),
                      }} />
                    </div>
                  </div>
                  <div className="space-y-1 text-xs mb-3">
                    <p className="text-gray-400">{t('pitStop.age')}: <span className="text-gray-200">{fmtAgeMin(of.age_minutes)}</span></p>
                    <p className="text-gray-400">{t('pitStop.destination')}: <span className="text-gray-200">{of.destination_name ?? '—'}</span></p>
                    <p className="text-gray-400">{t('pitStop.scheduled')}: <span className="text-gray-200">{of.scheduled_date ?? '—'}</span></p>
                    <p className="text-gray-400">{t('pitStop.positions')}: <span className="text-gray-200 font-mono">{of.positions.length ? of.positions.map((p) => p.code).join(', ') : '—'}</span></p>
                    {of.hold_kind && (
                      <p className="text-gray-400">{t('pitStop.holdReason')}: <span className="text-gray-200">{of.hold_reason ?? '—'}</span></p>
                    )}
                  </div>
                  <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5">{t('pitStop.components')}</p>
                  <div className="space-y-1 mb-3">
                    {of.components.map((c) => (
                      <div key={c.code} className="rounded-lg bg-gray-900 border border-gray-800 px-2.5 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 min-w-0">
                            <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: catColor(c.category) }} />
                            <span className="font-mono text-[11px] text-gray-200 truncate">{c.code}</span>
                            {!c.in_bom && <span className="text-[9px] text-amber-400">{t('pitStop.outsideBom')}</span>}
                          </span>
                          <span className={`text-[11px] flex-shrink-0 ${c.missing > 0 ? 'text-red-400' : 'text-gray-300'}`}>
                            {c.received} / {c.required}
                          </span>
                        </div>
                        {c.missing > 0 && (
                          <p className="text-[10px] text-red-400/80 mt-0.5">{t('pitStop.missingShort', { count: c.missing })}</p>
                        )}
                      </div>
                    ))}
                  </div>
                  {canAct && (
                    <div className="pt-3 border-t border-gray-800 space-y-2">
                      <p className="text-[11px] uppercase tracking-wide text-gray-500">{t('pitStop.actions')}</p>
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-400 flex-1">{t('pitStop.setPriority')}</label>
                        <input
                          key={`${of.job_order_id}-${of.priority ?? ''}`}
                          type="number" min={1} max={99} defaultValue={of.priority ?? ''}
                          placeholder="—"
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            const n = v === '' ? null : Math.max(1, parseInt(v, 10) || 1);
                            if (n !== of.priority) act({ priority: n });
                          }}
                          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                          className="w-16 bg-gray-800 border border-gray-700 rounded text-xs text-gray-200 px-2 py-1 focus:outline-none focus:border-indigo-500"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-400 flex-1">{t('pitStop.state.hold')}</label>
                        <select
                          value={of.hold_kind ?? ''}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (!v) { act({ hold_kind: null }); return; }
                            const reason = window.prompt(t('pitStop.holdReasonPrompt'), of.hold_reason ?? '') ?? '';
                            act({ hold_kind: v as 'hold' | 'quality' | 'rework', hold_reason: reason || null });
                          }}
                          className="bg-gray-800 border border-gray-700 rounded text-xs text-gray-200 px-1.5 py-1 focus:outline-none focus:border-indigo-500"
                        >
                          <option value="">{t('pitStop.hold.none')}</option>
                          <option value="hold">{t('pitStop.hold.hold')}</option>
                          <option value="quality">{t('pitStop.hold.quality')}</option>
                          <option value="rework">{t('pitStop.hold.rework')}</option>
                        </select>
                      </div>
                      {of.released_at ? (
                        <button onClick={() => act({ released: false })}
                          className="w-full px-3 py-2 rounded-lg text-xs text-cyan-200 bg-cyan-500/10 border border-cyan-500/30 hover:bg-cyan-500/20">
                          {t('pitStop.unrelease')}
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            const msg = of.in_full
                              ? t('pitStop.releaseConfirm', { number: of.job_number })
                              : t('pitStop.releaseConfirmIncomplete', { pct: Math.round(of.completeness_pct ?? 0) });
                            if (window.confirm(msg)) act({ released: true });
                          }}
                          className="w-full px-3 py-2 rounded-lg text-sm text-white bg-cyan-600 hover:bg-cyan-500">
                          {t('pitStop.release')}
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </aside>
          );
        })()}
      </div>
    </div>
  );
}
