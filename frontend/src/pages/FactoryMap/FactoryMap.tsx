import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ReactFlow, Background, Controls, MiniMap, NodeResizer,
  useNodesState, type Node, type NodeProps, type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Map as MapIcon, Pencil, Eye, Upload, RefreshCw, Image as ImageIcon,
  Camera, Wrench, RotateCw, RotateCcw, Trash2, X, Plus, ExternalLink, Box, ArrowUpDown, Copy, Maximize2, Minimize2,
} from 'lucide-react';
import api from '../../api/axios';
import { useTranslation } from 'react-i18next';
import { STATUS_HEX as STATUS_COLORS, STATUS_LABEL as STATUS_LABELS } from '../../utils/statusColors';
import { uploadFile } from '../../api/uploads';
import {
  fetchFactoryMap, saveMachineLayout, saveFloorPlan, createZone, saveZone, deleteZone,
  createProp, saveProp, deleteProp,
  type MapMachine, type MapProp, type MachineLayout, type PropPatch,
} from '../../api/factoryMap';
import { fetchKPISummary } from '../../api/workOrders';
import type { KPISummary } from '../../types';
import Factory3D, { PROP_CATALOG, ORBIT_MARGIN, type M3D, type P3D, type Commit, type PropCommit } from './Factory3D';
import { useAuthStore } from '../../store/authStore';

interface Plant { id: string; code: string; name: string; }

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

const BLOCK_KINDS: { key: string; label: string }[] = [
  { key: 'auto', label: 'Auto' },
  { key: 'cobot', label: 'Cobot (animated)' },
  { key: 'conveyor', label: 'Conveyor' },
  { key: 'lift_table', label: 'Lift table' },
  { key: 'beam_saw', label: 'Beam saw (Selco)' },
  { key: 'box', label: 'Plain box' },
];

type ResizeParams = { x: number; y: number; width: number; height: number };
type ZoneLite = { id: string; name: string; color: string };
type MachineNodeData = { machine: MapMachine; editMode?: boolean; onResize?: (p: ResizeParams) => void; onPickPhoto?: (id: string) => void; onRotate?: (id: string) => void; onPickModel?: (id: string) => void; onSetHeight?: (id: string, current: number | null) => void; onSetKind?: (id: string, kind: string) => void };
type ZoneNodeData = { zone: ZoneLite; onResize?: (p: ResizeParams) => void; onDelete?: (id: string) => void; onRename?: (id: string, current: string) => void };
type FloorPlanData = { url: string };

const iconBtn: React.CSSProperties = {
  width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(13,20,33,0.85)', border: '1px solid #374151', borderRadius: 6, color: '#cbd5e1', cursor: 'pointer',
};

