import { useCallback, useMemo } from 'react';
import type { Node } from '@xyflow/react';
import {
  saveMachineLayout, saveZone, createZone, deleteZone, saveProp, createProp, deleteProp,
  saveSensorLayout,
  type MapMachine, type MapProp, type MapSensor, type MachineLayout, type PropPatch, type ZonePatch, type PropCreate,
} from '../../api/factoryMap';
import { useEditorStore } from './editorStore';

// ── One funnel for every map mutation ─────────────────────────────────────────
// Each verb applies the change optimistically to the page state, persists it
// through the save ledger (Saving…/Saved/Failed), and pushes an undo/redo entry
// whose closures re-read live state through `io` — so history survives reloads
// and works from either the 2D or the 3D editor.

type XY = { x: number; y: number };

export interface EditorIO {
  getNodes: () => Node[];
  setNodes: (updater: (nds: Node[]) => Node[]) => void;
  getProps: () => MapProp[];
  setProps: (updater: (ps: MapProp[]) => MapProp[]) => void;
  getSensors: () => MapSensor[];
  setSensors: (updater: (ss: MapSensor[]) => MapSensor[]) => void;
  getUnplaced: () => MapMachine[];
  setUnplaced: (updater: (ms: MapMachine[]) => MapMachine[]) => void;
  makeMachineNode: (m: MapMachine) => Node;
  makeOrbitNode: (m: MapMachine) => Node | null;
  makeZoneNode: (z: { id: string; name: string; color: string; pos_x: number; pos_y: number; pos_w: number; pos_h: number }) => Node;
  /** Selection hooks so deletes/undos never leave a dangling selection. */
  onPropGone: (id: string) => void;
  onMachineGone: (id: string) => void;
}

/** Group move payload (2D zone/multi drag): every carried item with before/after. */
export interface GroupMove {
  machines: { id: string; before: MachineLayout; after: MachineLayout }[];
  zones: { dbId: string; before: XY; after: XY }[];
  sensors: { id: string; before: XY; after: XY }[];
  props: { id: string; before: XY; after: XY }[];
}

const ZONE_NODE = (dbId: string) => `zone-${dbId}`;
const ORBIT_NODE = (machineId: string) => `orbit-${machineId}`;

export function useMapEditor(io: EditorIO, plantId: string) {
  const runSave = useEditorStore((s) => s.runSave);
  const pushHistory = useEditorStore((s) => s.pushHistory);
  const addAlias = useEditorStore((s) => s.addAlias);
  const resolveId = useEditorStore((s) => s.resolveId);

  // ── local state appliers (no API, no history) ──
  const applyMachinePatch = useCallback((id: string, patch: MachineLayout) => {
    io.setNodes((nds) => nds.map((n) => {
      if (n.id === id && n.type === 'machine') {
        const m = (n.data as { machine: MapMachine }).machine;
        const next: Node = { ...n, data: { ...n.data, machine: { ...m, ...patch } } };
        if (patch.pos_x != null && patch.pos_y != null) next.position = { x: patch.pos_x, y: patch.pos_y };
        if (patch.pos_w != null) next.width = patch.pos_w;
        if (patch.pos_h != null) next.height = patch.pos_h;
        return next;
      }
      if (n.id === ORBIT_NODE(id) && ('orbit_x' in patch || 'orbit_y' in patch || 'orbit_w' in patch || 'orbit_h' in patch)) {
        // explicit orbit values move/resize the orbit node; nulls re-hug the machine
        const machineNode = io.getNodes().find((x) => x.id === id);
        const m = machineNode ? (machineNode.data as { machine: MapMachine }).machine : null;
        const px = (patch.pos_x ?? m?.pos_x ?? 0), py = (patch.pos_y ?? m?.pos_y ?? 0);
        const pw = (patch.pos_w ?? m?.pos_w ?? 152), ph = (patch.pos_h ?? m?.pos_h ?? 64);
        const MARGIN = 60; // ORBIT_MARGIN (kept in sync with Factory3D)
        return {
          ...n,
          position: { x: patch.orbit_x ?? (px - MARGIN), y: patch.orbit_y ?? (py - MARGIN) },
          width: patch.orbit_w ?? (pw + 2 * MARGIN),
          height: patch.orbit_h ?? (ph + 2 * MARGIN),
        };
      }
      return n;
    }));
  }, [io]);

  const applyPropPatch = useCallback((id: string, patch: PropPatch) => {
    io.setProps((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, [io]);

  const applyZonePatch = useCallback((dbId: string, patch: ZonePatch) => {
    io.setNodes((nds) => nds.map((n) => {
      if (n.id !== ZONE_NODE(dbId)) return n;
      const z = (n.data as { zone: { id: string; name: string; color: string } }).zone;
      const next: Node = { ...n, data: { ...n.data, zone: { ...z, ...(patch.name != null ? { name: patch.name } : {}), ...(patch.color != null ? { color: patch.color } : {}) } } };
      if (patch.pos_x != null && patch.pos_y != null) next.position = { x: patch.pos_x, y: patch.pos_y };
      if (patch.pos_w != null) next.width = patch.pos_w;
      if (patch.pos_h != null) next.height = patch.pos_h;
      return next;
    }));
  }, [io]);

  const applySensorPatch = useCallback((id: string, patch: { pos_x?: number; pos_y?: number; height_3d?: number }) => {
    io.setSensors((ss) => ss.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, [io]);

  // ── before-state readers (for undo) ──
  const machineBefore = useCallback((id: string, patch: MachineLayout): MachineLayout | null => {
    const n = io.getNodes().find((x) => x.id === id && x.type === 'machine');
    if (!n) return null;
    const m = (n.data as { machine: MapMachine }).machine;
    const before: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) before[k] = (m as unknown as Record<string, unknown>)[k] ?? null;
    return before as MachineLayout;
  }, [io]);

  const propBefore = useCallback((id: string, patch: PropPatch): PropPatch | null => {
    const p = io.getProps().find((x) => x.id === id);
    if (!p) return null;
    const before: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) before[k] = (p as unknown as Record<string, unknown>)[k] ?? null;
    return before as PropPatch;
  }, [io]);

  const zoneBefore = useCallback((dbId: string, patch: ZonePatch): ZonePatch | null => {
    const n = io.getNodes().find((x) => x.id === ZONE_NODE(dbId));
    if (!n) return null;
    const z = (n.data as { zone: { name: string; color: string } }).zone;
    const src: Record<string, unknown> = {
      name: z.name, color: z.color,
      pos_x: n.position.x, pos_y: n.position.y, pos_w: n.width ?? 0, pos_h: n.height ?? 0,
    };
    const before: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) before[k] = src[k];
    return before as ZonePatch;
  }, [io]);

  // ── public verbs (optimistic + tracked save + history) ──

  const patchMachine = useCallback((id: string, patch: MachineLayout, opts?: { label?: string; history?: boolean; before?: MachineLayout }) => {
    const before = opts?.before ?? machineBefore(id, patch);
    applyMachinePatch(id, patch);
    runSave(() => saveMachineLayout(id, patch));
    if (before && opts?.history !== false) {
      pushHistory({
        label: opts?.label ?? 'machine',
        undo: () => { applyMachinePatch(id, before); runSave(() => saveMachineLayout(id, before)); },
        redo: () => { applyMachinePatch(id, patch); runSave(() => saveMachineLayout(id, patch)); },
      });
    }
  }, [machineBefore, applyMachinePatch, runSave, pushHistory]);

  const patchProp = useCallback((id0: string, patch: PropPatch, opts?: { label?: string; history?: boolean; before?: PropPatch }) => {
    const id = resolveId(id0);
    const before = opts?.before ?? propBefore(id, patch);
    applyPropPatch(id, patch);
    runSave(() => saveProp(id, patch));
    if (before && opts?.history !== false) {
      pushHistory({
        label: opts?.label ?? 'block',
        undo: () => { const rid = resolveId(id); applyPropPatch(rid, before); runSave(() => saveProp(rid, before)); },
        redo: () => { const rid = resolveId(id); applyPropPatch(rid, patch); runSave(() => saveProp(rid, patch)); },
      });
    }
  }, [resolveId, propBefore, applyPropPatch, runSave, pushHistory]);

  const patchZone = useCallback((dbId: string, patch: ZonePatch, opts?: { label?: string; history?: boolean; before?: ZonePatch }) => {
    const before = opts?.before ?? zoneBefore(dbId, patch);
    applyZonePatch(dbId, patch);
    runSave(() => saveZone(dbId, patch));
    if (before && opts?.history !== false) {
      pushHistory({
        label: opts?.label ?? 'zone',
        undo: () => { applyZonePatch(dbId, before); runSave(() => saveZone(dbId, before)); },
        redo: () => { applyZonePatch(dbId, patch); runSave(() => saveZone(dbId, patch)); },
      });
    }
  }, [zoneBefore, applyZonePatch, runSave, pushHistory]);

  const patchSensor = useCallback((id: string, patch: { pos_x?: number; pos_y?: number; height_3d?: number }, opts?: { label?: string; history?: boolean; before?: { pos_x?: number; pos_y?: number; height_3d?: number } }) => {
    const s = io.getSensors().find((x) => x.id === id);
    let before: typeof patch = {};
    if (opts?.before) before = opts.before;
    else if (s) for (const k of Object.keys(patch) as (keyof typeof patch)[]) before[k] = (s[k] ?? undefined) as number | undefined;
    applySensorPatch(id, patch);
    runSave(() => saveSensorLayout(id, patch));
    if (s && opts?.history !== false) {
      pushHistory({
        label: opts?.label ?? 'sensor',
        undo: () => { applySensorPatch(id, before); runSave(() => saveSensorLayout(id, before)); },
        redo: () => { applySensorPatch(id, patch); runSave(() => saveSensorLayout(id, patch)); },
      });
    }
  }, [io, applySensorPatch, runSave, pushHistory]);

  // Place an unplaced machine at a map-pixel position (from the 2D list or the 3D ghost).
  const placeMachine = useCallback((m: MapMachine, x: number, y: number) => {
    const placed: MapMachine = { ...m, pos_x: x, pos_y: y, pos_w: m.pos_w ?? 152, pos_h: m.pos_h ?? 64, placed: true };
    const doPlace = () => {
      io.setUnplaced((u) => u.filter((v) => v.id !== m.id));
      io.setNodes((nds) => {
        if (nds.some((n) => n.id === m.id)) return nds;
        const orbit = io.makeOrbitNode(placed);
        return [...nds, ...(orbit ? [orbit] : []), io.makeMachineNode(placed)];
      });
      runSave(() => saveMachineLayout(m.id, { pos_x: x, pos_y: y }));
    };
    const doUnplace = () => {
      io.setNodes((nds) => nds.filter((n) => n.id !== m.id && n.id !== ORBIT_NODE(m.id)));
      io.setUnplaced((u) => (u.some((v) => v.id === m.id) ? u : [...u, { ...m, pos_x: null, pos_y: null, placed: false }]));
      io.onMachineGone(m.id);
      runSave(() => saveMachineLayout(m.id, { pos_x: null, pos_y: null }));
    };
    doPlace();
    pushHistory({ label: 'place', undo: doUnplace, redo: doPlace });
  }, [io, runSave, pushHistory]);

  // Take a placed machine OFF the map (kept in the catalog; undo restores it).
  const unplaceMachine = useCallback((id: string) => {
    const n = io.getNodes().find((x) => x.id === id && x.type === 'machine');
    if (!n) return;
    const m = (n.data as { machine: MapMachine }).machine;
    const snapshot: MapMachine = { ...m, pos_x: n.position.x, pos_y: n.position.y, pos_w: n.width ?? m.pos_w ?? 152, pos_h: n.height ?? m.pos_h ?? 64 };
    const doUnplace = () => {
      io.setNodes((nds) => nds.filter((x) => x.id !== id && x.id !== ORBIT_NODE(id)));
      io.setUnplaced((u) => (u.some((v) => v.id === id) ? u : [...u, { ...snapshot, pos_x: null, pos_y: null, placed: false }]));
      io.onMachineGone(id);
      runSave(() => saveMachineLayout(id, { pos_x: null, pos_y: null }));
    };
    const doPlace = () => {
      io.setUnplaced((u) => u.filter((v) => v.id !== id));
      io.setNodes((nds) => {
        if (nds.some((x) => x.id === id)) return nds;
        const orbit = io.makeOrbitNode(snapshot);
        return [...nds, ...(orbit ? [orbit] : []), io.makeMachineNode(snapshot)];
      });
      runSave(() => saveMachineLayout(id, { pos_x: snapshot.pos_x, pos_y: snapshot.pos_y }));
    };
    doUnplace();
    pushHistory({ label: 'unplace', undo: doPlace, redo: doUnplace });
  }, [io, runSave, pushHistory]);

  // Create a prop; `spec` carries everything (kind + position + size). Returns the created id via callback.
  const createPropTracked = useCallback((plantId: string, spec: PropCreate, extraScale?: Pick<PropPatch, 'model_scale' | 'scale_y' | 'scale_z'>, onCreated?: (p: MapProp) => void) => {
    let currentId: string | null = null;
    const doCreate = () => runSave(async () => {
      const created = await createProp(plantId, spec);
      let full = created;
      if (extraScale && Object.keys(extraScale).length) {
        await saveProp(created.id, extraScale);
        full = { ...created, ...extraScale };
      }
      if (currentId) addAlias(currentId, created.id);
      currentId = created.id;
      io.setProps((ps) => [...ps.filter((p) => p.id !== created.id), full]);
      onCreated?.(full);
    });
    const doDelete = () => {
      if (!currentId) return;
      const id = currentId;
      io.setProps((ps) => ps.filter((p) => p.id !== id));
      io.onPropGone(id);
      runSave(() => deleteProp(id));
    };
    doCreate();
    pushHistory({ label: 'add block', undo: doDelete, redo: doCreate });
  }, [io, runSave, pushHistory, addAlias]);

  const deletePropTracked = useCallback((id0: string) => {
    const id = resolveId(id0);
    const src = io.getProps().find((p) => p.id === id);
    if (!src) return;
    const snapshot: MapProp = { ...src };
    let currentId = id;
    const doDelete = () => {
      io.setProps((ps) => ps.filter((p) => p.id !== currentId));
      io.onPropGone(currentId);
      const target = currentId;
      runSave(() => deleteProp(target));
    };
    const doRecreate = () => runSave(async () => {
      const created = await createProp(plantId, {
        kind: snapshot.kind, label: snapshot.label, model_url: snapshot.model_url,
        equipment_id: snapshot.equipment_id, machine_id: snapshot.machine_id, role: snapshot.role,
        pos_x: snapshot.pos_x, pos_y: snapshot.pos_y, pos_w: snapshot.pos_w, pos_h: snapshot.pos_h,
        rotation_deg: snapshot.rotation_deg ?? 0, height_3d: snapshot.height_3d,
      });
      const scalePatch: PropPatch = {};
      if (snapshot.model_scale != null) scalePatch.model_scale = snapshot.model_scale;
      if (snapshot.scale_y != null) scalePatch.scale_y = snapshot.scale_y;
      if (snapshot.scale_z != null) scalePatch.scale_z = snapshot.scale_z;
      let full = created;
      if (Object.keys(scalePatch).length) { await saveProp(created.id, scalePatch); full = { ...created, ...scalePatch }; }
      addAlias(currentId, created.id);
      currentId = created.id;
      io.setProps((ps) => [...ps, full]);
    });
    doDelete();
    pushHistory({ label: 'delete block', undo: doRecreate, redo: doDelete });
  }, [io, resolveId, runSave, pushHistory, addAlias, plantId]);

  const createZoneTracked = useCallback((plantId: string, zone: ZonePatch, onCreated: (z: { id: string } & ZonePatch) => void) => {
    let currentId: string | null = null;
    const doCreate = () => runSave(async () => {
      const created = await createZone(plantId, zone);
      currentId = created.id;
      onCreated(created);
    });
    const doDelete = () => {
      if (!currentId) return;
      const id = currentId;
      io.setNodes((nds) => nds.filter((n) => n.id !== ZONE_NODE(id)));
      runSave(() => deleteZone(id));
    };
    doCreate();
    pushHistory({ label: 'add zone', undo: doDelete, redo: doCreate });
  }, [io, runSave, pushHistory]);

  const deleteZoneTracked = useCallback((dbId: string) => {
    const n = io.getNodes().find((x) => x.id === ZONE_NODE(dbId));
    if (!n) return;
    const z = (n.data as { zone: { name: string; color: string } }).zone;
    const snapshot = { name: z.name, color: z.color, pos_x: Math.round(n.position.x), pos_y: Math.round(n.position.y), pos_w: Math.round(n.width ?? 320), pos_h: Math.round(n.height ?? 220) };
    let currentId = dbId;
    const doDelete = () => {
      io.setNodes((nds) => nds.filter((x) => x.id !== ZONE_NODE(currentId)));
      const target = currentId;
      runSave(() => deleteZone(target));
    };
    const doRecreate = () => runSave(async () => {
      const created = await createZone(plantId, snapshot);
      currentId = created.id;
      // fresh node via the factory so its handlers close over the NEW id
      io.setNodes((nds) => [...nds, io.makeZoneNode({ id: created.id, ...snapshot })]);
    });
    doDelete();
    pushHistory({ label: 'delete zone', undo: doRecreate, redo: doDelete });
  }, [io, runSave, pushHistory, plantId]);

  // 2D group drag (zone container / shift multi-select): one history entry for the whole ride.
  const commitGroupMove = useCallback((mv: GroupMove) => {
    const apply = (dir: 'before' | 'after') => {
      for (const m of mv.machines) { applyMachinePatch(m.id, m[dir]); runSave(() => saveMachineLayout(m.id, m[dir])); }
      for (const z of mv.zones) { const p = { pos_x: z[dir].x, pos_y: z[dir].y }; applyZonePatch(z.dbId, p); runSave(() => saveZone(z.dbId, p)); }
      for (const s of mv.sensors) { const p = { pos_x: s[dir].x, pos_y: s[dir].y }; applySensorPatch(s.id, p); runSave(() => saveSensorLayout(s.id, p)); }
      for (const pr of mv.props) { const rid = resolveId(pr.id); const p = { pos_x: pr[dir].x, pos_y: pr[dir].y }; applyPropPatch(rid, p); runSave(() => saveProp(rid, p)); }
    };
    // the drag already moved nodes visually; persist "after" without re-applying node positions twice is
    // harmless (idempotent), and it keeps one code path for undo/redo.
    apply('after');
    if (mv.machines.length + mv.zones.length + mv.sensors.length + mv.props.length > 0) {
      pushHistory({ label: 'move', undo: () => apply('before'), redo: () => apply('after') });
    }
  }, [applyMachinePatch, applyZonePatch, applySensorPatch, applyPropPatch, runSave, resolveId, pushHistory]);

  return useMemo(() => ({
    patchMachine, patchProp, patchZone, patchSensor,
    placeMachine, unplaceMachine,
    createPropTracked, deletePropTracked,
    createZoneTracked, deleteZoneTracked,
    commitGroupMove,
    // raw optimistic appliers (no API, no history) — arrow-key nudge previews
    applyMachinePatch, applyPropPatch, applyZonePatch, applySensorPatch,
  }), [patchMachine, patchProp, patchZone, patchSensor, placeMachine, unplaceMachine,
      createPropTracked, deletePropTracked, createZoneTracked, deleteZoneTracked, commitGroupMove,
      applyMachinePatch, applyPropPatch, applyZonePatch, applySensorPatch]);
}

export type MapEditorApi = ReturnType<typeof useMapEditor>;