// ── Custom nodes ────────────────────────────────────────────────────────────
function MachineNode({ data, selected }: NodeProps) {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || 'en').slice(0, 2);
  const d = data as MachineNodeData;
  const m = d.machine;
  const color = STATUS_COLORS[m.status] ?? STATUS_COLORS.idle;
  const rot = m.rotation_deg ?? 0;
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
      <div style={{
        width: '100%', height: '100%', boxSizing: 'border-box', border: `2px solid ${color}`, borderRadius: 8,
        background: '#0d1421', boxShadow: selected ? '0 0 0 2px #3b82f6' : 'none', color: '#e5e7eb',
        overflow: 'hidden', position: 'relative', transform: rot ? `rotate(${rot}deg)` : undefined,
      }}>
        {m.icon_url && <img src={m.icon_url} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
        {/* status-coloured tint so the whole tile reads green/amber/red at a glance */}
        <div style={{ position: 'absolute', inset: 0, background: color, opacity: 0.2, pointerEvents: 'none' }} />

        {m.open_ticket && (
          <span title={`${t('factoryMap.openTicket')} ${m.open_ticket_number ?? ''}`} style={{ position: 'absolute', top: 4, left: 4, width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f59e0b', color: '#3a2a06', borderRadius: 6, zIndex: 2 }}>
            <Wrench size={12} />
          </span>
        )}

        {m.icon_url ? (
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
              {BLOCK_KINDS.map((k) => <option key={k.key} value={k.key}>{t(`factoryMap.block_${k.key}`)}</option>)}
            </select>
            <button title={t('factoryMap.rotate15')} onClick={(e) => { e.stopPropagation(); d.onRotate?.(m.id); }} style={iconBtn}><RotateCw size={13} /></button>
            <button title={t('factoryMap.height3d')} onClick={(e) => { e.stopPropagation(); d.onSetHeight?.(m.id, m.height_3d ?? null); }} style={iconBtn}><ArrowUpDown size={13} /></button>
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
        onDoubleClick={() => d.onRename?.(z.id, z.name)}
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
  const [unplaced, setUnplaced] = useState<MapMachine[]>([]);
  const [editMode, setEditMode] = useState(false);
  const [assetFilter, setAssetFilter] = useState<'production' | 'auxiliary' | 'all'>('production');
  const [mode3d, setMode3d] = useState(false);
  const [isFull, setIsFull] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const [sel3d, setSel3d] = useState<string | null>(null);
  const [props, setProps] = useState<MapProp[]>([]);
  const [selProp, setSelProp] = useState<string | null>(null);
  const [transformMode, setTransformMode] = useState<'translate' | 'rotate' | 'scale'>('translate');
  const [unplacedSearch, setUnplacedSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<MapMachine | null>(null);
  const [kpi, setKpi] = useState<KPISummary | null>(null);
  const [kpiLoading, setKpiLoading] = useState(false);
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
  // a machine being dragged carries its orbit along: capture both start positions on drag start
  const dragRef = useRef<{ machineId: string; mStart: { x: number; y: number }; orbitId: string | null; oStart: { x: number; y: number }; oSize: { w: number; h: number } } | null>(null);
  // reflect Edit/View: machine nodes get the flag; orbit rectangles only show in Edit
  useEffect(() => {
    setNodes((nds) => nds.map((n) => {
      if (n.type === 'machine') return { ...n, data: { ...n.data, editMode } };
      if (n.type === 'orbit') return { ...n, hidden: !editMode };
      return n;
    }));
  }, [editMode, setNodes]);

  // ── per-node action callbacks (stable) ──
  const pickPhoto = useCallback((id: string) => { photoTargetRef.current = id; photoInputRef.current?.click(); }, []);

  const onPhotoSelected = useCallback(async (file: File) => {
    const id = photoTargetRef.current;
    if (!id) return;
    const up = await uploadFile(file);
    await saveMachineLayout(id, { icon_url: up.url });
    setNodes((nds) => nds.map((n) => n.id === id
      ? { ...n, data: { ...n.data, machine: { ...(n.data as MachineNodeData).machine, icon_url: up.url } } } : n));
  }, [setNodes]);

  const pickModel = useCallback((id: string) => { propModelTargetRef.current = null; modelTargetRef.current = id; modelInputRef.current?.click(); }, []);
  const pickPropModel = useCallback((id: string) => { modelTargetRef.current = null; propModelTargetRef.current = id; modelInputRef.current?.click(); }, []);

  const onModelSelected = useCallback(async (file: File) => {
    const propId = propModelTargetRef.current;
    const id = modelTargetRef.current;
    if (!propId && !id) return;
    try {
      const up = await uploadFile(file);
      if (propId) {                                     // .glb for a decorative prop
        await saveProp(propId, { model_url: up.url });
        setProps((ps) => ps.map((p) => (p.id === propId ? { ...p, model_url: up.url } : p)));
        propModelTargetRef.current = null;
        return;
      }
      await saveMachineLayout(id!, { model_url: up.url });
      setNodes((nds) => nds.map((n) => n.id === id
        ? { ...n, data: { ...n.data, machine: { ...(n.data as MachineNodeData).machine, model_url: up.url } } } : n));
    } catch (e) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      window.alert(`${t('factoryMap.modelUploadFailed')}: ${msg ?? 'error'}`);
    }
  }, [setNodes]);

  const setHeight = useCallback((id: string, current: number | null) => {
    const v = window.prompt(t('factoryMap.height3dPrompt'), current != null ? String(current) : '');
    if (v == null) return;
    const h = parseFloat(v.replace(',', '.'));
    if (!Number.isFinite(h) || h <= 0) return;
    saveMachineLayout(id, { height_3d: h }).catch(() => {});
    setNodes((nds) => nds.map((n) => n.id === id
      ? { ...n, data: { ...n.data, machine: { ...(n.data as MachineNodeData).machine, height_3d: h } } } : n));
  }, [setNodes]);

  const setKind = useCallback((id: string, kind: string) => {
    const value = kind === 'auto' ? null : kind;
    saveMachineLayout(id, { block_kind: value }).catch(() => {});
    setNodes((nds) => nds.map((n) => n.id === id
      ? { ...n, data: { ...n.data, machine: { ...(n.data as MachineNodeData).machine, block_kind: value } } } : n));
  }, [setNodes]);

  const rotateMachine = useCallback((id: string) => {
    setNodes((nds) => nds.map((n) => {
      if (n.id !== id) return n;
      const cur = (n.data as MachineNodeData).machine;
      const deg = ((cur.rotation_deg ?? 0) + 15) % 360;
      saveMachineLayout(id, { rotation_deg: deg }).catch(() => {});
      return { ...n, data: { ...n.data, machine: { ...cur, rotation_deg: deg } } };
    }));
  }, [setNodes]);

  const renameZone = useCallback((zoneId: string, current: string) => {
    if (!editModeRef.current) return;
    const name = window.prompt(t('factoryMap.zoneNamePrompt'), current);
    if (name == null) return;
    saveZone(zoneId, { name }).catch(() => {});
    setNodes((nds) => nds.map((n) => n.id === `zone-${zoneId}`
      ? { ...n, data: { ...n.data, zone: { ...(n.data as ZoneNodeData).zone, name } } } : n));
  }, [setNodes]);

  const removeZone = useCallback((zoneId: string) => {
    deleteZone(zoneId).catch(() => {});
    setNodes((nds) => nds.filter((n) => n.id !== `zone-${zoneId}`));
  }, [setNodes]);

  const buildNodes = useCallback((data: Awaited<ReturnType<typeof fetchFactoryMap>>): Node[] => {
    const out: Node[] = [];
    if (data.floor_plan_url) {
      out.push({ id: 'floorplan', type: 'floorplan', position: { x: 0, y: 0 }, data: { url: data.floor_plan_url }, draggable: false, selectable: false, deletable: false, zIndex: -1 });
    }
    for (const z of data.zones) {
      out.push({
        id: `zone-${z.id}`, type: 'zone', position: { x: z.pos_x, y: z.pos_y },
        width: z.pos_w, height: z.pos_h, zIndex: 0,
        data: {
          zone: { id: z.id, name: z.name, color: z.color },
          onDelete: removeZone, onRename: renameZone,
          onResize: (p: ResizeParams) => saveZone(z.id, { pos_x: Math.round(p.x), pos_y: Math.round(p.y), pos_w: Math.round(p.width), pos_h: Math.round(p.height) }).catch(() => {}),
        },
      });
    }
    for (const m of data.machines) {
      if (m.pos_x == null || m.pos_y == null) continue;
      // Resizable orbit rectangle for production machines (hidden outside edit mode)
      if ((m.asset_type ?? 'production') === 'production') {
        const r = orbitRectFor(m);
        out.push({
          // An orbit belongs to its machine — never independently draggable (it would drift away).
          // Reshape it with the resize handles; it follows the machine when the machine is moved.
          id: `orbit-${m.id}`, type: 'orbit', position: { x: r.x, y: r.y }, width: r.w, height: r.h,
          zIndex: 0, hidden: !editModeRef.current, deletable: false, draggable: false,
          data: {
            machineId: m.id, machineName: m.name,
            onResize: (p: ResizeParams) => {
              const patch = { orbit_x: Math.round(p.x), orbit_y: Math.round(p.y), orbit_w: Math.round(p.width), orbit_h: Math.round(p.height) };
              saveMachineLayout(m.id, patch).catch(() => {});
              setNodes((nds) => nds.map((n) => n.id === m.id ? { ...n, data: { ...n.data, machine: { ...(n.data as MachineNodeData).machine, ...patch } } } : n));
              // a redrawn orbit may now cover (or release) cobots — relink them
              reconcileChildrenRef.current(m.id, { x: p.x, y: p.y, w: p.width, h: p.height });
            },
          },
        });
      }
      out.push({
        id: m.id, type: 'machine', position: { x: m.pos_x, y: m.pos_y },
        width: m.pos_w ?? 152, height: m.pos_h ?? 64, zIndex: 1,
        data: {
          machine: m, editMode: editModeRef.current, onPickPhoto: pickPhoto, onRotate: rotateMachine, onPickModel: pickModel, onSetHeight: setHeight, onSetKind: setKind,
          onResize: (p: ResizeParams) => saveMachineLayout(m.id, { pos_x: Math.round(p.x), pos_y: Math.round(p.y), pos_w: Math.round(p.width), pos_h: Math.round(p.height) }).catch(() => {}),
        },
      });
    }
    return out;
  }, [pickPhoto, rotateMachine, removeZone, renameZone, pickModel, setHeight, setKind, setNodes]);

  useEffect(() => {
    api.get<Plant[] | { items: Plant[] }>('/api/plants/')
      .then(({ data }) => {
        const list = Array.isArray(data) ? data : (data.items ?? []);
        // Saint-Jérôme (PLT1) is the main plant — show/select it first.
        const isSJ = (p: Plant) => p.code === 'PLT1' || /j[eé]r/i.test(p.name);
        const sorted = [...list].sort((a, b) => (isSJ(a) ? 0 : 1) - (isSJ(b) ? 0 : 1) || a.name.localeCompare(b.name));
        setPlants(sorted);
        if (sorted.length) setPlantId((p) => p || sorted[0].id);
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true);
    try {
      const data = await fetchFactoryMap(id, assetFilter);
      setFloorPlanUrl(data.floor_plan_url);
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
    } finally {
      setLoading(false);
    }
  }, [buildNodes, setNodes, assetFilter]);

  // Reload on plant change and on edit-mode toggle — entering edit mode triggers the orbit self-heal.
  useEffect(() => { if (plantId) load(plantId); }, [plantId, load, editMode]);

  useEffect(() => {
    if (editMode || !plantId) return;
    const t = setInterval(() => load(plantId), 30000);   // slow fallback; WS does the live push
    return () => clearInterval(t);
  }, [editMode, plantId, load]);

  const applyStatus = useCallback((list: Array<{ id: string; status: string; operator: string | null; open_ticket: boolean; open_ticket_id: string | null; open_ticket_number: string | null }>) => {
    const byId = new Map(list.map((s) => [s.id, s]));
    setNodes((nds) => nds.map((n) => {
      if (n.type !== 'machine') return n;
      const s = byId.get(n.id);
      if (!s) return n;
      const mm = (n.data as MachineNodeData).machine;
      return { ...n, data: { ...n.data, machine: { ...mm, status: s.status, operator: s.operator, open_ticket: s.open_ticket, open_ticket_id: s.open_ticket_id, open_ticket_number: s.open_ticket_number } } };
    }));
    setUnplaced((u) => u.map((m) => { const s = byId.get(m.id); return s ? { ...m, status: s.status } : m; }));
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
      ws.onmessage = (ev) => { try { const d = JSON.parse(ev.data); if (d.machines) applyStatus(d.machines); } catch { /* ignore */ } };
      ws.onclose = () => { if (!closed) retry = setTimeout(connect, 5000); };
      ws.onerror = () => { ws?.close(); };
    };
    connect();
    return () => { closed = true; if (retry) clearTimeout(retry); ws?.close(); };
  }, [editMode, plantId, token, applyStatus]);

  // Capture both the machine's and its orbit's start positions so the orbit can ride along.
  const onNodeDragStart = useCallback((_: unknown, node: Node) => {
    if (node.type !== 'machine') { dragRef.current = null; return; }
    const orbit = nodesRef.current.find((n) => n.id === `orbit-${node.id}`);
    dragRef.current = {
      machineId: node.id, mStart: { ...node.position },
      orbitId: orbit?.id ?? null,
      oStart: orbit ? { ...orbit.position } : { x: 0, y: 0 },
      oSize: { w: orbit?.width ?? 0, h: orbit?.height ?? 0 },
    };
  }, []);

  // While the machine drags, its orbit follows live by the same delta.
  const onNodeDrag = useCallback((_: unknown, node: Node) => {
    const d = dragRef.current;
    if (!d || d.machineId !== node.id || !d.orbitId) return;
    const dx = node.position.x - d.mStart.x, dy = node.position.y - d.mStart.y;
    setNodes((nds) => nds.map((n) => n.id === d.orbitId ? { ...n, position: { x: d.oStart.x + dx, y: d.oStart.y + dy } } : n));
  }, [setNodes]);

  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    if (node.id === 'floorplan' || node.type === 'orbit') { dragRef.current = null; return; }
    const pos = { pos_x: Math.round(node.position.x), pos_y: Math.round(node.position.y) };
    if (node.type === 'zone') { saveZone((node.data as ZoneNodeData).zone.id, pos).catch(() => {}); return; }

    // Machine moved: persist its position and auto-link it if it is itself an orbit child.
    saveMachineLayout(node.id, pos).catch(() => {});
    autoLinkRef.current(node.id, node.position.x, node.position.y, node.width ?? 152, node.height ?? 64);

    // Carry the orbit along by the same delta, persist it, and relink any cobots it now covers.
    const d = dragRef.current;
    if (d && d.machineId === node.id && d.orbitId) {
      const dx = node.position.x - d.mStart.x, dy = node.position.y - d.mStart.y;
      const ox = Math.round(d.oStart.x + dx), oy = Math.round(d.oStart.y + dy);
      const opatch = { orbit_x: ox, orbit_y: oy };
      saveMachineLayout(node.id, opatch).catch(() => {});
      setNodes((nds) => nds.map((n) => {
        if (n.id === d.orbitId) return { ...n, position: { x: ox, y: oy } };
        if (n.id === node.id) return { ...n, data: { ...n.data, machine: { ...(n.data as MachineNodeData).machine, ...opatch } } };
        return n;
      }));
      reconcileChildrenRef.current(node.id, { x: ox, y: oy, w: d.oSize.w, h: d.oSize.h });
    }
    dragRef.current = null;
  }, [setNodes]);

  const onNodeClick: NodeMouseHandler = useCallback((_, node) => {
    if (editMode || node.id === 'floorplan' || node.type === 'zone') return;
    setDetail((node.data as MachineNodeData).machine);
  }, [editMode]);

  const placeMachine = useCallback(async (m: MapMachine) => {
    const placedCount = nodes.filter((n) => n.type === 'machine').length;
    const x = 60 + (placedCount % 6) * 40;
    const y = 60 + (placedCount % 6) * 40;
    setNodes((nds) => [...nds, {
      id: m.id, type: 'machine', position: { x, y }, width: 152, height: 64, zIndex: 1,
      data: {
        machine: { ...m, pos_x: x, pos_y: y, placed: true }, editMode: editModeRef.current, onPickPhoto: pickPhoto, onRotate: rotateMachine, onPickModel: pickModel, onSetHeight: setHeight, onSetKind: setKind,
        onResize: (p: ResizeParams) => saveMachineLayout(m.id, { pos_x: Math.round(p.x), pos_y: Math.round(p.y), pos_w: Math.round(p.width), pos_h: Math.round(p.height) }).catch(() => {}),
      },
    }]);
    setUnplaced((u) => u.filter((x2) => x2.id !== m.id));
    try { await saveMachineLayout(m.id, { pos_x: x, pos_y: y }); } catch { /* ignore */ }
  }, [nodes, setNodes, pickPhoto, rotateMachine, pickModel, setHeight, setKind]);

  const onUploadFloorPlan = useCallback(async (file: File) => {
    if (!plantId) return;
    setLoading(true);
    try { const up = await uploadFile(file); await saveFloorPlan(plantId, up.url); await load(plantId); }
    finally { setLoading(false); }
  }, [plantId, load]);

  const addZone = useCallback(async () => {
    if (!plantId) return;
    await createZone(plantId, { name: 'Zone', pos_x: 40, pos_y: 40, pos_w: 320, pos_h: 220, color: '#6366f1' });
    await load(plantId);
  }, [plantId, load]);

  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {};
    nodes.forEach((n) => { if (n.type === 'machine') { const s = (n.data as MachineNodeData).machine.status; c[s] = (c[s] ?? 0) + 1; } });
    return c;
  }, [nodes]);

  const machines3d = useMemo<M3D[]>(() => nodes
    .filter((n) => n.type === 'machine')
    .map((n) => {
      const mm = (n.data as MachineNodeData).machine;
      return { id: mm.id, name: mm.name, status: mm.status, pos_x: n.position.x, pos_y: n.position.y, pos_w: n.width ?? 152, pos_h: n.height ?? 64, icon_url: mm.icon_url, model_url: mm.model_url, height_3d: mm.height_3d, model_scale: mm.model_scale, scale_y: mm.scale_y, scale_z: mm.scale_z, rotation_deg: mm.rotation_deg, family: mm.family, subtype: mm.subtype, function_label: mm.function_label, block_kind: mm.block_kind, asset_type: mm.asset_type, orbit_x: mm.orbit_x, orbit_y: mm.orbit_y, orbit_w: mm.orbit_w, orbit_h: mm.orbit_h };
    }), [nodes]);

  const onMachine3d = useCallback((id: string) => {
    setSelProp(null);                                   // selecting a machine clears any prop selection
    if (editMode) { setSel3d(id || null); return; }
    if (!id) return;
    const n = nodes.find((x) => x.id === id);
    if (n) setDetail((n.data as MachineNodeData).machine);
  }, [editMode, nodes]);

  const onCommit3d = useCallback<Commit>((id, patch) => {
    saveMachineLayout(id, patch).catch(() => {});
    const node = nodes.find((n) => n.id === id);
    setNodes((nds) => nds.map((n) => {
      if (n.id !== id) return n;
      const mm = (n.data as MachineNodeData).machine;
      return { ...n, position: { x: patch.pos_x, y: patch.pos_y }, data: { ...n.data, machine: { ...mm, model_scale: patch.model_scale, scale_y: patch.scale_y, scale_z: patch.scale_z, rotation_deg: patch.rotation_deg, pos_x: patch.pos_x, pos_y: patch.pos_y } } };
    }));
    autoLinkRef.current(id, patch.pos_x, patch.pos_y, node?.width ?? 152, node?.height ?? 64);
  }, [setNodes, nodes]);

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

  // Resolve each prop's live status from its linked equipment (updates as WS pushes status).
  const props3d = useMemo<P3D[]>(
    () => props.map((p) => ({ ...p, status: p.equipment_id ? (equipById.get(p.equipment_id)?.status ?? null) : null })),
    [props, equipById],
  );

  const onSelectProp = useCallback((id: string) => {
    setSel3d(null);                                     // selecting a prop clears any machine selection
    if (!editMode) {                                    // view mode: a linked block opens its equipment
      if (!id) { setSelProp(null); return; }
      const pr = props.find((p) => p.id === id);
      const eq = pr?.equipment_id ? equipById.get(pr.equipment_id) : null;
      if (eq) setDetail(eq);
      return;
    }
    setSelProp(id || null);
  }, [editMode, props, equipById]);

  const linkProp = useCallback((id: string, equipment_id: string | null) => {
    saveProp(id, { equipment_id }).catch(() => {});
    setProps((ps) => ps.map((p) => (p.id === id ? { ...p, equipment_id } : p)));
  }, []);

  // Precise rotation by exact increments (persists immediately) — for the selected block/machine.
  const rotateProp = useCallback((id: string, delta: number) => {
    setProps((ps) => ps.map((p) => {
      if (p.id !== id) return p;
      const deg = ((((p.rotation_deg ?? 0) + delta) % 360) + 360) % 360;
      saveProp(id, { rotation_deg: deg }).catch(() => {});
      return { ...p, rotation_deg: deg };
    }));
  }, []);

  const rotateMachineBy = useCallback((id: string, delta: number) => {
    setNodes((nds) => nds.map((n) => {
      if (n.id !== id) return n;
      const cur = (n.data as MachineNodeData).machine;
      const deg = ((((cur.rotation_deg ?? 0) + delta) % 360) + 360) % 360;
      saveMachineLayout(id, { rotation_deg: deg }).catch(() => {});
      return { ...n, data: { ...n.data, machine: { ...cur, rotation_deg: deg } } };
    }));
  }, [setNodes]);

  const rotateSelected = useCallback((delta: number) => {
    if (selProp) rotateProp(selProp, delta);
    else if (sel3d) rotateMachineBy(sel3d, delta);
  }, [selProp, sel3d, rotateProp, rotateMachineBy]);

  // Set the parent machine a cobot/conveyor serves (drives "stop with the machine").
  const setParent = useCallback((id: string, parent_equipment_id: string | null) => {
    saveMachineLayout(id, { parent_equipment_id }).catch(() => {});
    setNodes((nds) => nds.map((n) => n.id === id
      ? { ...n, data: { ...n.data, machine: { ...(n.data as MachineNodeData).machine, parent_equipment_id } } } : n));
  }, [setNodes]);

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
    const node = nodes.find((n) => n.id === id);
    const mm = node ? (node.data as MachineNodeData).machine : null;
    if (!mm || !isOrbitChild(mm)) return;
    const parentId = findOrbitParent(posX + w / 2, posY + h / 2, id);
    if ((mm.parent_equipment_id ?? null) !== (parentId ?? null)) setParent(id, parentId);
  }, [nodes, findOrbitParent, setParent]);
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
      if (inside && cur !== hostId) setParent(n.id, hostId);
      else if (!inside && cur === hostId) setParent(n.id, null);
    }
  }, [setParent]);
  useEffect(() => { reconcileChildrenRef.current = reconcileHostChildren; }, [reconcileHostChildren]);

  const addProp = useCallback(async (kind: string) => {
    if (!plantId) return;
    const cat = PROP_CATALOG.find((c) => c.kind === kind) ?? PROP_CATALOG[PROP_CATALOG.length - 1];
    const created = await createProp(plantId, {
      kind: cat.kind, pos_w: cat.w, pos_h: cat.h, height_3d: cat.height,
      pos_x: Math.round(mapCenter.x - cat.w / 2), pos_y: Math.round(mapCenter.y - cat.h / 2),
    });
    setProps((ps) => [...ps, created]);
    setSel3d(null);
    setSelProp(created.id);
  }, [plantId, mapCenter]);

  const onPropCommit = useCallback<PropCommit>((id, patch) => {
    saveProp(id, patch).catch(() => {});
    setProps((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const deleteSelProp = useCallback(() => {
    if (!selProp) return;
    deleteProp(selProp).catch(() => {});
    setProps((ps) => ps.filter((p) => p.id !== selProp));
    setSelProp(null);
  }, [selProp]);

  // Duplicate the selected block — exact same size/scale/rotation, offset a little
  // so the copy is visible. Starts UNLINKED (a clone shouldn't share the original's
  // equipment link). createProp can't set the scale fields, so we patch them after.
  const duplicateSelProp = useCallback(async () => {
    if (!selProp || !plantId) return;
    const src = props.find((p) => p.id === selProp);
    if (!src) return;
    const OFFSET = 30;   // px, so the clone doesn't sit exactly on top of the original
    const created = await createProp(plantId, {
      kind: src.kind,
      label: src.label,
      model_url: src.model_url,
      pos_x: Math.round(src.pos_x + OFFSET),
      pos_y: Math.round(src.pos_y + OFFSET),
      pos_w: src.pos_w,
      pos_h: src.pos_h,
      rotation_deg: src.rotation_deg ?? 0,
      height_3d: src.height_3d,
    });
    const scalePatch: PropPatch = {};
    if (src.model_scale != null) scalePatch.model_scale = src.model_scale;
    if (src.scale_y != null) scalePatch.scale_y = src.scale_y;
    if (src.scale_z != null) scalePatch.scale_z = src.scale_z;
    let copy = created;
    if (Object.keys(scalePatch).length) {
      await saveProp(created.id, scalePatch);
      copy = { ...created, ...scalePatch };
    }
    setProps((ps) => [...ps, copy]);
    setSel3d(null);
    setSelProp(copy.id);
  }, [selProp, plantId, props]);

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

  useEffect(() => { if (!mode3d || !editMode) { setSel3d(null); setSelProp(null); } }, [mode3d, editMode]);

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

        <span className="inline-flex rounded-lg border border-gray-700 overflow-hidden text-sm">
          <button onClick={() => setEditMode(false)} className={`flex items-center gap-1.5 px-3 py-1.5 ${!editMode ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}><Eye size={14} /> {t('factoryMap.view')}</button>
          <button onClick={() => { setEditMode(true); setDetail(null); }} className={`flex items-center gap-1.5 px-3 py-1.5 ${editMode ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}><Pencil size={14} /> {t('factoryMap.edit')}</button>
        </span>

        {editMode && !mode3d && (
          <>
            <button onClick={addZone} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-300 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg">
              <Plus size={14} /> {t('factoryMap.addZone')}
            </button>
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
          {!mode3d && !floorPlanUrl && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 text-xs text-gray-500 bg-gray-900/80 border border-gray-800 rounded-full px-3 py-1">
              <ImageIcon size={12} /> {t('factoryMap.noFloorPlan')}{editMode ? t('factoryMap.noFloorPlanEdit') : ''}
            </div>
          )}
          {mode3d ? (
            <Factory3D key={plantId} machines={machines3d} floorPlanUrl={floorPlanUrl} onSelect={onMachine3d}
              editMode={editMode} selectedId={sel3d} mode={transformMode} onCommit={onCommit3d}
              props={props3d} onSelectProp={onSelectProp} selectedPropId={selProp} onPropCommit={onPropCommit}
              infoId={!editMode ? (detail?.id ?? null) : null} infoKpi={kpi} />
          ) : (
          <ReactFlow
            nodes={nodes} onNodesChange={onNodesChange} nodeTypes={nodeTypes}
            onNodeDragStart={onNodeDragStart} onNodeDrag={onNodeDrag} onNodeDragStop={onNodeDragStop} onNodeClick={onNodeClick}
            nodesDraggable={editMode} nodesConnectable={false} elementsSelectable={editMode}
            colorMode="dark" fitView minZoom={0.2} proOptions={{ hideAttribution: true }} style={{ background: 'transparent' }}
          >
            <Background gap={24} color="#1f2937" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => n.type === 'machine' ? (STATUS_COLORS[(n.data as MachineNodeData).machine?.status] ?? '#6b7280') : (n.type === 'zone' ? (n.data as ZoneNodeData).zone.color : 'transparent')} />
          </ReactFlow>
          )}
          {mode3d && editMode && (
            <div className="absolute top-3 left-3 z-10 flex items-center gap-2 bg-gray-900/90 border border-gray-700 rounded-lg px-2 py-1.5">
              <span className="inline-flex rounded border border-gray-700 overflow-hidden text-xs">
                <button onClick={() => setTransformMode('translate')} className={`px-2 py-1 ${transformMode === 'translate' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>{t('factoryMap.move')}</button>
                <button onClick={() => setTransformMode('rotate')} className={`px-2 py-1 ${transformMode === 'rotate' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>{t('factoryMap.rotate')}</button>
                <button onClick={() => setTransformMode('scale')} className={`px-2 py-1 ${transformMode === 'scale' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>{t('factoryMap.scale')}</button>
              </span>
              {sel3d && (
                <select
                  title={t('factoryMap.parentTitle')}
                  value={(nodes.find((n) => n.id === sel3d)?.data as MachineNodeData | undefined)?.machine.parent_equipment_id ?? ''}
                  onChange={(e) => setParent(sel3d, e.target.value || null)}
                  className="bg-gray-800 border border-gray-700 rounded text-xs text-gray-200 px-1.5 py-1 max-w-[150px] focus:outline-none focus:border-indigo-500"
                >
                  <option value="">{t('factoryMap.noParent')}</option>
                  {equipOptions.filter((o) => o.id !== sel3d).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              )}
              {(sel3d || selProp) && (
                <span className="inline-flex items-center rounded border border-gray-700 overflow-hidden">
                  <button onClick={() => rotateSelected(-90)} title={t('factoryMap.rotateNeg90')} className="px-1.5 py-1 text-[11px] text-gray-300 hover:bg-gray-700">-90°</button>
                  <button onClick={() => rotateSelected(-45)} title={t('factoryMap.rotateNeg45')} className="flex items-center gap-0.5 px-1.5 py-1 text-[11px] text-gray-300 hover:bg-gray-700"><RotateCcw size={13} />45°</button>
                  <button onClick={() => rotateSelected(45)} title={t('factoryMap.rotatePos45')} className="flex items-center gap-0.5 px-1.5 py-1 text-[11px] text-gray-300 hover:bg-gray-700"><RotateCw size={13} />45°</button>
                  <button onClick={() => rotateSelected(90)} title={t('factoryMap.rotatePos90')} className="px-1.5 py-1 text-[11px] text-gray-300 hover:bg-gray-700">+90°</button>
                </span>
              )}
              <span className="text-xs text-gray-500">
                {selProp ? t('factoryMap.hintBlock') : sel3d ? t('factoryMap.hintMachine') : t('factoryMap.hintNone')}
              </span>
              {selProp && (
                <>
                  <select
                    title={t('factoryMap.linkTitle')}
                    value={props.find((p) => p.id === selProp)?.equipment_id ?? ''}
                    onChange={(e) => linkProp(selProp, e.target.value || null)}
                    className="bg-gray-800 border border-gray-700 rounded text-xs text-gray-200 px-1.5 py-1 max-w-[150px] focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">{t('factoryMap.notLinked')}</option>
                    {equipOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                  <button onClick={() => pickPropModel(selProp)} title={t('factoryMap.uploadGlb')} className="flex items-center gap-1 text-xs text-gray-300 hover:text-white">
                    <Box size={12} /> .glb
                  </button>
                  <button onClick={duplicateSelProp} title={t('factoryMap.duplicateTitle')} className="flex items-center gap-1 text-xs text-gray-300 hover:text-white">
                    <Copy size={12} /> {t('factoryMap.duplicate')}
                  </button>
                  <button onClick={deleteSelProp} className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300">
                    <Trash2 size={12} /> {t('factoryMap.deleteBlock')}
                  </button>
                </>
              )}
              {(sel3d || selProp) && <button onClick={() => { setSel3d(null); setSelProp(null); }} className="text-xs text-gray-400 hover:text-gray-200">✕</button>}
            </div>
          )}

          {/* Block palette — add decorative support equipment directly in 3D */}
          {mode3d && editMode && (
            <div className="absolute bottom-3 left-3 z-10 max-w-[220px] bg-gray-900/90 border border-gray-700 rounded-lg p-2">
              <p className="text-[11px] text-gray-500 mb-1.5 px-0.5">{t('factoryMap.addBlock')}</p>
              <div className="flex flex-wrap gap-1.5">
                {PROP_CATALOG.map((c) => (
                  <button key={c.kind} onClick={() => addProp(c.kind)} title={`${t('factoryMap.add')} ${t(`factoryMap.block_${c.kind}`)}`}
                    className="flex items-center gap-1 px-2 py-1 text-[11px] text-gray-200 bg-gray-800 hover:bg-indigo-600 border border-gray-700 rounded">
                    <Plus size={11} /> {t(`factoryMap.block_${c.kind}`)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Detail panel (View mode) */}
        {!editMode && detail && (
          <aside className="w-72 flex-shrink-0 border-l border-gray-800 overflow-y-auto p-4">
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
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { label: t('factoryMap.oee'), value: kpi.oee_pct != null ? `${Math.round(kpi.oee_pct)}%` : '—', tone: 'text-gray-200' },
                      { label: t('factoryMap.availability'), value: kpi.availability_pct != null ? `${Math.round(kpi.availability_pct)}%` : '—', tone: 'text-gray-200' },
                      { label: t('factoryMap.partsPerHour'), value: kpi.parts_per_hour != null ? String(Math.round(kpi.parts_per_hour)) : '—', tone: 'text-gray-200' },
                      { label: t('factoryMap.quality'), value: kpi.quality_pct != null ? `${Math.round(kpi.quality_pct)}%` : '—', tone: 'text-gray-200' },
                    ].map((m) => (
                      <div key={m.label} className="rounded-lg bg-gray-900 border border-gray-800 px-2.5 py-2">
                        <p className="text-[10px] text-gray-500">{m.label}</p>
                        <p className={`text-sm font-semibold ${m.tone}`}>{m.value}</p>
                      </div>
                    ))}
                  </div>
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
      </div>
    </div>
  );
}
