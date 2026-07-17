import { useMemo, useRef, useEffect, useLayoutEffect, useState, forwardRef, memo, Suspense, createContext, useContext } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Grid, Html, Edges, Line, Detailed, useTexture, useGLTF, useAnimations, TransformControls, Billboard } from '@react-three/drei';
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { useTranslation } from 'react-i18next';
import { STATUS_HEX as STATUS_COLORS, STATUS_LABEL as STATUS_LABELS } from '../../utils/statusColors';
import { initials } from '../../utils/initials';
import { formatTemp, tempColor, type TempUnit } from '../../utils/temperature';
import type { LineStats, MapTechnician, PipelineOf, QueuedOf } from '../../api/factoryMap';
import type { PitStopOf, PitStopState } from '../../api/pitStop';
import { OF_CATEGORY_FALLBACK, isDueToday, ofPlateColor } from '../../utils/pitStopColors';
export const SCALE = 0.05;
const FLOOR_W = 1600;

// A temperature probe placed on the map (point geometry — no width/height).
export interface S3D {
  id: string;
  name: string;
  department?: string | null;    // binds the sensor to a department (badge scoping)
  pos_x: number;
  pos_y: number;
  height_3d?: number | null;
  last_value_c: number | null;   // canonical Celsius; converted to the viewer's unit
}
export type SensorCommit = (id: string, patch: { pos_x: number; pos_y: number }) => void;

// A placed machine's centre (map-pixel space) + its department — used to resolve
// which department a point belongs to (nearest machine), keeping a sensor's badge
// scoped to its own department so it never leaks into a neighbour.
export type MachinePoint = { x: number; y: number; dept: string };

export interface M3D {
  id: string;
  name: string;
  status: string;
  technicians?: MapTechnician[] | null;   // techs on the clock when status === 'intervention'
  stop_reason?: string | null;            // open stop's justification — assembly-line balloon
  line_stats?: LineStats | null;          // end-of-line TV stats — assembly lines only
  pipeline_ofs?: PipelineOf[] | null;     // planned pending OFs behind the machine (cutting pipeline)
  pipeline_total?: number;
  open_ticket_number?: string | null;
  pos_x: number;
  pos_y: number;
  pos_w: number;
  pos_h: number;
  icon_url?: string | null;
  model_url?: string | null;
  height_3d?: number | null;
  model_scale?: number | null;
  scale_y?: number | null;
  scale_z?: number | null;
  rotation_deg?: number | null;
  family?: string | null;
  subtype?: string | null;
  function_label?: string | null;
  block_kind?: string | null;
  asset_type?: string | null;
  orbit_x?: number | null;
  orbit_y?: number | null;
  orbit_w?: number | null;
  orbit_h?: number | null;
}

// px margin used for a machine's default "orbit" (overridden per machine by orbit_*).
export const ORBIT_MARGIN = 60;

export type TMode = 'translate' | 'rotate' | 'scale';
export type Commit = (id: string, patch: { pos_x: number; pos_y: number; model_scale: number; scale_y: number; scale_z: number; rotation_deg: number }) => void;

// Grid/angle snapping for the edit gizmo: 10 map-px translation steps, 15° rotation.
const SNAP_PX = 10;
const SNAP_TRANSLATE = SNAP_PX * SCALE;
const SNAP_ROTATE = Math.PI / 12;

// A zone rendered on the 3D floor (edit mode) so departments can be organized
// without switching back to 2D.
export interface Z3D {
  id: string;
  name: string;
  color: string;
  pos_x: number;
  pos_y: number;
  pos_w: number;
  pos_h: number;
}
export type ZoneCommit3D = (id: string, patch: { pos_x: number; pos_y: number; pos_w: number; pos_h: number }) => void;

// Click-to-place ghost: footprint (map px) + world height of the item being placed.
export interface PlacementSpec {
  w: number;
  h: number;
  height: number;
  label: string;
}

// Ctrl-click multi-selection: ids by kind. The page owns the state; Factory3D
// draws footprints on every member and one shared translate gizmo at the centroid.
export interface MultiSelection {
  machines: string[];
  props: string[];
}

function heightFor(m: M3D): number {
  const s = `${m.family ?? ''} ${m.subtype ?? ''} ${m.function_label ?? ''} ${m.name}`.toLowerCase();
  if (/convoyeur|conveyor|tapis|table|roulett/.test(s)) return 1.2;
  if (/presse|press|italpresse|chaudiere|boiler|four/.test(s)) return 6;
  if (/couture|sewing|pfaff|singer|juki/.test(s)) return 1.8;
  if (/sableuse|sand|pon[çc]/.test(s)) return 2.6;
  if (/scie|saw|panneau|panel/.test(s)) return 3.5;
  if (/plaqueuse|edgeband|edge|encolleu|colle/.test(s)) return 3;
  if (/perceuse|drill|cnc|fraiseuse|grooving|mill|rover|morbidelli|usinage/.test(s)) return 4.5;
  return 3;
}

function SunLight() {
  // Shadows disabled for performance — keep two directional lights for shaping.
  return (
    <>
      <directionalLight position={[60, 80, 30]} intensity={1.15} />
      <directionalLight position={[-40, 50, -30]} intensity={0.45} />
    </>
  );
}

// `additive` = Ctrl/Cmd-click — the page grows a multi-selection instead of replacing it.
export type SelectFn = (id: string, additive?: boolean) => void;

interface BoxProps { w: number; d: number; h: number; color: string; id: string; name: string; onSelect: SelectFn }

const boxHandlers = (id: string, onSelect: SelectFn) => ({
  onClick: (e: { stopPropagation: () => void; ctrlKey?: boolean; metaKey?: boolean; nativeEvent?: MouseEvent }) => {
    e.stopPropagation();
    // modifier lives on the DOM event (prototype getters don't survive r3f's spread)
    const ne = e.nativeEvent;
    onSelect(id, !!(ne?.ctrlKey || ne?.metaKey || e.ctrlKey || e.metaKey));
  },
  onPointerOver: (e: { stopPropagation: () => void }) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; },
  onPointerOut: () => { document.body.style.cursor = 'default'; },
});

// Name tag — small, floats clearly above the rendered content (never over it).
function Label({ y, text }: { y: number; text: string }) {
  return (
    <Html position={[0, y, 0]} center distanceFactor={16} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
      <div style={{ fontSize: 9, lineHeight: 1.1, color: '#cbd5e1', background: 'rgba(13,20,33,0.7)', padding: '1px 4px', borderRadius: 3, whiteSpace: 'nowrap', transform: 'translateY(-50%)' }}>{text}</div>
    </Html>
  );
}

function PlainMesh({ w, d, h, color, id, name, onSelect }: BoxProps) {
  return (
    <>
      <mesh position={[0, h / 2, 0]} castShadow receiveShadow {...boxHandlers(id, onSelect)}>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={color} />
        <Edges color={color} />
      </mesh>
      <Label y={h + 0.6} text={name} />
    </>
  );
}

function PhotoMesh({ url, w, d, h, color, id, name, onSelect }: BoxProps & { url: string }) {
  const tex = useTexture(url);
  return (
    <>
      <mesh position={[0, h / 2, 0]} castShadow receiveShadow {...boxHandlers(id, onSelect)}>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial map={tex} />
        <Edges color={color} />
      </mesh>
      <Label y={h + 0.6} text={name} />
    </>
  );
}

// ── Static-GLB draw-call collapse ─────────────────────────────────────────────
// Uploaded machine models arrive with hundreds of sub-meshes (one per CAD part)
// and dominate the scene's draw calls (~5.5k of ~7k measured). For models with
// NO animations and NO skinning we bake every eligible mesh's world transform
// into its geometry and merge them per material — visually identical, but one
// draw call per material instead of one per part. Ineligible meshes (multi-
// material groups, morph targets, mirrored transforms) are kept as-is.
// Cached per URL so multiple instances share the merged geometries.
const mergedGltfCache = new Map<string, THREE.Object3D>();

function buildMergedGltf(scene: THREE.Object3D): THREE.Object3D {
  scene.updateWorldMatrix(true, true);
  const buckets = new Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[] }>();
  const out = new THREE.Group();
  const keepAsIs: THREE.Mesh[] = [];
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const geo = m.geometry as THREE.BufferGeometry;
    const eligible = !Array.isArray(m.material)
      && !(geo.morphAttributes && Object.keys(geo.morphAttributes).length)
      && m.matrixWorld.determinant() > 0;   // mirrored transforms would flip winding
    if (!eligible) { keepAsIs.push(m); return; }
    const mat = m.material as THREE.Material;
    // merge only geometries with the same attribute layout (mergeGeometries requirement)
    const sig = `${mat.uuid}|${Object.keys(geo.attributes).sort().join(',')}|${geo.index ? 1 : 0}`;
    let b = buckets.get(sig);
    if (!b) { b = { material: mat, geos: [] }; buckets.set(sig, b); }
    const g = geo.clone();
    g.applyMatrix4(m.matrixWorld);
    b.geos.push(g);
  });
  for (const { material, geos } of buckets.values()) {
    try {
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (!merged) throw new Error('merge failed');
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      out.add(mesh);
      if (geos.length > 1) geos.forEach((g) => { if (g !== merged) g.dispose(); });
    } catch {
      // incompatible attribute data — fall back to individual baked meshes
      for (const g of geos) {
        const mesh = new THREE.Mesh(g, material);
        mesh.castShadow = true;
        out.add(mesh);
      }
    }
  }
  for (const m of keepAsIs) {
    const c = m.clone();
    c.geometry = m.geometry;
    m.matrixWorld.decompose(c.position, c.quaternion, c.scale);
    c.castShadow = true;
    out.add(c);
  }
  return out;
}

function GltfModel({ url, w, d, color, id, name, onSelect, animate }: BoxProps & { url: string; animate?: boolean }) {
  const { scene, animations } = useGLTF(url);
  // SkeletonUtils.clone keeps skinned-mesh bindings intact so multiple instances
  // (and glTF animation clips) work — plain scene.clone(true) breaks rigged models.
  // Static models (no clips, no skinning) instead go through the per-material
  // merge above, collapsing hundreds of part-meshes into a handful of draw calls.
  const cloned = useMemo(() => {
    let hasSkin = false;
    scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) hasSkin = true; });
    if (animations.length || hasSkin) {
      const c = skeletonClone(scene);
      c.traverse((o) => { (o as THREE.Mesh).castShadow = true; });
      return c;
    }
    let tpl = mergedGltfCache.get(url);
    if (!tpl) { tpl = buildMergedGltf(scene); mergedGltfCache.set(url, tpl); }
    return tpl.clone(true);   // meshes are cloned, merged geometries/materials shared
  }, [scene, animations, url]);
  const groupRef = useRef<THREE.Group>(null);
  const { actions } = useAnimations(animations, groupRef);

  // Play the model's animation clips while `animate` (e.g. status === running); idle otherwise.
  useEffect(() => {
    const list = Object.values(actions).filter(Boolean) as THREE.AnimationAction[];
    if (animate) list.forEach((a) => a.reset().fadeIn(0.25).play());
    else list.forEach((a) => a.fadeOut(0.25));
    return () => list.forEach((a) => a.stop());
  }, [actions, animate]);

  const { scale, offset, foot, top } = useMemo(() => {
    const box = new THREE.Box3().setFromObject(cloned);
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    const s = Math.min(w / (size.x || 1), d / (size.z || 1));   // uniform → preserve proportions
    return {
      scale: s,
      // centre the model on the group origin (X/Z) and rest it on the floor (Y)
      offset: [-center.x * s, -box.min.y * s, -center.z * s] as [number, number, number],
      // status "carpet" hugs the model's real footprint (so it shares its orientation/size)
      foot: [Math.max(size.x * s, 0.4) * 1.08, Math.max(size.z * s, 0.4) * 1.08] as [number, number],
      top: size.y * s,   // real model height → where the name tag sits
    };
  }, [cloned, w, d]);
  return (
    <group ref={groupRef} {...boxHandlers(id, onSelect)}>
      <mesh position={[0, 0.06, 0]} receiveShadow>
        <boxGeometry args={[foot[0], 0.12, foot[1]]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <primitive object={cloned} scale={scale} position={offset} />
      <Label y={top + 0.6} text={name} />
    </group>
  );
}

// A rounded white arm segment (capsule), pivoting from its base (local +Y),
// with the signature FANUC-green accent ring near the joint.
function ArmLink({ len, r, color, accent }: { len: number; r: number; color: string; accent?: string }) {
  const cyl = Math.max(len - 2 * r, 0.01);
  return (
    <group>
      <mesh position={[0, len / 2, 0]} castShadow>
        <capsuleGeometry args={[r, cyl, 6, 16]} />
        <meshStandardMaterial color={color} roughness={0.4} metalness={0.12} />
      </mesh>
      {accent && (
        <mesh position={[0, r * 1.7, 0]} castShadow>
          <cylinderGeometry args={[r * 1.08, r * 1.08, r * 0.5, 18]} />
          <meshStandardMaterial color={accent} roughness={0.5} emissive={accent} emissiveIntensity={0.15} />
        </mesh>
      )}
    </group>
  );
}

// A dark joint "knuckle" (cylinder lying along the Z hinge axis).
function Joint({ r, color }: { r: number; color: string }) {
  return (
    <mesh rotation={[Math.PI / 2, 0, 0]} castShadow>
      <cylinderGeometry args={[r, r, r * 2.2, 18]} />
      <meshStandardMaterial color={color} roughness={0.5} metalness={0.25} />
    </mesh>
  );
}

/** Procedural white FANUC-style 6-axis cobot (green joint accents) — the
 * placeholder until a .glb is uploaded. While `animate` (status === running) it
 * runs a smooth pick-and-place cycle: the base swings 180° between the machine
 * and the conveyor, dipping to pick at the machine and place on the conveyor.
 * The wrist counter-rotates the shoulder+elbow dip so the gripper stays LEVEL and
 * the wood panel is always carried flat (horizontal). Stopped → eases to home. */
function CobotMesh({ h, color, id, name, onSelect, animate }: BoxProps & { animate?: boolean }) {
  const u = h / 3;                                   // scale unit (default height 3)
  const white = '#eef1f4', dark = '#2b2f36', green = '#8ec63f', wood = '#caa46a';
  const j1 = useRef<THREE.Group>(null);              // base yaw (Y)
  const j2 = useRef<THREE.Group>(null);              // shoulder pitch (Z)
  const j3 = useRef<THREE.Group>(null);              // elbow pitch (Z)
  const j4 = useRef<THREE.Group>(null);              // wrist pitch (Z)
  const gripPanel = useRef<THREE.Mesh>(null);        // the wood panel the gripper holds

  // Pick is at yaw 0 — aim the block at the machine — and the place is 180°
  // opposite (the conveyor). So the scene begins exactly where you aimed it.
  const MACHINE = 0, CONVEYOR = Math.PI;

  // Per-cobot phase + speed offset (stable, derived from the block id) so cells
  // don't move in lockstep — each starts at a different point in the cycle and
  // runs at a slightly different pace, drifting apart for a natural look.
  const { phaseFrac, periodScale } = useMemo(() => {
    let hsh = 0;
    for (let i = 0; i < id.length; i++) hsh = (hsh * 31 + id.charCodeAt(i)) >>> 0;
    return { phaseFrac: (hsh % 1000) / 1000, periodScale: 0.85 + ((hsh >> 10) % 100) / 100 * 0.3 };
  }, [id]);

  // Work cycle: dwell+pick at the machine → carry → dwell+place on the conveyor → return.
  useFrame((state) => {
    const a = animate ? 1 : 0;
    const T = 8 * periodScale;                       // per-cobot cycle length (≈7-9s)
    const p = ((state.clock.elapsedTime % T) / T + phaseFrac) % 1;   // 0..1 phase, offset per cobot
    const ss = (lo: number, hi: number, x: number) => {
      const k = THREE.MathUtils.clamp((x - lo) / (hi - lo), 0, 1);
      return k * k * (3 - 2 * k);
    };
    let yaw = MACHINE;                               // dwell+pick at machine → swing → dwell+place at conveyor → swing back
    if (p < 0.30) yaw = MACHINE;
    else if (p < 0.48) yaw = THREE.MathUtils.lerp(MACHINE, CONVEYOR, ss(0.30, 0.48, p));
    else if (p < 0.78) yaw = CONVEYOR;
    else yaw = THREE.MathUtils.lerp(CONVEYOR, MACHINE, ss(0.78, 1.0, p));
    const bump = (c: number, wd: number) => { const z = (p - c) / wd; return Math.max(0, 1 - z * z); };
    const dip = Math.min(1, bump(0.15, 0.12) + bump(0.63, 0.12));   // reach down to pick (~0.15) and place (~0.63)
    const yawT = a ? yaw : 0, dipT = a ? dip : 0;
    // Arm posture: the shoulder lifts the upper arm up-and-out, the elbow stays
    // OPEN (not folded) so the forearm reaches down-and-out to the side, and the
    // wrist keeps the tool pointing straight DOWN. The flat panel therefore hangs
    // low and well clear of the arm — picked off a table, carried flat, and set
    // down flat after the 180° swing. dipT lowers the whole reach at each end.
    const j2t = -0.70 - dipT * 0.18;     // shoulder (up & out)
    const j3t = -1.05 - dipT * 0.17;     // elbow (open bend → forearm reaches down & out)
    const j4t = Math.PI - (j2t + j3t);   // wrist → tool (and flat panel) always points straight DOWN
    if (j1.current) j1.current.rotation.y = THREE.MathUtils.lerp(j1.current.rotation.y, yawT, 0.12);
    if (j2.current) j2.current.rotation.z = THREE.MathUtils.lerp(j2.current.rotation.z, j2t, 0.12);
    if (j3.current) j3.current.rotation.z = THREE.MathUtils.lerp(j3.current.rotation.z, j3t, 0.12);
    if (j4.current) j4.current.rotation.z = THREE.MathUtils.lerp(j4.current.rotation.z, j4t, 0.12);
    // hold the panel from the grab (machine side) through the place (conveyor side); empty on the way back
    const grab = 0.17, rel = 0.66;
    if (gripPanel.current) gripPanel.current.visible = !a || (p >= grab && p < rel);
  });

  const baseH = 0.16 * u, housingH = 0.42 * u;
  const L2 = 1.05 * u, R2 = 0.16 * u, L3 = 0.88 * u, R3 = 0.13 * u, wL = 0.3 * u, wR = 0.12 * u;
  const pW = 0.8 * u, pT = 0.05 * u, pD = 0.6 * u;   // wood panel dims
  return (
    <group {...boxHandlers(id, onSelect)}>
      {/* base plate */}
      <mesh position={[0, baseH / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.34 * u, 0.4 * u, baseH, 24]} />
        <meshStandardMaterial color={dark} roughness={0.6} metalness={0.3} />
      </mesh>
      {/* status LED on the base */}
      <mesh position={[0.28 * u, baseH + 0.04 * u, 0]}>
        <sphereGeometry args={[0.05 * u, 12, 12]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={animate ? 1.3 : 0.25} />
      </mesh>
      {/* J1 — base yaw */}
      <group ref={j1} position={[0, baseH, 0]}>
        <mesh position={[0, housingH / 2, 0]} castShadow>
          <cylinderGeometry args={[0.26 * u, 0.3 * u, housingH, 24]} />
          <meshStandardMaterial color={white} roughness={0.4} metalness={0.12} />
        </mesh>
        {/* J2 — shoulder */}
        <group ref={j2} position={[0, housingH, 0]}>
          <Joint r={R2 * 1.1} color={white} />
          <ArmLink len={L2} r={R2} color={white} accent={green} />
          {/* J3 — elbow */}
          <group ref={j3} position={[0, L2, 0]}>
            <Joint r={R3 * 1.15} color={white} />
            <ArmLink len={L3} r={R3} color={white} accent={green} />
            {/* J4 — wrist + flange + gripper + held wood panel */}
            <group ref={j4} position={[0, L3, 0]}>
              <Joint r={wR * 1.1} color={white} />
              <mesh position={[0, wL / 2, 0]} castShadow>
                <cylinderGeometry args={[wR, wR, wL, 16]} />
                <meshStandardMaterial color={white} roughness={0.4} metalness={0.12} />
              </mesh>
              <mesh position={[0, wL + 0.04 * u, 0]} castShadow>
                <cylinderGeometry args={[wR * 1.25, wR * 1.25, 0.08 * u, 16]} />
                <meshStandardMaterial color={dark} metalness={0.4} roughness={0.4} />
              </mesh>
              {/* gripper head + the wood panel it carries (shown only while carrying) */}
              <mesh position={[0, wL + 0.14 * u, 0]}>
                <boxGeometry args={[pW * 0.5, 0.1 * u, pD * 0.5]} />
                <meshStandardMaterial color={dark} />
              </mesh>
              <mesh ref={gripPanel} position={[0, wL + 0.22 * u, 0]}>
                <boxGeometry args={[pW, pT, pD]} />
                <meshStandardMaterial color={wood} roughness={0.85} />
              </mesh>
            </group>
          </group>
        </group>
      </group>
      <Label y={2.7 * u + 0.4} text={name} />
    </group>
  );
}

/** True when an item reads like a collaborative robot (so it renders as an arm). */
function isCobot(m: M3D): boolean {
  const s = `${m.family ?? ''} ${m.subtype ?? ''} ${m.function_label ?? ''} ${m.name}`.toLowerCase();
  return /cobot|robot/.test(s);
}

// ── Decorative prop blocks ────────────────────────────────────────────────────
// Catalog of placeholder block types. `w`/`h` are 2D footprint (pixel space, like
// equipment pos_w/pos_h); `height` is world height. Replace any with an uploaded .glb.
export const PROP_CATALOG: { kind: string; label: string; w: number; h: number; height: number }[] = [
  { kind: 'conveyor',       label: 'Conveyor',         w: 360, h: 90,  height: 1.2 },
  { kind: 'lift_table',     label: 'Lift table',       w: 140, h: 120, height: 1.2 },
  { kind: 'work_table',     label: 'Work table',       w: 160, h: 100, height: 1.0 },
  { kind: 'rack',           label: 'Rack / shelving',  w: 160, h: 80,  height: 3.5 },
  { kind: 'dust_collector', label: 'Dust collector',   w: 90,  h: 90,  height: 4.5 },
  { kind: 'cobot',          label: 'Cobot (animated)', w: 90,  h: 90,  height: 3.0 },
  { kind: 'box',            label: 'Block',            w: 120, h: 120, height: 2.0 },
];
// Note: 'beam_saw' is NOT in the prop catalog on purpose — it is a 3D shape you
// assign to an existing production machine (via the per-machine shape selector),
// not a decorative block you drop on the map.
const propHeight = (kind: string): number => PROP_CATALOG.find((c) => c.kind === kind)?.height ?? 2;
// block_kinds that render as a procedural mesh (the rest fall back to box/photo)
const PROCEDURAL_KINDS = new Set(['cobot', 'conveyor', 'lift_table', 'work_table', 'rack', 'dust_collector', 'beam_saw', 'assembly_line', 'pit_stop']);

// Wood panels riding the belt — translate along +X and wrap, simulating flow.
function ConveyorFlow({ w, d, y, animate }: { w: number; d: number; y: number; animate: boolean }) {
  const count = Math.max(2, Math.min(5, Math.round(w / 1.3)));
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  const speed = 0.7;
  useFrame((state) => {
    const t = animate ? state.clock.elapsedTime : 0;
    for (let i = 0; i < count; i++) {
      const m = refs.current[i];
      if (!m) continue;
      m.position.x = -w / 2 + ((t * speed + (i / count) * w) % w);
    }
  });
  const pw = Math.min(w / (count + 1), d * 0.7);
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <mesh key={i} ref={(el) => { refs.current[i] = el; }} position={[0, y, 0]} castShadow>
          <boxGeometry args={[pw * 0.8, pw * 0.28, d * 0.7]} />
          <meshStandardMaterial color="#caa46a" roughness={0.8} />
        </mesh>
      ))}
    </>
  );
}

// Shared conveyor materials + unit geometries (instanced parts) — module level,
// one allocation for the whole app.
const conveyorRollerMat = new THREE.MeshStandardMaterial({ color: '#9ca3af', metalness: 0.6, roughness: 0.4 });
const conveyorLegMat = new THREE.MeshStandardMaterial({ color: '#1f2937' });
const unitCylinderGeo = new THREE.CylinderGeometry(1, 1, 1, 10);
const unitBoxGeo = new THREE.BoxGeometry(1, 1, 1);

function ConveyorMesh({ w, d, h, color, id, name, onSelect, animate }: BoxProps & { animate?: boolean }) {
  const legH = h * 0.7;
  const beltY = legH;
  const rollers = Math.min(14, Math.max(3, Math.round(w / 0.6)));
  const legW = Math.max(w * 0.03, 0.06), legD = Math.max(d * 0.06, 0.06);
  // Rollers and legs as ONE InstancedMesh each (2 draw calls instead of up to 18).
  const rollerRef = useRef<THREE.InstancedMesh>(null);
  const legRef = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const o = new THREE.Object3D();
    for (let i = 0; i < rollers; i++) {
      o.position.set(-w / 2 + (i + 0.5) * (w / rollers), beltY + h * 0.1, 0);
      o.rotation.set(Math.PI / 2, 0, 0);
      o.scale.set(d * 0.06, d * 0.9, d * 0.06);   // unit cylinder: r=1, h=1
      o.updateMatrix();
      rollerRef.current?.setMatrixAt(i, o.matrix);
    }
    ([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).forEach(([sx, sz], i) => {
      o.position.set((sx * w) / 2 * 0.9, legH / 2, (sz * d) / 2 * 0.8);
      o.rotation.set(0, 0, 0);
      o.scale.set(legW, legH, legD);
      o.updateMatrix();
      legRef.current?.setMatrixAt(i, o.matrix);
    });
    if (rollerRef.current) rollerRef.current.instanceMatrix.needsUpdate = true;
    if (legRef.current) legRef.current.instanceMatrix.needsUpdate = true;
  }, [w, d, h, rollers, beltY, legH, legW, legD]);
  return (
    <group {...boxHandlers(id, onSelect)}>
      <mesh position={[0, beltY, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, h * 0.12, d]} />
        <meshStandardMaterial color="#374151" metalness={0.2} roughness={0.85} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[0, beltY + h * 0.12, (s * d) / 2 * 0.92]} castShadow>
          <boxGeometry args={[w, h * 0.14, d * 0.06]} />
          <meshStandardMaterial color={color} />
        </mesh>
      ))}
      <instancedMesh ref={rollerRef} args={[unitCylinderGeo, conveyorRollerMat, rollers]} castShadow />
      <instancedMesh ref={legRef} args={[unitBoxGeo, conveyorLegMat, 4]} castShadow />
      <ConveyorFlow w={w} d={d} y={beltY + h * 0.18} animate={animate ?? true} />
      <Label y={h + 0.6} text={name} />
    </group>
  );
}

// ── Assembly line (block_kind='assembly_line') — the assemblage-lines scene ──
// A long industrial belt built from LEVEL modules on metal scissor lifts
// (the height-adjust mechanism shows, but every module sits at the same
// ergonomic height). Furniture in progressive stages of assembly (panel stack
// → carcass → cubby → 3-drawer units) rides the belt and FREEZES when the
// line stops. Five ninja-style line workers (blue suits, one ponytail, one
// with glasses) visibly drive screws into the pieces while the line runs;
// their hard hats AND the belt's whole frame take the line's live status
// colour — a GREEN belt while the ADAM says it turns, RED on a stop. When the
// line is stopped, a glossy speech balloon — same 3D-icon style as the
// mechanics' initials bubble — floats over it with the stop's justification
// from the kiosk timeline.

// Plant-wide efficiency-colour thresholds for the line TVs (configured on
// /settings/line-objectives, delivered with the map payload). Provided INSIDE
// the <Canvas> (React context does not cross the R3F reconciler boundary).
export type TvThresholds = { green_from: number; amber_from: number };
const TV_THRESHOLDS_DEFAULT: TvThresholds = { green_from: 95, amber_from: 80 };
const TvThresholdsCtx = createContext<TvThresholds>(TV_THRESHOLDS_DEFAULT);

/** Efficiency → colour per the configured thresholds (null eff → null = grey). */
const effColor = (eff: number | null | undefined, th: TvThresholds): string | null =>
  eff == null ? null : eff >= th.green_from ? '#16a34a' : eff >= th.amber_from ? '#d97706' : '#dc2626';

const LINE_MODULES = 5;            // one work station per module
// Deck height in WORLD units, not tied to the block's h: the workers are fixed
// human size (~1.9 tall), so the belt sits waist-high on them — the pieces land
// right under their hands and the crew reads as one integrated scene.
const LINE_DECK_H = 0.8;
const LINE_STOPPED = new Set(['stopped', 'unjustified', 'maintenance', 'planned_stop']);

/** Materials shared by everything in ONE line (structure, furniture, the five
 * workers, the balloon) — a handful of instances instead of one per mesh.
 * `status` carries the LIVE status colour (helmet domes); its colour is
 * mutated in place on status change so nothing re-mounts. */
function useLineMats(statusColor: string) {
  const mats = useMemo(() => ({
    belt:       new THREE.MeshStandardMaterial({ color: '#242c38', roughness: 0.9 }),
    metal:      new THREE.MeshStandardMaterial({ color: '#9aa3ad', metalness: 0.75, roughness: 0.3 }),
    base:       new THREE.MeshStandardMaterial({ color: '#1f2937', roughness: 0.7 }),
    wood:       new THREE.MeshStandardMaterial({ color: '#b98a4e', roughness: 0.75 }),
    woodLight:  new THREE.MeshStandardMaterial({ color: '#ead9b8', roughness: 0.7 }),
    woodDark:   new THREE.MeshStandardMaterial({ color: '#8a5f33', roughness: 0.8 }),
    suit:       new THREE.MeshStandardMaterial({ color: '#2456b8', roughness: 0.65 }),
    suitShadow: new THREE.MeshStandardMaterial({ color: '#152647', roughness: 0.7 }),
    accent:     new THREE.MeshStandardMaterial({ color: '#f97316', roughness: 0.5 }),
    trim:       new THREE.MeshStandardMaterial({ color: '#1e2740', roughness: 0.5 }),
    skin:       new THREE.MeshStandardMaterial({ color: '#f2c197', roughness: 0.55 }),
    glove:      new THREE.MeshStandardMaterial({ color: '#10151f', roughness: 0.6 }),
    eyeWhite:   new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.3 }),
    status:     new THREE.MeshStandardMaterial({ color: statusColor, roughness: 0.35 }),
    bubble:     new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.25, emissive: '#ffffff', emissiveIntensity: 0.12 }),
  }), []);  // eslint-disable-line react-hooks/exhaustive-deps -- statusColor updates below without re-creating
  useEffect(() => { mats.status.color.set(statusColor); }, [mats, statusColor]);
  useEffect(() => () => { Object.values(mats).forEach((m) => m.dispose()); }, [mats]);
  return mats;
}
type LineMats = ReturnType<typeof useLineMats>;

/** One height-adjustable belt module: base skid, metal scissor-cross pair with
 * a centre pin, blue deck frame with a dark belt surface and blue side skirts. */
function ScissorModule({ x, mw, db, deckH, mats }: { x: number; mw: number; db: number; deckH: number; mats: LineMats }) {
  const beltT = 0.14;
  const rise = Math.max(0.25, deckH - beltT);
  const span = mw * 0.42;
  const len = Math.hypot(rise, span * 2) * 0.98;
  const ang = Math.atan2(rise, span * 2);
  return (
    <group position={[x, 0, 0]}>
      <mesh material={mats.base} position={[0, 0.05, 0]} castShadow>
        <boxGeometry args={[mw * 0.72, 0.1, db * 0.8]} />
      </mesh>
      {/* scissor mechanism, front + back */}
      {[-1, 1].map((s) => (
        <group key={s} position={[0, 0, s * db * 0.32]}>
          <mesh material={mats.metal} position={[0, 0.08 + rise / 2, 0]} rotation={[0, 0, ang]} castShadow>
            <boxGeometry args={[len, 0.06, 0.06]} />
          </mesh>
          <mesh material={mats.metal} position={[0, 0.08 + rise / 2, 0]} rotation={[0, 0, -ang]} castShadow>
            <boxGeometry args={[len, 0.06, 0.06]} />
          </mesh>
          <mesh material={mats.trim} position={[0, 0.08 + rise / 2, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.05, 0.05, 0.09, 8]} />
          </mesh>
        </group>
      ))}
      {/* deck: the WHOLE frame (not just the skirts) takes the LIVE status
          colour — green belt while running, red on a stop, like the helmets.
          Only the belt surface, scissors and base stay neutral. */}
      <mesh material={mats.status} position={[0, deckH - beltT / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[mw * 1.001, beltT, db]} />
      </mesh>
      <mesh material={mats.belt} position={[0, deckH + 0.026, 0]}>
        <boxGeometry args={[mw * 1.001, 0.052, db * 0.76]} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={`sk${s}`} material={mats.status} position={[0, deckH - 0.02, s * (db / 2) * 0.94]}>
          <boxGeometry args={[mw * 1.001, 0.2, 0.06]} />
        </mesh>
      ))}
    </group>
  );
}

/** One furniture piece at assembly stage `stage` (0→5, progressively more
 * complete): panel stack → carcass → cubby/niche → drawer unit (light drawer
 * fronts) → small cabinet with a door → tall shelf with dividers. Sits on y=0. */
function FurniturePiece({ stage, mats }: { stage: number; mats: LineMats }) {
  switch (stage) {
    case 0: return (
      <group>
        {[0, 1, 2].map((i) => (
          <mesh key={i} material={mats.wood} position={[0, 0.04 + i * 0.06, 0]} rotation={[0, i * 0.08 - 0.08, 0]} castShadow>
            <boxGeometry args={[0.95, 0.05, 0.62]} />
          </mesh>
        ))}
      </group>
    );
    case 1: return (
      <group>
        <mesh material={mats.wood} position={[0, 0.035, 0]} castShadow><boxGeometry args={[0.85, 0.06, 0.6]} /></mesh>
        {[-1, 1].map((k) => (
          <mesh key={k} material={mats.wood} position={[0.4 * k, 0.38, 0]} castShadow><boxGeometry args={[0.05, 0.72, 0.6]} /></mesh>
        ))}
        <mesh material={mats.woodDark} position={[0, 0.38, -0.28]}><boxGeometry args={[0.85, 0.72, 0.04]} /></mesh>
      </group>
    );
    case 2: return (
      <group>
        {[0.035, 0.73].map((y, i) => (
          <mesh key={i} material={mats.wood} position={[0, y, 0]} castShadow><boxGeometry args={[0.85, 0.06, 0.6]} /></mesh>
        ))}
        {[-1, 1].map((k) => (
          <mesh key={`s${k}`} material={mats.wood} position={[0.4 * k, 0.38, 0]} castShadow><boxGeometry args={[0.05, 0.76, 0.6]} /></mesh>
        ))}
        <mesh material={mats.woodDark} position={[0, 0.38, -0.28]}><boxGeometry args={[0.85, 0.76, 0.04]} /></mesh>
        {[-1, 1].map((k) => (
          <mesh key={`d${k}`} material={mats.wood} position={[0.14 * k, 0.38, 0.02]}><boxGeometry args={[0.04, 0.66, 0.52]} /></mesh>
        ))}
      </group>
    );
    // stages 3+ — the finished product: the 3-drawer unit (light drawer fronts)
    default: return (
      <group>
        <mesh material={mats.wood} position={[0, 0.45, 0]} castShadow><boxGeometry args={[0.8, 0.9, 0.6]} /></mesh>
        {[0.18, 0.45, 0.72].map((y, i) => (
          <mesh key={i} material={mats.woodLight} position={[0, y, 0.31]}><boxGeometry args={[0.68, 0.2, 0.04]} /></mesh>
        ))}
        {[0.18, 0.45, 0.72].map((y, i) => (
          <mesh key={`k${i}`} material={mats.trim} position={[0, y, 0.34]}><boxGeometry args={[0.2, 0.03, 0.02]} /></mesh>
        ))}
      </group>
    );
  }
}

/** The furniture riding the belt: five pieces in progressive stages (the last
 * two are finished 3-drawer units), spread along the line at deck height.
 * Their progress accumulates only while the line runs — on a stop everything
 * freezes IN PLACE. */
function FurnitureFlow({ w, db, deckH, animate, mats }: { w: number; db: number; deckH: number; animate: boolean; mats: LineMats }) {
  const count = 5;
  const refs = useRef<(THREE.Group | null)[]>([]);
  const prog = useRef(0);
  useFrame((_, delta) => {
    if (animate) prog.current = (prog.current + delta * 0.03) % 1;
    for (let i = 0; i < count; i++) {
      const g = refs.current[i];
      if (!g) continue;
      const xf = (prog.current + i / count) % 1;
      g.position.set(-w / 2 + xf * w, deckH + 0.05, 0);
    }
  });
  const s = Math.min(1.15, db * 0.55);
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <group key={i} ref={(el) => { refs.current[i] = el; }} scale={s}>
          <FurniturePiece stage={i} mats={mats} />
        </group>
      ))}
    </>
  );
}

/** A line worker in the ninja-mechanic style: blue industrial suit with chest
 * straps and a tool belt, safety boots, balaclava + friendly eyes, an electric
 * screwdriver, and a hard hat in the LINE's live status colour (green while
 * the belt runs, red on a stop). `ponytail`/`glasses` differentiate the crew.
 * Leans over the belt driving screws while the line runs; goes still (but
 * keeps breathing) when it stops. Built at the origin facing +z. */
// Camera distance (world units) beyond which a line worker renders as a 4-mesh
// silhouette (legs/torso/head/status helmet) instead of ~40 detailed meshes. At
// that range only the blue suit + helmet colour read anyway; the swap cuts the
// plant-overview draw calls by >1k with no legible visual change.
const WORKER_LOD_DISTANCE = 26;

function LineWorkerFigure3D({ mats, phase = 0, ponytail = false, glasses = false, animate }: {
  mats: LineMats; phase?: number; ponytail?: boolean; glasses?: boolean; animate: boolean;
}) {
  const breatheRef = useRef<THREE.Group>(null);
  const armRef = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Group>(null);
  useFrame((st) => {
    const tm = st.clock.elapsedTime + phase;
    // Visible SCREWDRIVING while the line runs: the tool arm presses down onto
    // the piece in slow drive cycles with a fast vibration riding on top, the
    // torso rocks into each drive, the head follows the work point. On a stop
    // everything settles to the lean-in pose (still breathing).
    const drive = Math.sin(tm * 2.6);
    if (breatheRef.current) {
      breatheRef.current.rotation.x = 0.16 + (animate ? Math.max(0, drive) * 0.09 : 0);
      breatheRef.current.position.y = Math.sin(tm * 1.5) * 0.012;
    }
    if (armRef.current) {
      armRef.current.rotation.x = animate
        ? 1.0 + Math.max(0, drive) * 0.28 + Math.sin(tm * 32) * 0.04
        : 0.95;
      armRef.current.rotation.z = animate ? Math.sin(tm * 2.6 + 1.1) * 0.1 : 0;
    }
    if (headRef.current) {
      headRef.current.rotation.x = 0.24 + (animate ? Math.max(0, drive) * 0.06 : 0);
      headRef.current.rotation.y = Math.sin(tm * 0.6) * 0.1;
    }
  });
  return (
    <Detailed distances={[0, WORKER_LOD_DISTANCE]}>
    <group>
      {/* boots + legs */}
      {[-1, 1].map((k) => (
        <group key={`bt${k}`}>
          <mesh material={mats.glove} position={[0.14 * k, 0.11, 0.04]} castShadow>
            <boxGeometry args={[0.2, 0.14, 0.34]} />
          </mesh>
          <mesh material={mats.accent} position={[0.14 * k, 0.03, 0.04]}>
            <boxGeometry args={[0.22, 0.05, 0.38]} />
          </mesh>
          <mesh material={mats.suit} position={[0.14 * k, 0.43, 0]} castShadow>
            <cylinderGeometry args={[0.1, 0.12, 0.42, 10]} />
          </mesh>
        </group>
      ))}
      {/* hips + tool belt: buckle + side pouches */}
      <mesh material={mats.suit} position={[0, 0.7, 0]} castShadow>
        <cylinderGeometry args={[0.25, 0.23, 0.2, 14]} />
      </mesh>
      <mesh material={mats.suitShadow} position={[0, 0.82, 0]}>
        <cylinderGeometry args={[0.265, 0.265, 0.07, 14]} />
      </mesh>
      <mesh material={mats.accent} position={[0, 0.82, 0.25]}>
        <boxGeometry args={[0.11, 0.075, 0.05]} />
      </mesh>
      {[-1, 1].map((k) => (
        <mesh key={`p${k}`} material={mats.suitShadow} position={[0.24 * k, 0.73, 0.1]}>
          <boxGeometry args={[0.1, 0.13, 0.08]} />
        </mesh>
      ))}
      {/* upper body — leans over the piece, breathing */}
      <group ref={breatheRef}>
        <mesh material={mats.suit} position={[0, 1.06, 0]} castShadow>
          <capsuleGeometry args={[0.26, 0.34, 6, 14]} />
        </mesh>
        {[-1, 1].map((k) => (
          <mesh key={`st${k}`} material={mats.suitShadow} position={[0, 1.1, 0.265]} rotation={[0, 0, 0.55 * k]}>
            <boxGeometry args={[0.07, 0.55, 0.02]} />
          </mesh>
        ))}
        {[-1, 1].map((k) => (
          <mesh key={`sh${k}`} material={mats.suitShadow} position={[0.265 * k, 1.33, 0]} castShadow>
            <sphereGeometry args={[0.1, 12, 12]} />
          </mesh>
        ))}
        {/* left arm — steadies the piece */}
        <group position={[-0.3, 1.22, 0]} rotation={[0.9, 0, -0.15]}>
          <mesh material={mats.suit} position={[0, 0.12, 0]} castShadow>
            <capsuleGeometry args={[0.07, 0.2, 6, 10]} />
          </mesh>
          <mesh material={mats.suit} position={[0, 0.3, 0.02]} rotation={[0.2, 0, 0]}>
            <capsuleGeometry args={[0.058, 0.15, 6, 10]} />
          </mesh>
          <mesh material={mats.glove} position={[0, 0.42, 0.04]}>
            <sphereGeometry args={[0.085, 12, 12]} />
          </mesh>
        </group>
        {/* right arm — drives the screwdriver (re-posed every frame) */}
        <group ref={armRef} position={[0.3, 1.26, 0]}>
          <mesh material={mats.suit} position={[0.03, 0.1, 0.01]} rotation={[0, 0, -0.5]} castShadow>
            <capsuleGeometry args={[0.07, 0.2, 6, 10]} />
          </mesh>
          <mesh material={mats.suitShadow} position={[0.08, 0.22, 0.02]}>
            <sphereGeometry args={[0.065, 10, 10]} />
          </mesh>
          <mesh material={mats.suit} position={[0.1, 0.33, 0.03]}>
            <capsuleGeometry args={[0.058, 0.15, 6, 10]} />
          </mesh>
          <mesh material={mats.glove} position={[0.1, 0.44, 0.04]}>
            <sphereGeometry args={[0.088, 12, 12]} />
          </mesh>
          {/* electric screwdriver: dark grip, orange body, metal chuck + bit */}
          <mesh material={mats.glove} position={[0.1, 0.52, 0.05]}>
            <cylinderGeometry args={[0.03, 0.035, 0.1, 8]} />
          </mesh>
          <mesh material={mats.accent} position={[0.1, 0.6, 0.09]} rotation={[0.5, 0, 0]} castShadow>
            <boxGeometry args={[0.08, 0.09, 0.2]} />
          </mesh>
          <mesh material={mats.metal} position={[0.1, 0.66, 0.19]} rotation={[1.1, 0, 0]}>
            <cylinderGeometry args={[0.022, 0.028, 0.1, 8]} />
          </mesh>
          <mesh material={mats.metal} position={[0.1, 0.7, 0.26]} rotation={[1.1, 0, 0]}>
            <cylinderGeometry args={[0.008, 0.008, 0.09, 6]} />
          </mesh>
        </group>
        {/* head: balaclava + face; hard hat dome takes the live status colour */}
        <group ref={headRef} position={[0, 1.47, 0]}>
          <mesh material={mats.suitShadow} position={[0, 0.02, 0]} castShadow>
            <sphereGeometry args={[0.28, 18, 18]} />
          </mesh>
          <mesh material={mats.skin} position={[0, 0.055, 0.2]} scale={[1, 0.8, 0.5]}>
            <sphereGeometry args={[0.195, 16, 16]} />
          </mesh>
          {[-1, 1].map((k) => (
            <group key={`eye${k}`}>
              <mesh material={mats.eyeWhite} position={[0.082 * k, 0.07, 0.275]} scale={[1, 1.2, 0.55]}>
                <sphereGeometry args={[0.045, 12, 12]} />
              </mesh>
              <mesh material={mats.glove} position={[0.077 * k, 0.065, 0.295]}>
                <sphereGeometry args={[0.019, 8, 8]} />
              </mesh>
              {glasses && (
                <mesh material={mats.trim} position={[0.082 * k, 0.07, 0.3]}>
                  <torusGeometry args={[0.075, 0.012, 8, 14]} />
                </mesh>
              )}
            </group>
          ))}
          {glasses && (
            <mesh material={mats.trim} position={[0, 0.088, 0.3]}>
              <boxGeometry args={[0.05, 0.016, 0.015]} />
            </mesh>
          )}
          {ponytail && (
            <mesh material={mats.trim} position={[0, -0.04, -0.27]} rotation={[0.75, 0, 0]} castShadow>
              <capsuleGeometry args={[0.055, 0.22, 6, 10]} />
            </mesh>
          )}
          <mesh material={mats.status} position={[0, 0.19, 0]} scale={[1, 0.68, 1]} castShadow>
            <sphereGeometry args={[0.3, 18, 18]} />
          </mesh>
          <mesh material={mats.trim} position={[0, 0.145, 0]}>
            <cylinderGeometry args={[0.32, 0.32, 0.045, 18]} />
          </mesh>
        </group>
      </group>
    </group>
    {/* far LOD — blue silhouette + live-status helmet (4 meshes) */}
    <group>
      <mesh material={mats.suit} position={[0, 0.38, 0]}>
        <boxGeometry args={[0.42, 0.76, 0.3]} />
      </mesh>
      <mesh material={mats.suit} position={[0, 1.05, 0]}>
        <capsuleGeometry args={[0.26, 0.34, 4, 8]} />
      </mesh>
      <mesh material={mats.suitShadow} position={[0, 1.5, 0]}>
        <sphereGeometry args={[0.28, 8, 8]} />
      </mesh>
      <mesh material={mats.status} position={[0, 1.68, 0]} scale={[1, 0.68, 1]}>
        <sphereGeometry args={[0.31, 8, 8]} />
      </mesh>
    </group>
    </Detailed>
  );
}

/** Glossy speech balloon over a stopped line — same 3D-icon style as the
 * mechanics' initials bubble, sized for a sentence: the stop's justification
 * (or the localized status while nobody has justified it yet). Canvas-drawn
 * text (system fonts) because troika font loading fails offline in this app. */
function StopBalloon({ text, y, mats }: { text: string; y: number; mats: LineMats }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((st) => { if (ref.current) ref.current.position.y = y + Math.sin(st.clock.elapsedTime * 1.6) * 0.06; });
  const tex = useMemo(() => {
    const cvs = document.createElement('canvas');
    cvs.width = 1024; cvs.height = 512;
    const ctx = cvs.getContext('2d')!;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#141c2b';
    // wrap into ≤3 lines, shrinking the font until it fits
    const words = text.split(/\s+/);
    let size = 150;
    let lines: string[] = [];
    for (; size >= 60; size -= 10) {
      ctx.font = `800 ${size}px system-ui, sans-serif`;
      lines = [];
      let cur = '';
      for (const wd of words) {
        const tryLine = cur ? `${cur} ${wd}` : wd;
        if (ctx.measureText(tryLine).width > 900 && cur) { lines.push(cur); cur = wd; }
        else cur = tryLine;
      }
      if (cur) lines.push(cur);
      if (lines.length <= 3 && lines.every((l) => ctx.measureText(l).width <= 900)) break;
    }
    ctx.font = `800 ${size}px system-ui, sans-serif`;
    const lh = size * 1.15;
    const y0 = 256 - ((lines.length - 1) * lh) / 2;
    lines.forEach((l, i) => ctx.fillText(l, 512, y0 + i * lh, 940));
    const t = new THREE.CanvasTexture(cvs);
    t.anisotropy = 8;
    return t;
  }, [text]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <group ref={ref} position={[0, y, 0]}>
      <Billboard>
        <mesh material={mats.bubble} scale={[1.75, 1.08, 0.85]}>
          <sphereGeometry args={[0.85, 24, 18]} />
        </mesh>
        <mesh material={mats.bubble} position={[-0.35, -0.8, 0]} rotation={[0, 0, 2.95]} scale={[1, 1, 0.6]}>
          <coneGeometry args={[0.2, 0.7, 12]} />
        </mesh>
        {/* text plane comfortably inside the ellipsoid so the message reads centred */}
        <mesh position={[0, 0, 0.74]}>
          <planeGeometry args={[2.35, 1.175]} />
          <meshBasicMaterial map={tex} transparent toneMapped={false} depthWrite={false} />
        </mesh>
      </Billboard>
    </group>
  );
}

/** End-of-line TV (Cortex-style scoreboard) on a pole at the line's tip, facing
 * back down the line: header = line name on the live status colour; quadrants =
 * Efficiency % (colour-coded), Actual (shift UE count), Trend (▲/▼ + live rate
 * from the last minutes) and the EVOLVING Standard (target/h × hours elapsed in
 * the shift). Values arrive with the map's 4s WS push; the screen is a canvas
 * texture (system fonts — troika font loading fails offline in this app). */
function LineTV({ x, name, statusColor, stats, mats, lift = 0 }: {
  x: number; name: string; statusColor: string; stats?: LineStats | null; mats: LineMats;
  lift?: number;   // extra pole height — the global TV towers over the line TVs
}) {
  const { t } = useTranslation();
  const th = useContext(TvThresholdsCtx);
  const lEff = t('factoryMap.tvEfficiency'), lActual = t('factoryMap.tvActual');
  const lTrend = t('factoryMap.tvTrend'), lStandard = t('factoryMap.tvStandard');
  const tex = useMemo(() => {
    const W = 1024, H = 680, HEAD = 108, PAD = 12;
    const cvs = document.createElement('canvas');
    cvs.width = W; cvs.height = H;
    const ctx = cvs.getContext('2d')!;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#0b1120';
    ctx.fillRect(0, 0, W, H);
    // header — line name on the live status colour
    ctx.fillStyle = statusColor;
    ctx.fillRect(0, 0, W, HEAD);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 52px system-ui, sans-serif';
    ctx.fillText(name, W / 2, HEAD / 2 + 2, W - 40);
    const cw = (W - 3 * PAD) / 2, chh = (H - HEAD - 3 * PAD) / 2;
    const cell = (cx: number, cy: number, label: string, value: string,
                  opts: { bg?: string; valueColor?: string; valueSize?: number } = {}) => {
      ctx.fillStyle = opts.bg ?? '#111a2c';
      ctx.fillRect(cx, cy, cw, chh);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '600 38px system-ui, sans-serif';
      ctx.fillText(label, cx + cw / 2, cy + 44, cw - 28);
      ctx.fillStyle = opts.valueColor ?? '#ffffff';
      ctx.font = `800 ${opts.valueSize ?? 108}px system-ui, sans-serif`;
      ctx.fillText(value, cx + cw / 2, cy + 44 + (chh - 52) / 2, cw - 32);
    };
    const x0 = PAD, x1 = PAD * 2 + cw, y0 = HEAD + PAD, y1 = HEAD + PAD * 2 + chh;
    const eff = stats?.efficiency_pct ?? null;
    const effBg = effColor(eff, th) ?? '#374151';
    cell(x0, y0, lEff, eff == null ? '—' : `${Math.round(eff)} %`, { bg: effBg });
    cell(x1, y0, lActual, String(stats?.actual ?? 0));
    const trend = stats?.trend ?? 'flat';
    const arrow = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '▬';
    const arrowColor = trend === 'up' ? '#22c55e' : trend === 'down' ? '#ef4444' : '#9ca3af';
    cell(x0, y1, lTrend, `${arrow} ${Math.round(stats?.rate_per_h ?? 0)}/h`,
         { valueColor: arrowColor, valueSize: 92 });
    const tgt = stats?.target_per_hour ?? 0;
    cell(x1, y1, tgt > 0 ? `${lStandard} (${tgt}/h)` : lStandard,
         tgt > 0 ? String(stats?.evolving_target ?? 0) : '—');
    const texture = new THREE.CanvasTexture(cvs);
    texture.anisotropy = 8;
    return texture;
  }, [name, statusColor, lEff, lActual, lTrend, lStandard, th.green_from, th.amber_from,
      stats?.actual, stats?.rate_per_h, stats?.trend,
      stats?.target_per_hour, stats?.evolving_target, stats?.efficiency_pct]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <group position={[x, 0, 0]} rotation={[0, -Math.PI / 2, 0]}>
      <mesh material={mats.base} position={[0, 0.06, 0]}>
        <cylinderGeometry args={[0.5, 0.6, 0.12, 12]} />
      </mesh>
      <mesh material={mats.metal} position={[0, 0.05 + (2.9 + lift) / 2, 0]} castShadow>
        <cylinderGeometry args={[0.09, 0.09, 2.9 + lift, 10]} />
      </mesh>
      <mesh material={mats.trim} position={[0, 4.0 + lift, 0]} castShadow>
        <boxGeometry args={[6.0, 4.1, 0.16]} />
      </mesh>
      <mesh position={[0, 4.0 + lift, 0.085]}>
        <planeGeometry args={[5.7, 3.78]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Central GLOBAL scoreboard for the assembly lines (the Cortex "QS - Global"
 * clock): one oversized TV showing the backend's global clock — the MEASURED
 * Σ Réel/rate of the lines against the plant's OWN global objective (cadence/
 * window/pauses configured on /settings/line-objectives, INDEPENDENT of the
 * per-line objectives). It stands PAST the end of the lines, centred across
 * them and a few metres BEHIND the row of per-line TVs, facing the same way
 * they do — the lines' true end direction is derived from each block's
 * rotation, so any map layout works. Renders nothing without lines/stats. */
function GlobalLineTV({ machines, cx, cy, stats }: { machines: M3D[]; cx: number; cy: number; stats?: LineStats | null }) {
  const { t } = useTranslation();
  const th = useContext(TvThresholdsCtx);
  // The lines only give the TV its PLACE — the numbers come from the payload.
  const lines = useMemo(
    () => machines.filter((m) => m.block_kind === 'assembly_line'),
    [machines],
  );
  // The GLOBAL header takes the aggregated efficiency's colour (configurable
  // thresholds) — grey while no objective produces a standard yet.
  const headerColor = effColor(stats?.efficiency_pct, th) ?? '#374151';
  const mats = useLineMats(headerColor);
  if (!stats || !lines.length) return null;
  // Average of the lines' TV points (each line's end, where its own TV stands)
  // and of their end directions (local +x rotated by the block's yaw).
  let ex = 0, ez = 0, dx = 0, dz = 0;
  for (const m of lines) {
    const yaw = -((m.rotation_deg ?? 0) * Math.PI) / 180;
    const w = Math.max(m.pos_w, 40) * SCALE;
    const mx = ((m.pos_x + m.pos_w / 2) - cx) * SCALE;
    const mz = ((m.pos_y + m.pos_h / 2) - cy) * SCALE;
    const dirX = Math.cos(yaw), dirZ = -Math.sin(yaw);
    ex += mx + dirX * (w / 2 + 1.3);
    ez += mz + dirZ * (w / 2 + 1.3);
    dx += dirX; dz += dirZ;
  }
  ex /= lines.length; ez /= lines.length;
  const dLen = Math.hypot(dx, dz) || 1;
  dx /= dLen; dz /= dLen;
  const BEHIND = 8;                                  // metres past the per-line TV row
  const yawAvg = Math.atan2(-dz, dx);
  return (
    // Same construction as a line TV (the wrapper yaw plays the line group's
    // role, LineTV's internal -90° then faces it back down the lines). The
    // lift raises it well above the per-line TV row.
    <group position={[ex + dx * BEHIND, 0, ez + dz * BEHIND]} rotation={[0, yawAvg, 0]} scale={1.6}>
      <LineTV x={0} name={t('factoryMap.tvGlobal')} statusColor={headerColor} stats={stats} mats={mats} lift={2.4} />
    </group>
  );
}

function AssemblyLineMesh({ w, d, h, color, id, name, onSelect, animate, status, stopReason, lineStats }: BoxProps & { animate?: boolean; status?: string; stopReason?: string | null; lineStats?: LineStats | null }) {
  const { i18n } = useTranslation();
  const lang = (i18n.language || 'en').slice(0, 2) as 'en' | 'fr' | 'es';
  const mats = useLineMats(color);
  const N = LINE_MODULES;
  const mw = w / N;
  const db = Math.min(d * 0.55, 2.6);                              // belt depth — the rest is worker floor
  const deckH = LINE_DECK_H;                                       // one LEVEL waist-high deck
  const maxH = deckH;
  const run = animate ?? false;
  const stopped = LINE_STOPPED.has(status ?? '');
  const balloonText = (stopReason || (status ? STATUS_LABELS[status]?.[lang] ?? status : '')).trim();
  const workerZ = db / 2 + 0.5;
  return (
    <group {...boxHandlers(id, onSelect)}>
      {/* invisible pick volume covering the whole line */}
      <mesh position={[0, maxH / 2 + 0.2, 0]}>
        <boxGeometry args={[w, maxH + 0.4, d]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {Array.from({ length: N }).map((_, i) => (
        <ScissorModule key={i} x={-w / 2 + (i + 0.5) * mw} mw={mw} db={db} deckH={deckH} mats={mats} />
      ))}
      <FurnitureFlow w={w} db={db} deckH={deckH} animate={run} mats={mats} />
      {/* five workers, one per module; the ponytailed one works the back
          side, the third wears glasses */}
      {Array.from({ length: N }).map((_, i) => {
        const back = i === 1;
        return (
          <group key={`wk${i}`}
            position={[-w / 2 + (i + 0.5) * mw, 0, back ? -workerZ : workerZ]}
            rotation={[0, back ? 0 : Math.PI, 0]}>
            <LineWorkerFigure3D mats={mats} phase={i * 1.3} ponytail={i === 1} glasses={i === 2} animate={run} />
          </group>
        );
      })}
      {/* end-of-line TV — the units come off the belt right under it */}
      <LineTV x={w / 2 + 1.3} name={name} statusColor={color} stats={lineStats} mats={mats} />
      {stopped && balloonText && <StopBalloon text={balloonText} y={maxH + 2.1} mats={mats} />}
      <Label y={maxH + 3.6} text={name} />
    </group>
  );
}

// ── Upholstery cell (block_kind='assembly_line' whose name reads "rembourrage") ──
// Same ninja-worker style as the assembly lines, but the belt is replaced by a
// STATIONED upholstery cell: several workbenches where the crew staples fabric
// over foam, works sofa frames (springs + webbing), inspects quilted backrests
// and finishes armchairs — around them a fabric-roll rack, foam stacks, a tool
// cart, a compartmented parts bin, a cushion cart and a "Cellule de Rembourrage"
// sign. Helmets still take the live status colour; the same stop balloon and
// end-of-line TV as the assembly lines are reused.
function isUpholstery(name: string): boolean {
  return /rembourr|upholster|estofa/i.test(name);
}

function UpholsteryCellMesh({ w, d, color, id, name, onSelect, animate, status, stopReason, lineStats }: Omit<BoxProps, 'h'> & { animate?: boolean; status?: string; stopReason?: string | null; lineStats?: LineStats | null }) {
  const { i18n } = useTranslation();
  const lang = (i18n.language || 'en').slice(0, 2) as 'en' | 'fr' | 'es';
  const mats = useLineMats(color);
  const run = animate ?? false;
  const stopped = LINE_STOPPED.has(status ?? '');
  const balloonText = (stopReason || (status ? STATUS_LABELS[status]?.[lang] ?? status : '')).trim();

  // Upholstery-specific materials (foam, fabrics, blue carts) — disposed on unmount.
  const xm = useMemo(() => ({
    foam:        new THREE.MeshStandardMaterial({ color: '#ece5d2', roughness: 0.97 }),
    fabricBlue:  new THREE.MeshStandardMaterial({ color: '#4f6f9e', roughness: 0.85 }),
    fabricGrey:  new THREE.MeshStandardMaterial({ color: '#b9bec7', roughness: 0.85 }),
    fabricBeige: new THREE.MeshStandardMaterial({ color: '#cdbb98', roughness: 0.85 }),
    cart:        new THREE.MeshStandardMaterial({ color: '#2563b0', roughness: 0.5, metalness: 0.2 }),
    webbing:     new THREE.MeshStandardMaterial({ color: '#c9a86a', roughness: 0.8 }),
    yellow:      new THREE.MeshStandardMaterial({ color: '#d8b400', roughness: 0.6 }),
    rubber:      new THREE.MeshStandardMaterial({ color: '#15181d', roughness: 0.8 }),
  }), []);
  useEffect(() => () => Object.values(xm).forEach((m) => m.dispose()), [xm]);

  // "Cellule de Rembourrage" sign face (canvas texture — troika fonts fail offline).
  // In-world French shop signage, kept verbatim (not app UI → not translated).
  const signTex = useMemo(() => {
    const cvs = document.createElement('canvas'); cvs.width = 640; cvs.height = 256;
    const ctx = cvs.getContext('2d')!;
    ctx.fillStyle = '#0b1120'; ctx.fillRect(0, 0, 640, 256);
    ctx.fillStyle = '#1e2740'; ctx.fillRect(0, 0, 640, 70);
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 44px system-ui, sans-serif';
    ctx.fillText('Cellule de Rembourrage', 320, 38, 600);
    ctx.fillStyle = '#93b4e6'; ctx.font = '600 30px system-ui, sans-serif';
    ctx.fillText('Confort · Qualité · Savoir-Faire', 320, 150, 560);
    ctx.fillStyle = '#cbd5e1';
    ctx.fillRect(288, 188, 64, 34); ctx.fillRect(288, 165, 12, 57); ctx.fillRect(340, 178, 12, 44);
    const tex = new THREE.CanvasTexture(cvs); tex.anisotropy = 8;
    return tex;
  }, []);
  useEffect(() => () => signTex.dispose(), [signTex]);

  const benchTop = 0.85;
  // Bench (wood top on dark legs + a lower shelf).
  const bench = (bw: number, bd: number) => (
    <group>
      <mesh material={mats.wood} position={[0, benchTop, 0]} castShadow receiveShadow><boxGeometry args={[bw, 0.08, bd]} /></mesh>
      {([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).map(([sx, sz], i) => (
        <mesh key={i} material={mats.base} position={[sx * bw / 2 * 0.86, benchTop / 2, sz * bd / 2 * 0.82]}><boxGeometry args={[0.06, benchTop, 0.06]} /></mesh>
      ))}
      <mesh material={mats.base} position={[0, benchTop * 0.4, 0]}><boxGeometry args={[bw * 0.9, 0.04, bd * 0.78]} /></mesh>
    </group>
  );

  // The workpiece sitting on a bench, per station kind (rests just above the top).
  const piece = (kind: string) => {
    const y = benchTop + 0.02;
    switch (kind) {
      case 'frame': return (   // open sofa/chair frame: rails + steel springs + beige webbing
        <group position={[0, y, 0]}>
          {[-1, 1].map((s) => <mesh key={`rx${s}`} material={mats.wood} position={[0, 0.05, s * 0.28]}><boxGeometry args={[1.0, 0.06, 0.06]} /></mesh>)}
          {[-1, 1].map((s) => <mesh key={`rz${s}`} material={mats.wood} position={[s * 0.48, 0.05, 0]}><boxGeometry args={[0.06, 0.06, 0.56]} /></mesh>)}
          {[-0.25, 0, 0.25].map((zz, i) => <mesh key={`wb${i}`} material={xm.webbing} position={[0, 0.09, zz]}><boxGeometry args={[0.94, 0.015, 0.05]} /></mesh>)}
          {[-0.3, 0.1].map((xx, i) => <mesh key={`sp${i}`} material={mats.metal} position={[xx, 0.14, 0]}><cylinderGeometry args={[0.05, 0.05, 0.14, 8]} /></mesh>)}
          {[-1, 1].map((s) => <mesh key={`up${s}`} material={mats.wood} position={[s * 0.48, 0.3, -0.28]} castShadow><boxGeometry args={[0.06, 0.5, 0.06]} /></mesh>)}
        </group>
      );
      case 'foamfab': return (  // foam slab with blue-grey fabric being stretched over it
        <group position={[0, y, 0]}>
          <mesh material={xm.foam} position={[0, 0.08, 0]}><boxGeometry args={[0.9, 0.16, 0.6]} /></mesh>
          <mesh material={xm.fabricBlue} position={[0.03, 0.17, 0.02]} rotation={[0, 0, 0.02]}><boxGeometry args={[1.02, 0.04, 0.7]} /></mesh>
        </group>
      );
      case 'foam': return (     // loose foam blocks
        <group position={[0, y, 0]}>
          {([[-0.25, 0.09, 0], [0.2, 0.09, 0.05], [0.0, 0.28, -0.02]] as const).map((p, i) => (
            <mesh key={i} material={xm.foam} position={p} castShadow><boxGeometry args={[0.4, 0.16, 0.5]} /></mesh>
          ))}
        </group>
      );
      case 'backrest': return ( // beige quilted backrest with vertical channels
        <group position={[0, y, 0]}>
          <mesh material={xm.fabricBeige} position={[0, 0.4, 0]} castShadow><boxGeometry args={[0.9, 0.8, 0.14]} /></mesh>
          {[-0.3, -0.1, 0.1, 0.3].map((xx, i) => <mesh key={i} material={mats.trim} position={[xx, 0.4, 0.08]}><boxGeometry args={[0.02, 0.76, 0.02]} /></mesh>)}
        </group>
      );
      default: return (         // curved chair frame, partly covered
        <group position={[0, y, 0]}>
          <mesh material={mats.wood} position={[0, 0.12, 0]} castShadow><boxGeometry args={[0.7, 0.18, 0.6]} /></mesh>
          <mesh material={mats.wood} position={[0, 0.45, -0.26]} rotation={[-0.25, 0, 0]} castShadow><boxGeometry args={[0.68, 0.5, 0.1]} /></mesh>
          <mesh material={xm.fabricGrey} position={[0, 0.22, 0.05]}><boxGeometry args={[0.72, 0.05, 0.5]} /></mesh>
        </group>
      );
    }
  };

  // A finished 2-seat sofa (base + backrest + arms + loose seat/back cushions on
  // small feet) — staged at the end of the line as completed goods. Faces +Z.
  const sofa = (mat: THREE.Material) => (
    <group>
      <mesh material={mat} position={[0, 0.32, 0]} castShadow><boxGeometry args={[2.0, 0.34, 0.95]} /></mesh>
      <mesh material={mat} position={[0, 0.64, -0.36]} castShadow><boxGeometry args={[2.0, 0.62, 0.22]} /></mesh>
      {[-1, 1].map((s) => <mesh key={`arm${s}`} material={mat} position={[s * 0.92, 0.5, 0.02]} castShadow><boxGeometry args={[0.18, 0.5, 0.92]} /></mesh>)}
      {[-0.5, 0.5].map((x, i) => <mesh key={`sc${i}`} material={mat} position={[x, 0.53, 0.06]}><boxGeometry args={[0.86, 0.16, 0.8]} /></mesh>)}
      {[-0.5, 0.5].map((x, i) => <mesh key={`bc${i}`} material={mat} position={[x, 0.74, -0.28]}><boxGeometry args={[0.86, 0.5, 0.14]} /></mesh>)}
      {([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).map(([sx, sz], i) => (
        <mesh key={`ft${i}`} material={mats.trim} position={[sx * 0.9, 0.08, sz * 0.38]}><boxGeometry args={[0.08, 0.16, 0.08]} /></mesh>
      ))}
    </group>
  );

  // Five stations: bench + workpiece + a worker leaning in on one side.
  const stations = [
    { fx: -0.30, fz: 0.20, side: -1, kind: 'frame',    ponytail: false, glasses: false },
    { fx: -0.02, fz: 0.24, side: 1,  kind: 'foamfab',  ponytail: false, glasses: false },
    { fx: -0.28, fz: -0.16, side: -1, kind: 'foam',    ponytail: false, glasses: false },
    { fx: 0.12,  fz: -0.12, side: 1,  kind: 'backrest', ponytail: false, glasses: true },
    { fx: 0.32,  fz: 0.16, side: -1, kind: 'chair',    ponytail: true,  glasses: false },
  ] as const;

  // Three more workers stationed at the props (inspecting the finished armchair,
  // pushing the cushion cart, handling fabric at the rack). With the two at the
  // fabric table below, this brings the crew to ten. `dz`/`side` place & face each.
  const extraWorkers = [
    { fx: 0.37,  fz: 0.36,  dz: 0.95, side: 1,  phase: 6.0, ponytail: false, glasses: true },
    { fx: 0.22,  fz: -0.26, dz: 0.75, side: -1, phase: 7.2, ponytail: false, glasses: false },
    { fx: -0.30, fz: -0.40, dz: 0.95, side: 1,  phase: 8.4, ponytail: true,  glasses: false },
  ] as const;

  return (
    <group {...boxHandlers(id, onSelect)}>
      {/* invisible pick volume covering the whole cell */}
      <mesh position={[0, 1.2, 0]}><boxGeometry args={[w, 2.4, d]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} /></mesh>

      {/* yellow floor boundary marking the cell */}
      {[-1, 1].map((s) => <mesh key={`fx${s}`} material={xm.yellow} position={[0, 0.02, s * d * 0.46]}><boxGeometry args={[w * 0.94, 0.02, 0.06]} /></mesh>)}
      {[-1, 1].map((s) => <mesh key={`fz${s}`} material={xm.yellow} position={[s * w * 0.46, 0.02, 0]}><boxGeometry args={[0.06, 0.02, d * 0.92]} /></mesh>)}

      {/* work stations */}
      {stations.map((s, i) => {
        const bx = s.fx * w, bz = s.fz * d;
        const wz = bz + s.side * 0.78;
        return (
          <group key={`stn${i}`}>
            <group position={[bx, 0, bz]}>{bench(1.5, 0.85)}{piece(s.kind)}</group>
            <group position={[bx, 0, wz]} rotation={[0, s.side > 0 ? Math.PI : 0, 0]}>
              <LineWorkerFigure3D mats={mats} phase={i * 1.4} ponytail={s.ponytail} glasses={s.glasses} animate={run} />
            </group>
          </group>
        );
      })}

      {/* long fabric table — two workers stretch a big blue sheet over it */}
      <group position={[-0.05 * w, 0, -0.32 * d]}>
        {bench(3.2, 1.1)}
        <mesh material={xm.fabricBlue} position={[0, benchTop + 0.07, 0]} rotation={[0, 0, 0.01]} castShadow><boxGeometry args={[3.0, 0.04, 0.95]} /></mesh>
        {([1, -1] as const).map((sd, i) => (
          <group key={`ft${i}`} position={[sd * 0.9, 0, sd * (0.55 + 0.72)]} rotation={[0, sd > 0 ? Math.PI : 0, 0]}>
            <LineWorkerFigure3D mats={mats} phase={9 + i * 1.6} ponytail={i === 1} glasses={false} animate={run} />
          </group>
        ))}
      </group>

      {/* three more workers stationed at the props (→ ten in total) */}
      {extraWorkers.map((e, i) => (
        <group key={`xw${i}`} position={[e.fx * w, 0, e.fz * d + e.side * e.dz]} rotation={[0, e.side > 0 ? Math.PI : 0, 0]}>
          <LineWorkerFigure3D mats={mats} phase={e.phase} ponytail={e.ponytail} glasses={e.glasses} animate={run} />
        </group>
      ))}

      {/* fabric-roll rack (back-left) */}
      <group position={[-0.30 * w, 0, -0.40 * d]}>
        {[-1, 1].map((s) => <mesh key={s} material={mats.metal} position={[s * 0.9, 1.0, 0]} castShadow><boxGeometry args={[0.08, 2.0, 0.08]} /></mesh>)}
        {[0.5, 1.1, 1.7].map((yy, i) => <mesh key={i} material={mats.metal} position={[0, yy, 0]}><boxGeometry args={[1.9, 0.05, 0.5]} /></mesh>)}
        {([[0.5, xm.fabricGrey], [1.1, xm.fabricBeige], [1.7, xm.fabricBlue]] as const).flatMap(([yy, mat], i) => (
          [-0.45, 0.45].map((xx, j) => (
            <mesh key={`${i}-${j}`} material={mat} position={[xx, yy + 0.15, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
              <cylinderGeometry args={[0.12, 0.12, 0.8, 12]} />
            </mesh>
          ))
        ))}
      </group>

      {/* foam stack (left) */}
      <group position={[-0.42 * w, 0, 0.02 * d]}>
        {[0.12, 0.32, 0.52].map((yy, i) => <mesh key={i} material={xm.foam} position={[i * 0.04, yy, 0]} castShadow><boxGeometry args={[0.7, 0.18, 0.9]} /></mesh>)}
      </group>

      {/* finished armchair (front-right, for inspection) */}
      <group position={[0.37 * w, 0, 0.36 * d]} rotation={[0, Math.PI * 0.15, 0]}>
        <mesh material={xm.fabricGrey} position={[0, 0.35, 0]} castShadow><boxGeometry args={[0.9, 0.3, 0.85]} /></mesh>
        <mesh material={xm.fabricGrey} position={[0, 0.6, 0.03]}><boxGeometry args={[0.78, 0.18, 0.72]} /></mesh>
        <mesh material={xm.fabricGrey} position={[0, 0.78, -0.36]} castShadow><boxGeometry args={[0.9, 0.7, 0.18]} /></mesh>
        {[-1, 1].map((s) => <mesh key={s} material={xm.fabricGrey} position={[s * 0.46, 0.62, 0.05]}><boxGeometry args={[0.16, 0.45, 0.82]} /></mesh>)}
      </group>

      {/* finished sofas staged at the END of the line (+X, by the outfeed TV) */}
      {([[-0.28, xm.fabricGrey], [-0.06, xm.fabricBeige], [0.16, xm.fabricBlue]] as const).map(([fz, mat], i) => (
        <group key={`sofa${i}`} position={[0.43 * w, 0, fz * d]} rotation={[0, -Math.PI * 0.12, 0]}>
          {sofa(mat)}
        </group>
      ))}

      {/* tool cart (front-left, "Outils et Agrafes") */}
      <group position={[-0.42 * w, 0, 0.34 * d]}>
        <mesh material={xm.cart} position={[0, 0.45, 0]} castShadow><boxGeometry args={[0.7, 0.9, 0.5]} /></mesh>
        {[0.25, 0.5, 0.75].map((yy, i) => <mesh key={i} material={mats.trim} position={[0, yy, 0.26]}><boxGeometry args={[0.6, 0.02, 0.02]} /></mesh>)}
        <mesh material={mats.wood} position={[0, 0.93, 0]}><boxGeometry args={[0.78, 0.05, 0.56]} /></mesh>
        <mesh material={mats.accent} position={[0.12, 1.0, 0]} rotation={[0, 0.3, 0]} castShadow><boxGeometry args={[0.1, 0.1, 0.22]} /></mesh>
      </group>

      {/* parts bin (front-centre, "Agrafes, Vis, Accessoires") */}
      <group position={[0.02 * w, 0, 0.43 * d]}>
        <mesh material={xm.cart} position={[0, 0.2, 0]} castShadow><boxGeometry args={[1.0, 0.4, 0.6]} /></mesh>
        {[-0.33, 0, 0.33].map((xx, i) => <mesh key={`dx${i}`} material={mats.trim} position={[xx, 0.42, 0]}><boxGeometry args={[0.02, 0.06, 0.56]} /></mesh>)}
        {[-0.33, 0, 0.33].map((xx, i) => <mesh key={`pb${i}`} material={mats.metal} position={[xx, 0.44, 0]}><boxGeometry args={[0.22, 0.04, 0.42]} /></mesh>)}
      </group>

      {/* cushion cart (right) */}
      <group position={[0.22 * w, 0, -0.26 * d]}>
        <mesh material={xm.cart} position={[0, 0.35, 0]}><boxGeometry args={[0.7, 0.1, 1.0]} /></mesh>
        {([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).map(([sx, sz], i) => (
          <mesh key={`ps${i}`} material={mats.metal} position={[sx * 0.3, 0.5, sz * 0.45]}><boxGeometry args={[0.04, 0.4, 0.04]} /></mesh>
        ))}
        {([[0.44, xm.fabricGrey], [0.57, xm.fabricBeige], [0.70, xm.fabricGrey]] as const).map(([yy, mat], i) => (
          <mesh key={`cu${i}`} material={mat} position={[0, yy, 0]} castShadow><boxGeometry args={[0.6, 0.12, 0.9]} /></mesh>
        ))}
        {([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).map(([sx, sz], i) => (
          <mesh key={`wh${i}`} material={xm.rubber} position={[sx * 0.3, 0.05, sz * 0.45]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[0.07, 0.07, 0.05, 10]} /></mesh>
        ))}
      </group>

      {/* "Cellule de Rembourrage" sign on a post (back-right) */}
      <group position={[0.30 * w, 0, -0.42 * d]}>
        <mesh material={mats.metal} position={[0, 1.2, 0]} castShadow><cylinderGeometry args={[0.06, 0.06, 2.4, 8]} /></mesh>
        <mesh material={mats.trim} position={[0, 2.5, 0]} castShadow><boxGeometry args={[2.2, 0.9, 0.1]} /></mesh>
        <mesh position={[0, 2.5, 0.055]}><planeGeometry args={[2.1, 0.8]} /><meshBasicMaterial map={signTex} toneMapped={false} /></mesh>
      </group>

      {/* end-of-line TV + stop balloon + name tag (same as the assembly lines) */}
      <LineTV x={w / 2 + 1.3} name={name} statusColor={color} stats={lineStats} mats={mats} />
      {stopped && balloonText && <StopBalloon text={balloonText} y={3.0} mats={mats} />}
      <Label y={3.4} text={name} />
    </group>
  );
}

function LiftTableMesh({ w, d, h, color, id, name, onSelect }: BoxProps) {
  return (
    <group {...boxHandlers(id, onSelect)}>
      <mesh position={[0, h * 0.06, 0]} castShadow receiveShadow>
        <boxGeometry args={[w * 0.9, h * 0.12, d * 0.9]} />
        <meshStandardMaterial color="#1f2937" />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[0, h * 0.45, 0]} rotation={[0, 0, s * 0.6]} castShadow>
          <boxGeometry args={[w * 0.12, h * 0.7, d * 0.7]} />
          <meshStandardMaterial color="#475569" metalness={0.4} roughness={0.5} />
        </mesh>
      ))}
      <mesh position={[0, h * 0.9, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, h * 0.12, d]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <Label y={h + 0.6} text={name} />
    </group>
  );
}

function WorkTableMesh({ w, d, h, color, id, name, onSelect }: BoxProps) {
  const topY = h * 0.92;
  const legW = Math.max(w * 0.05, 0.06), legD = Math.max(d * 0.05, 0.06);
  return (
    <group {...boxHandlers(id, onSelect)}>
      <mesh position={[0, topY, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, h * 0.1, d]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], i) => (
        <mesh key={i} position={[(sx * w) / 2 * 0.88, topY / 2, (sz * d) / 2 * 0.88]} castShadow>
          <boxGeometry args={[legW, topY, legD]} />
          <meshStandardMaterial color="#1f2937" />
        </mesh>
      ))}
      <Label y={h + 0.6} text={name} />
    </group>
  );
}

function RackMesh({ w, d, h, color, id, name, onSelect }: BoxProps) {
  const shelves = 3;
  const postW = Math.max(w * 0.04, 0.05), postD = Math.max(d * 0.04, 0.05);
  return (
    <group {...boxHandlers(id, onSelect)}>
      {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], i) => (
        <mesh key={i} position={[(sx * w) / 2 * 0.95, h / 2, (sz * d) / 2 * 0.95]} castShadow>
          <boxGeometry args={[postW, h, postD]} />
          <meshStandardMaterial color={color} metalness={0.3} roughness={0.6} />
        </mesh>
      ))}
      {Array.from({ length: shelves }).map((_, i) => (
        <mesh key={i} position={[0, (i + 1) * (h / (shelves + 1)), 0]} castShadow receiveShadow>
          <boxGeometry args={[w, h * 0.03, d]} />
          <meshStandardMaterial color="#6b7280" />
        </mesh>
      ))}
      <Label y={h + 0.6} text={name} />
    </group>
  );
}

function DustCollectorMesh({ w, d, h, color, id, name, onSelect }: BoxProps) {
  const r = Math.min(w, d) * 0.4;
  return (
    <group {...boxHandlers(id, onSelect)}>
      <mesh position={[0, h * 0.55, 0]} castShadow>
        <cylinderGeometry args={[r, r, h * 0.6, 20]} />
        <meshStandardMaterial color={color} metalness={0.3} roughness={0.6} />
      </mesh>
      <mesh position={[0, h * 0.2, 0]} rotation={[Math.PI, 0, 0]} castShadow>
        <coneGeometry args={[r, h * 0.3, 20]} />
        <meshStandardMaterial color="#374151" />
      </mesh>
      <mesh position={[r * 1.1, h * 0.5, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[r * 0.18, r * 0.18, r * 1.3, 12]} />
        <meshStandardMaterial color="#6b7280" metalness={0.5} roughness={0.4} />
      </mesh>
      <Label y={h + 0.6} text={name} />
    </group>
  );
}

/** Biesse Selco panel/beam saw — stylized placeholder.
 * Cutting line runs along X. Back (−Z): loading table with rollers, a gantry beam
 * on end posts and a pusher carriage. Centre: tall cutting body with a pressure-beam
 * hood, dark cutting slot and the signature green Biesse corner panels. Front (+Z):
 * low air/outfeed tables and an HMI screen on a post. Top stripe carries the live
 * status colour. */
function BeamSawMesh({ w, d, h, color, id, name, onSelect }: BoxProps) {
  const bodyGrey = '#dfe2e6', midGrey = '#b9bec5', dark = '#3a3f47', steel = '#9aa0a8', green = '#76b82a';
  const bodyW = w * 0.58, bodyD = d * 0.30;
  const tableH = h * 0.30;                      // surface height of the feed/air tables
  const rollers = Math.max(4, Math.min(10, Math.round(w / 0.9)));
  return (
    <group {...boxHandlers(id, onSelect)}>
      {/* ── Rear loading table (−Z) ── */}
      <mesh position={[0, tableH * 0.5, -d * 0.33]} castShadow receiveShadow>
        <boxGeometry args={[w * 0.9, tableH, d * 0.34]} />
        <meshStandardMaterial color={steel} metalness={0.35} roughness={0.55} />
      </mesh>
      {Array.from({ length: rollers }).map((_, i) => {
        const x = -w * 0.42 + (i + 0.5) * (w * 0.84 / rollers);
        return (
          <mesh key={`r${i}`} position={[x, tableH + h * 0.015, -d * 0.33]} rotation={[Math.PI / 2, 0, 0]} castShadow>
            <cylinderGeometry args={[h * 0.018, h * 0.018, d * 0.30, 8]} />
            <meshStandardMaterial color="#c2c7cd" metalness={0.6} roughness={0.4} />
          </mesh>
        );
      })}
      {/* gantry: end posts + cross beam over the loading table + pusher carriage */}
      {[-1, 1].map((s) => (
        <mesh key={`gp${s}`} position={[s * w * 0.44, tableH + h * 0.28, -d * 0.33]} castShadow>
          <boxGeometry args={[w * 0.035, h * 0.56, d * 0.05]} />
          <meshStandardMaterial color={dark} metalness={0.4} roughness={0.5} />
        </mesh>
      ))}
      <mesh position={[0, tableH + h * 0.56, -d * 0.33]} castShadow>
        <boxGeometry args={[w * 0.93, h * 0.07, d * 0.06]} />
        <meshStandardMaterial color={dark} metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[-w * 0.12, tableH + h * 0.56, -d * 0.28]} castShadow>
        <boxGeometry args={[w * 0.12, h * 0.1, d * 0.1]} />
        <meshStandardMaterial color="#5b6066" metalness={0.4} roughness={0.5} />
      </mesh>

      {/* ── Main cutting body (centre) ── */}
      <mesh position={[0, h * 0.5, 0]} castShadow receiveShadow>
        <boxGeometry args={[bodyW, h, bodyD]} />
        <meshStandardMaterial color={bodyGrey} metalness={0.1} roughness={0.5} />
      </mesh>
      {/* pressure-beam hood across the front upper face + dark cutting slot */}
      <mesh position={[0, h * 0.74, bodyD * 0.5 + d * 0.02]} castShadow>
        <boxGeometry args={[bodyW * 1.02, h * 0.26, d * 0.05]} />
        <meshStandardMaterial color={midGrey} metalness={0.2} roughness={0.5} />
      </mesh>
      <mesh position={[0, h * 0.56, bodyD * 0.5 + d * 0.03]}>
        <boxGeometry args={[bodyW * 0.9, h * 0.05, d * 0.015]} />
        <meshStandardMaterial color="#22262b" />
      </mesh>
      {/* signature green Biesse corner panels */}
      {[-1, 1].map((s) => (
        <mesh key={`gr${s}`} position={[s * bodyW * 0.5, h * 0.42, bodyD * 0.5 + d * 0.006]} castShadow>
          <boxGeometry args={[w * 0.045, h * 0.82, d * 0.09]} />
          <meshStandardMaterial color={green} roughness={0.5} />
        </mesh>
      ))}
      {/* status accent stripe on top of the body */}
      <mesh position={[0, h * 1.01, 0]}>
        <boxGeometry args={[bodyW * 0.96, h * 0.035, bodyD * 0.9]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35} />
      </mesh>

      {/* ── Front air/outfeed tables (+Z) ── */}
      <mesh position={[-w * 0.05, tableH, d * 0.34]} castShadow receiveShadow>
        <boxGeometry args={[w * 0.6, h * 0.07, d * 0.32]} />
        <meshStandardMaterial color="#cfd3d9" metalness={0.1} roughness={0.6} />
      </mesh>
      <mesh position={[w * 0.3, tableH * 0.96, d * 0.3]} castShadow receiveShadow>
        <boxGeometry args={[w * 0.26, h * 0.07, d * 0.24]} />
        <meshStandardMaterial color="#cfd3d9" metalness={0.1} roughness={0.6} />
      </mesh>
      {[[-w * 0.28, d * 0.42], [w * 0.18, d * 0.42], [w * 0.4, d * 0.36]].map(([lx, lz], i) => (
        <mesh key={`lg${i}`} position={[lx, tableH * 0.5, lz]} castShadow>
          <boxGeometry args={[w * 0.02, tableH, d * 0.02]} />
          <meshStandardMaterial color={dark} />
        </mesh>
      ))}

      {/* ── HMI operator screen on a post (front-left) ── */}
      <mesh position={[-w * 0.4, tableH + h * 0.18, d * 0.16]} castShadow>
        <boxGeometry args={[w * 0.015, h * 0.36, d * 0.015]} />
        <meshStandardMaterial color="#5b6066" metalness={0.3} roughness={0.5} />
      </mesh>
      <mesh position={[-w * 0.38, tableH + h * 0.4, d * 0.18]} rotation={[0.25, 0.35, 0]} castShadow>
        <boxGeometry args={[w * 0.13, h * 0.16, d * 0.012]} />
        <meshStandardMaterial color="#1f6feb" emissive="#1f6feb" emissiveIntensity={0.4} roughness={0.3} />
      </mesh>

      <Label y={h + 0.7} text={name} />
    </group>
  );
}

// ── Pit Stop (block_kind='pit_stop') — the buffer between fabrication and the
// assembly lines: 41 roller conveyors of 44 ft (config-driven via the zone's
// specifications, delivered with the polled state). The static structure is
// fully INSTANCED (rollers / rails / legs = 3 draw calls); the OFs present in
// the buffer stand on the lanes as stacks of slabs — one slab per component,
// coloured by its CATEGORY (configurable registry), the slab pile growing with
// the on-hand quantity — over a base plate coloured by the OF's derived STATE
// (own palette, deliberately distinct from machine status). Hover shows the OF
// chip; click opens the OF side panel. Data arrives via PitStopCtx (the map
// page polls /api/pit-stop/{plant}/state ~15 s); without data (Home preview,
// other plants) only the empty structure renders.

export type PitStopCtxValue = {
  state: PitStopState | null;
  onSelectOf?: (jobOrderId: string) => void;
  selectedOfId?: string | null;
};
const PitStopCtx = createContext<PitStopCtxValue>({ state: null });

const PIT_DEFAULTS = { lanes: 41, slots_per_lane: 8, sg_lanes: 7 };

// Furniture-family accents used to delineate the two physical buffer areas
// (case goods vs soft goods) on the 3D map and in the legend.
const CG_ACCENT = '#f59e0b';   // amber — case goods (the large area)
const SG_ACCENT = '#8b5cf6';   // violet — soft goods (the smaller area)

/** The static conveyor field — one InstancedMesh each for rollers, rails and
 * legs, matrices set once per geometry change. No pointer handlers → R3F never
 * raycasts these ~1700 instances. The lanes are split into a soft-goods block
 * (first `sgLanes`) and a case-goods block, separated by a `gap` aisle. */
function PitStopStructure({ w, d, lanes, sgLanes, gap, pitch, mats }: {
  w: number; d: number; lanes: number; sgLanes: number; gap: number; pitch: number; mats: PitMats;
}) {
  const laneW = Math.min(pitch * 0.78, 1.15);
  const rollerR = Math.max(0.03, Math.min(pitch * 0.16, 0.07));
  const legH = 0.5;
  const deckY = legH + rollerR;                       // roller axis height
  const perLane = Math.max(6, Math.min(36, Math.round(w / 0.55)));
  const legPairs = Math.max(2, Math.min(9, Math.round(w / 2.4)));

  const rollers = useRef<THREE.InstancedMesh>(null);
  const rails = useRef<THREE.InstancedMesh>(null);
  const legs = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const o = new THREE.Object3D();
    // lane i (0-based) sits past the aisle once it belongs to the case-goods block.
    const laneZ = (i: number) => -d / 2 + (i + 0.5) * pitch + (i >= sgLanes ? gap : 0);
    let r = 0, ra = 0, lg = 0;
    for (let i = 0; i < lanes; i++) {
      const z = laneZ(i);
      for (let j = 0; j < perLane; j++) {
        o.position.set(-w / 2 + (j + 0.5) * (w / perLane), deckY, z);
        o.rotation.set(Math.PI / 2, 0, 0);            // cylinder lies across the lane
        o.scale.set(1, 1, 1);
        o.updateMatrix();
        rollers.current?.setMatrixAt(r++, o.matrix);
      }
      for (const s of [-1, 1]) {
        o.position.set(0, deckY + rollerR * 0.6, z + s * laneW / 2);
        o.rotation.set(0, 0, 0);
        o.scale.set(1, 1, 1);
        o.updateMatrix();
        rails.current?.setMatrixAt(ra++, o.matrix);
      }
      for (let p = 0; p < legPairs; p++) {
        const x = -w / 2 + (p + 0.5) * (w / legPairs);
        for (const s of [-1, 1]) {
          o.position.set(x, legH / 2, z + s * laneW * 0.42);
          o.rotation.set(0, 0, 0);
          o.scale.set(1, 1, 1);
          o.updateMatrix();
          legs.current?.setMatrixAt(lg++, o.matrix);
        }
      }
    }
    for (const m of [rollers.current, rails.current, legs.current]) {
      if (m) m.instanceMatrix.needsUpdate = true;
    }
  }, [w, d, lanes, sgLanes, gap, pitch, laneW, rollerR, deckY, perLane, legPairs]);

  return (
    <>
      <instancedMesh ref={rollers} args={[undefined, undefined, lanes * perLane]} material={mats.roller} frustumCulled={false}>
        <cylinderGeometry args={[rollerR, rollerR, laneW, 8]} />
      </instancedMesh>
      <instancedMesh ref={rails} args={[undefined, undefined, lanes * 2]} material={mats.rail} frustumCulled={false}>
        <boxGeometry args={[w, rollerR * 1.7, 0.05]} />
      </instancedMesh>
      <instancedMesh ref={legs} args={[undefined, undefined, lanes * legPairs * 2]} material={mats.leg} frustumCulled={false}>
        <boxGeometry args={[0.07, legH, 0.07]} />
      </instancedMesh>
    </>
  );
}

// ── Instanced Pit-Stop rendering ──────────────────────────────────────────────
// Slabs, base plates and warning cones for ALL stacks render as a handful of
// InstancedMesh buckets (one per material/colour) instead of one mesh per box —
// ~700 draw calls → ~20 with 117 OFs. Each stack keeps its own invisible hit
// volume (hover/click), name chip and selection outline.

/** Everything the per-OF interaction layer needs, precomputed with the matrices. */
interface StackLayout {
  of: PitStopOf;
  x: number;
  z: number;
  fw: number;
  fd: number;
  top: number;
  late: boolean;
  plateColor: string;
}

/** Fixed-capacity instanced boxes: one bucket = one material. */
function InstancedBoxes({ material, matrices, geometry }: { material: THREE.Material; matrices: THREE.Matrix4[]; geometry?: THREE.BufferGeometry }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    matrices.forEach((mat, i) => m.setMatrixAt(i, mat));
    m.count = matrices.length;
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [matrices]);
  return <instancedMesh ref={ref} args={[geometry ?? unitBoxGeo, material, Math.max(matrices.length, 1)]} castShadow />;
}

// Cone parts (shared geometries/materials — every cone is identical, only placed).
const coneBodyGeo = new THREE.ConeGeometry(0.3, 0.8, 20);
const coneBand1Geo = new THREE.CylinderGeometry(0.3 * (1 - 0.38 / 0.8) * 1.07, 0.3 * (1 - 0.24 / 0.8) * 1.07, 0.14, 18);
const coneBand2Geo = new THREE.CylinderGeometry(0.3 * (1 - 0.6 / 0.8) * 1.07, 0.3 * (1 - 0.5 / 0.8) * 1.07, 0.1, 18);
const coneOrangeMat = new THREE.MeshStandardMaterial({ color: '#f97316', roughness: 0.5, emissive: '#f97316', emissiveIntensity: 0.28 });
const coneWhiteMat = new THREE.MeshStandardMaterial({ color: '#f8fafc', roughness: 0.45 });

/** All late/due-today cones as 4 instanced meshes inside ONE bobbing group —
 * the bob phase is shared (as it always was), so a single group.position.y
 * animation moves every cone without touching a matrix per frame. */
function InstancedCones({ stacks }: { stacks: StackLayout[] }) {
  const grp = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (grp.current) grp.current.position.y = Math.sin(state.clock.elapsedTime * 2.2) * 0.07;
  });
  const parts = useMemo(() => {
    const o = new THREE.Object3D();
    const base: THREE.Matrix4[] = [], body: THREE.Matrix4[] = [], b1: THREE.Matrix4[] = [], b2: THREE.Matrix4[] = [];
    for (const s of stacks) {
      const y = s.top + 0.06;
      o.rotation.set(0, 0, 0); o.scale.set(0.56, 0.06, 0.56);
      o.position.set(s.x, y + 0.03, s.z); o.updateMatrix(); base.push(o.matrix.clone());
      o.scale.set(1, 1, 1);
      o.position.set(s.x, y + 0.06 + 0.4, s.z); o.updateMatrix(); body.push(o.matrix.clone());
      o.position.set(s.x, y + 0.06 + 0.31, s.z); o.updateMatrix(); b1.push(o.matrix.clone());
      o.position.set(s.x, y + 0.06 + 0.55, s.z); o.updateMatrix(); b2.push(o.matrix.clone());
    }
    return { base, body, b1, b2 };
  }, [stacks]);
  if (!stacks.length) return null;
  return (
    <group ref={grp}>
      <InstancedBoxes material={coneOrangeMat} matrices={parts.base} />
      <InstancedBoxes material={coneOrangeMat} matrices={parts.body} geometry={coneBodyGeo} />
      <InstancedBoxes material={coneWhiteMat} matrices={parts.b1} geometry={coneBand1Geo} />
      <InstancedBoxes material={coneWhiteMat} matrices={parts.b2} geometry={coneBand2Geo} />
    </group>
  );
}

/** Per-OF interaction layer: invisible hover/click volume, hover/selected chip,
 * selection outline on the (instanced) base plate. The visible boxes live in
 * the instanced buckets built by PitStopMesh. */
function PitStopStack({ s, deckY, onSelectOf, selected }: {
  s: StackLayout; deckY: number; onSelectOf?: (id: string) => void; selected: boolean;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);
  const { of, fw, fd, top } = s;
  return (
    <group position={[s.x, 0, s.z]}>
      {/* single hover/click volume over the whole stack */}
      <mesh
        position={[0, deckY + (top - deckY) / 2 + 0.05, 0]}
        onClick={(e) => { e.stopPropagation(); onSelectOf?.(of.job_order_id); }}
        onPointerOver={(e) => { e.stopPropagation(); setHover(true); document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { setHover(false); document.body.style.cursor = 'default'; }}
      >
        <boxGeometry args={[fw * 1.2, Math.max(top - deckY, 0.3) + 0.15, fd * 1.2]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {selected && (
        <mesh position={[0, deckY + 0.02, 0]}>
          <boxGeometry args={[fw * 1.14, 0.07, fd * 1.14]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          <Edges color="#ffffff" />
        </mesh>
      )}
      {(hover || selected) && (
        <Html position={[0, top + (s.late ? 1.5 : 0.7), 0]} center zIndexRange={[35, 0]} style={{ pointerEvents: 'none' }}>
          <div style={{
            background: 'rgba(13,20,33,0.94)', border: `1.5px solid ${s.plateColor}`, color: '#e5e7eb',
            borderRadius: 8, padding: '3px 9px', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
            fontFamily: 'system-ui, sans-serif', textAlign: 'center',
          }}>
            {of.job_number}
            <span style={{ marginLeft: 6, color: '#94a3b8', fontWeight: 600 }}>
              {of.completeness_pct != null ? `${Math.round(of.completeness_pct)} %` : t('pitStop.noBom')}
            </span>
          </div>
        </Html>
      )}
    </group>
  );
}

/** Floating header naming one physical buffer area (Case goods / Soft goods),
 * bordered in the family accent. Html so it stays legible offline (troika fails). */
function PitAreaLabel({ z, text, accent }: { z: number; text: string; accent: string }) {
  return (
    <Html position={[0, 3.0, z]} center distanceFactor={20} zIndexRange={[22, 0]} style={{ pointerEvents: 'none' }}>
      <div style={{
        fontSize: 11, fontWeight: 800, letterSpacing: '0.6px', textTransform: 'uppercase',
        color: '#e5e7eb', background: 'rgba(13,20,33,0.82)', border: `1.5px solid ${accent}`,
        padding: '2px 8px', borderRadius: 5, whiteSpace: 'nowrap', transform: 'translateY(-50%)',
      }}>{text}</div>
    </Html>
  );
}

/** Scoreboard at the zone's exit corner (same construction language as the
 * line TVs): the client's Feuil1 KPI table verbatim — EU total / EU pit /
 * Dispo sur ligne / Assigné non disponible / Attente quincaillerie / the two
 * availability bands (with OTIF % + CG OF count) / Attente réparation, all
 * split CG | SG in availability-weighted EU. Canvas texture — troika fonts
 * fail offline in this app. */
const OTIF_ZERO = { cg_eu: 0, sg_eu: 0, otif_pct: null, cg_ofs: 0 } as const;
const PAIR_ZERO = { cg: 0, sg: 0 } as const;

function PitStopBoard({ x, kpis, mats }: { x: number; kpis: PitStopState['kpis']; mats: PitMats }) {
  const { t } = useTranslation();
  const title = t('pitStop.board.title');
  const lCg = t('pitStop.board.cg'), lSg = t('pitStop.board.sg');
  const lOtif = t('pitStop.board.otif'), lOfCg = t('pitStop.board.ofCg');
  const lEuFull = t('pitStop.board.euFull'), lEuGe90 = t('pitStop.board.euGe90');
  const lEuTotal = t('pitStop.board.euTotal'), lEuPit = t('pitStop.board.euPit');
  const lOnLine = t('pitStop.board.onLine'), lAssigned = t('pitStop.board.assignedUnavailable');
  const lHardware = t('pitStop.board.awaitingHardware'), lRepair = t('pitStop.board.awaitingRepair');
  // tolerate a state served by an older backend (no otif/board block yet)
  const bFull = kpis.otif?.full ?? OTIF_ZERO;
  const bGe90 = kpis.otif?.ge90 ?? OTIF_ZERO;
  const board = kpis.board;
  const p = (k: keyof NonNullable<PitStopState['kpis']['board']>) => board?.[k] ?? PAIR_ZERO;
  const boardKey = JSON.stringify(board ?? null);
  const tex = useMemo(() => {
    const W = 1024, H = 680, HEAD = 76, PAD = 12;
    const cvs = document.createElement('canvas');
    cvs.width = W; cvs.height = H;
    const ctx = cvs.getContext('2d')!;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#0b1120';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#1e2740';
    ctx.fillRect(0, 0, W, HEAD);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 42px system-ui, sans-serif';
    ctx.fillText(title, W / 2, HEAD / 2 + 2, W - 40);

    // ── the client's KPI table: label | CG | SG | OTIF | OF CG ──────────────
    const colX = [PAD, 470, 606, 742, 878, W - PAD];
    const colC = (i: number) => (colX[i] + colX[i + 1]) / 2;
    const headY = HEAD + PAD, headH = 46;
    ctx.fillStyle = '#1e2740';
    ctx.fillRect(PAD, headY, W - 2 * PAD, headH);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '700 27px system-ui, sans-serif';
    [lCg, lSg, lOtif, lOfCg].forEach((h, i) => ctx.fillText(h, colC(i + 1), headY + headH / 2 + 2, colX[i + 2] - colX[i + 1] - 16));
    const otifColor = (pct: number | null) =>
      pct == null ? '#64748b' : pct >= 90 ? '#16a34a' : pct >= 70 ? '#eab308' : '#fb923c';
    const GAP = 6;
    const rh = (H - (headY + headH) - PAD * 2 - GAP * 7) / 8;
    let ry = headY + headH + PAD;
    const row = (label: string, cells: [string, string][], emphasis = false) => {
      ctx.fillStyle = emphasis ? '#16213a' : '#111a2c';
      ctx.fillRect(PAD, ry, W - 2 * PAD, rh);
      ctx.fillStyle = emphasis ? '#e2e8f0' : '#94a3b8';
      ctx.font = `${emphasis ? 700 : 600} 26px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillText(label, colX[0] + 14, ry + rh / 2 + 2, colX[1] - colX[0] - 24);
      ctx.textAlign = 'center';
      ctx.font = '800 38px system-ui, sans-serif';
      cells.forEach(([v, c], i) => {
        ctx.fillStyle = c;
        ctx.fillText(v, colC(i + 1), ry + rh / 2 + 2, colX[i + 2] - colX[i + 1] - 16);
      });
      ry += rh + GAP;
    };
    const eu = (pr: { cg: number; sg: number }, emphasis = false): [string, string][] => [
      [String(pr.cg), emphasis ? '#ffffff' : '#e2e8f0'],
      [String(pr.sg), emphasis ? '#ffffff' : '#e2e8f0'],
    ];
    const bandCells = (b: typeof bFull): [string, string][] => [
      [String(b.cg_eu), '#ffffff'],
      [String(b.sg_eu), '#ffffff'],
      [b.otif_pct != null ? `${b.otif_pct} %` : '—', otifColor(b.otif_pct)],
      [String(b.cg_ofs), '#ffffff'],
    ];
    row(lEuTotal, eu(p('eu_total'), true), true);
    row(lEuPit, eu(p('eu_pit')));
    row(lOnLine, eu(p('on_line')));
    row(lAssigned, eu(p('assigned_unavailable')));
    row(lHardware, eu(p('awaiting_hardware')));
    row(lEuFull, bandCells(bFull), true);
    row(lEuGe90, bandCells(bGe90), true);
    row(lRepair, eu(p('awaiting_repair')));
    const texture = new THREE.CanvasTexture(cvs);
    texture.anisotropy = 8;
    return texture;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, lCg, lSg, lOtif, lOfCg, lEuFull, lEuGe90,
      lEuTotal, lEuPit, lOnLine, lAssigned, lHardware, lRepair, boardKey,
      bFull.cg_eu, bFull.sg_eu, bFull.otif_pct, bFull.cg_ofs,
      bGe90.cg_eu, bGe90.sg_eu, bGe90.otif_pct, bGe90.cg_ofs]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <group position={[x, 0, 0]} rotation={[0, -Math.PI / 2, 0]}>
      <mesh material={mats.leg} position={[0, 0.06, 0]}>
        <cylinderGeometry args={[0.5, 0.6, 0.12, 12]} />
      </mesh>
      <mesh material={mats.roller} position={[0, 0.05 + 2.0, 0]} castShadow>
        <cylinderGeometry args={[0.09, 0.09, 4.0, 10]} />
      </mesh>
      <mesh material={mats.rail} position={[0, 5.1, 0]} castShadow>
        <boxGeometry args={[6.0, 4.1, 0.16]} />
      </mesh>
      <mesh position={[0, 5.1, 0.085]}>
        <planeGeometry args={[5.7, 3.78]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Structure-wide shared materials (a handful of instances, disposed on unmount). */
function usePitMats() {
  const mats = useMemo(() => ({
    slab:      new THREE.MeshStandardMaterial({ color: '#141b29', roughness: 0.92 }),
    sgFloor:   new THREE.MeshStandardMaterial({ color: '#191a2e', roughness: 0.92 }),  // faint violet tint → soft-goods area
    divider:   new THREE.MeshStandardMaterial({ color: '#4b5a72', roughness: 0.6, emissive: '#2a3550', emissiveIntensity: 0.25 }),
    roller:    new THREE.MeshStandardMaterial({ color: '#9aa3ad', metalness: 0.6, roughness: 0.4 }),
    rail:      new THREE.MeshStandardMaterial({ color: '#2b3648', roughness: 0.7 }),
    leg:       new THREE.MeshStandardMaterial({ color: '#1f2937', roughness: 0.75 }),
    cancelled: new THREE.MeshStandardMaterial({ color: '#3a4354', roughness: 0.9, transparent: true, opacity: 0.65 }),
  }), []);
  useEffect(() => () => { Object.values(mats).forEach((m) => m.dispose()); }, [mats]);
  return mats;
}
type PitMats = ReturnType<typeof usePitMats>;

function PitStopMesh({ w, d, id, name, onSelect }: Omit<BoxProps, 'h' | 'color'>) {
  const { t } = useTranslation();
  const { state, onSelectOf, selectedOfId } = useContext(PitStopCtx);
  const mats = usePitMats();
  const lanes = state?.config.lanes ?? PIT_DEFAULTS.lanes;
  const slots = state?.config.slots_per_lane ?? PIT_DEFAULTS.slots_per_lane;
  // Physical CG/SG split: the FIRST `sgLanes` lanes form the (smaller) soft-goods
  // area, separated from the case-goods area by a visible aisle (`gap`). Lanes are
  // compressed slightly so the whole field still fits the zone footprint `d`.
  const sgLanes = Math.min(Math.max(state?.config.sg_lanes ?? PIT_DEFAULTS.sg_lanes, 0), lanes - 1);
  const cgLanes = lanes - sgLanes;
  const gap = sgLanes > 0 ? (d / lanes) * 1.8 : 0;
  const pitch = (d - gap) / lanes;
  const laneW = Math.min(pitch * 0.78, 1.15);
  const rollerR = Math.max(0.03, Math.min(pitch * 0.16, 0.07));
  const deckY = 0.5 + rollerR * 2;                    // stack resting height (top of rollers)
  const slotW = w / slots;
  // 1-based lane → z. Soft goods take the FIRST `sgLanes` lanes (left of the
  // aisle), case goods the rest — so the small SG area sits before the CG field.
  const laneZ = (lane: number) => -d / 2 + (lane - 0.5) * pitch + (lane > sgLanes ? gap : 0);
  const cgDepth = cgLanes * pitch;
  const sgDepth = sgLanes * pitch;
  const sgCenterZ = -d / 2 + sgDepth / 2;
  const cgCenterZ = d / 2 - cgDepth / 2;
  const dividerZ = -d / 2 + sgDepth + gap / 2;

  // Category name → shared material (from the plant's registry colours).
  const categoryMats = useMemo(() => {
    const map = new Map<string, THREE.MeshStandardMaterial>();
    for (const c of state?.categories ?? []) {
      map.set(c.name, new THREE.MeshStandardMaterial({ color: c.color, roughness: 0.8 }));
    }
    map.set('', new THREE.MeshStandardMaterial({ color: OF_CATEGORY_FALLBACK, roughness: 0.8 }));
    return map;
  }, [state?.categories]);
  useEffect(() => () => { categoryMats.forEach((m) => m.dispose()); }, [categoryMats]);
  const categoryMat = (category: string | null) => categoryMats.get(category ?? '') ?? categoryMats.get('')!;

  // Place each OF at its primary (most recent) parsed position; unknown/absent
  // codes fall back to a strip along the entry edge. OFs sharing a cell (two
  // pallets in one bin — real in SAP data) split the slot into side-by-side
  // berths, each stack shrinking to its berth, so stacks never interpenetrate.
  const placed = useMemo(() => {
    const out: { of: PitStopOf; x: number; z: number; berthW: number }[] = [];
    const cells = new Map<string, PitStopOf[]>();
    const strip: PitStopOf[] = [];
    for (const of of state?.ofs ?? []) {
      const primary = of.positions.find((p) => p.lane != null && p.slot != null);
      if (primary) {
        // group by the CLAMPED cell — out-of-range codes land on the same spot
        const lane = Math.min(Math.max(primary.lane!, 1), lanes);
        const slot = Math.min(Math.max(primary.slot!, 1), slots);
        const key = `${lane}-${slot}`;
        const g = cells.get(key);
        if (g) g.push(of); else cells.set(key, [of]);
      } else {
        strip.push(of);
      }
    }
    for (const [key, group] of cells) {
      const [lane, slot] = key.split('-').map(Number);            // already clamped in the key
      const cx = -w / 2 + (slot - 0.5) * slotW;
      const z = laneZ(lane);
      if (group.length > 1) group.sort((a, b) => a.job_number.localeCompare(b.job_number));
      const berthW = slotW / group.length;
      group.forEach((of, i) => {
        out.push({ of, x: cx - slotW / 2 + (i + 0.5) * berthW, z, berthW });
      });
    }
    strip.forEach((of, i) => {
      out.push({ of, x: -w / 2 - 1.3, z: -d / 2 + 1.0 + i * 1.7, berthW: slotW });
    });
    return out;
  }, [state?.ofs, w, d, lanes, slots, slotW, pitch, sgLanes, gap]);

  // Bake every stack's plate + slabs into per-material instance buckets (the
  // exact same boxes the per-OF meshes used to draw), and keep a StackLayout
  // per OF for the interaction layer.
  const { stacks, slabBuckets, plateBuckets } = useMemo(() => {
    const o = new THREE.Object3D();
    const slabB = new Map<string, THREE.Matrix4[]>();      // key: category name ('' fallback, '\0cancelled')
    const plateB = new Map<string, THREE.Matrix4[]>();     // key: `${color}|${cancelled ? 1 : 0}`
    const outStacks: StackLayout[] = [];
    const push = (m: Map<string, THREE.Matrix4[]>, k: string) => {
      let arr = m.get(k);
      if (!arr) { arr = []; m.set(k, arr); }
      arr.push(o.matrix.clone());
    };
    for (const { of, x, z, berthW } of placed) {
      const fw = Math.min(berthW * 0.72, 1.9);             // slab footprint
      const fd = Math.min(laneW * 1.05, 1.3);
      // deterministic small yaw per slab (stable from job number) → hand-stacked look
      let hsh = 0;
      for (let i = 0; i < of.job_number.length; i++) hsh = (hsh * 31 + of.job_number.charCodeAt(i)) >>> 0;
      const jitter = ((hsh % 100) / 100 - 0.5) * 0.12;
      const layers = of.components.filter((c) => c.on_hand > 0);
      const rawH = layers.map((c) => 0.14 + Math.min(c.on_hand, 60) * 0.012);
      const total = rawH.reduce((a, b) => a + b, 0);
      const k = total > 2.2 ? 2.2 / total : 1;             // cap the pile height
      const cancelled = of.state === 'cancelled';
      // Base plate = completeness semaphore (green 100 % / yellow >90 % / red below).
      const plateColor = ofPlateColor(of.state, of.completeness_pct, of.in_full);
      o.position.set(x, deckY + 0.02, z);
      o.rotation.set(0, 0, 0);
      o.scale.set(fw * 1.14, 0.07, fd * 1.14);
      o.updateMatrix();
      push(plateB, `${plateColor}|${cancelled ? 1 : 0}`);
      let y = deckY + 0.05;
      layers.forEach((c, i) => {
        const hh = rawH[i] * k;
        o.position.set(x, y + hh / 2, z);
        o.rotation.set(0, jitter * (i % 2 ? 1 : -1), 0);
        o.scale.set(fw * (1 - i * 0.03), hh * 0.94, fd * (1 - i * 0.03));
        o.updateMatrix();
        push(slabB, cancelled ? '\0cancelled' : (c.category ?? ''));
        y += hh;
      });
      outStacks.push({
        of, x, z, fw, fd, top: y,
        late: of.late || isDueToday(of.scheduled_date),
        plateColor,
      });
    }
    return { stacks: outStacks, slabBuckets: slabB, plateBuckets: plateB };
  }, [placed, laneW, deckY]);

  // One emissive material per plate colour (few distinct colours; disposed on change).
  const plateMats = useMemo(() => {
    const m = new Map<string, THREE.MeshStandardMaterial>();
    for (const key of plateBuckets.keys()) {
      const [color, flag] = key.split('|');
      m.set(key, new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: 0.25,
        transparent: flag === '1', opacity: flag === '1' ? 0.6 : 1,
      }));
    }
    return m;
  }, [plateBuckets]);
  useEffect(() => () => { plateMats.forEach((m) => m.dispose()); }, [plateMats]);

  return (
    <group {...boxHandlers(id, onSelect)}>
      {/* Two physical areas: the ~5× smaller soft-goods floor FIRST (left), then
          the large case-goods floor, separated by an aisle. Each floor is the click
          target for the zone and is outlined in its family accent (amber CG · violet SG). */}
      <mesh material={mats.slab} position={[0, 0.03, cgCenterZ]} receiveShadow>
        <boxGeometry args={[w + 0.8, 0.06, cgDepth + 0.5]} />
        <Edges color={CG_ACCENT} />
      </mesh>
      {sgLanes > 0 && (
        <>
          <mesh material={mats.sgFloor} position={[0, 0.03, sgCenterZ]} receiveShadow>
            <boxGeometry args={[w + 0.8, 0.06, sgDepth + 0.5]} />
            <Edges color={SG_ACCENT} />
          </mesh>
          {/* divider curb in the aisle between the two areas */}
          <mesh material={mats.divider} position={[0, 0.06, dividerZ]}>
            <boxGeometry args={[w + 0.6, 0.06, 0.14]} />
          </mesh>
        </>
      )}
      <PitStopStructure w={w} d={d} lanes={lanes} sgLanes={sgLanes} gap={gap} pitch={pitch} mats={mats} />
      {/* area headers (only on the full map, where state is polled) */}
      {state && <PitAreaLabel z={cgCenterZ} text={t('pitStop.family.caseGoods')} accent={CG_ACCENT} />}
      {state && sgLanes > 0 && <PitAreaLabel z={sgCenterZ} text={t('pitStop.family.softGoods')} accent={SG_ACCENT} />}
      {/* instanced plates + component slabs (one bucket per material/colour) */}
      {[...plateBuckets.entries()].map(([key, matrices]) => (
        <InstancedBoxes key={`p${key}-${matrices.length}`} material={plateMats.get(key)!} matrices={matrices} />
      ))}
      {[...slabBuckets.entries()].map(([key, matrices]) => (
        <InstancedBoxes key={`s${key}-${matrices.length}`}
          material={key === '\0cancelled' ? mats.cancelled : categoryMat(key || null)} matrices={matrices} />
      ))}
      <InstancedCones stacks={stacks.filter((s) => s.late)} />
      {/* interaction layer — hover/click volume + chip + selection outline per OF */}
      {stacks.map((s) => (
        <PitStopStack key={s.of.job_order_id} s={s} deckY={deckY}
          onSelectOf={onSelectOf} selected={selectedOfId === s.of.job_order_id} />
      ))}
      {state && <PitStopBoard x={w / 2 + 1.6} kpis={state.kpis} mats={mats} />}
      <Label y={3.2} text={name} />
    </group>
  );
}

/** Renders the placeholder shape for a block `kind` (used until a .glb is uploaded). */
function ProceduralShape({ kind, w, d, h, color, id, name, onSelect, animate, status, stopReason, lineStats }: BoxProps & { kind: string; animate?: boolean; status?: string; stopReason?: string | null; lineStats?: LineStats | null }) {
  switch (kind) {
    case 'conveyor': return <ConveyorMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} animate={animate} />;
    case 'assembly_line': return isUpholstery(name)
      ? <UpholsteryCellMesh w={w} d={d} color={color} id={id} name={name} onSelect={onSelect} animate={animate} status={status} stopReason={stopReason} lineStats={lineStats} />
      : <AssemblyLineMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} animate={animate} status={status} stopReason={stopReason} lineStats={lineStats} />;
    case 'lift_table': return <LiftTableMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} />;
    case 'work_table': return <WorkTableMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} />;
    case 'rack': return <RackMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} />;
    case 'dust_collector': return <DustCollectorMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} />;
    case 'beam_saw': return <BeamSawMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} />;
    case 'pit_stop': return <PitStopMesh w={w} d={d} id={id} name={name} onSelect={onSelect} />;
    case 'cobot': return <CobotMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} animate={animate} />;
    default: return <PlainMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} />;
  }
}

export interface P3D {
  id: string;
  kind: string;
  label: string | null;
  model_url: string | null;
  equipment_id: string | null;
  pos_x: number;
  pos_y: number;
  pos_w: number;
  pos_h: number;
  rotation_deg: number | null;
  model_scale: number | null;
  scale_y: number | null;
  scale_z: number | null;
  height_3d: number | null;
  status?: string | null;     // live status of the linked equipment, if any
  role?: string | null;       // conveyor tied to a machine: 'input' | 'output'
  job_number?: string | null; // OF currently loaded on that machine (live via WS)
  queued_ofs?: QueuedOf[] | null;  // OFs parked at that machine's output (oldest first)
  queued_total?: number;           // true parked count (items are capped)
}

export type PropCommit = (id: string, patch: { pos_x: number; pos_y: number; model_scale: number; scale_y: number; scale_z: number; rotation_deg: number }) => void;

/** Compact "3 h 05" / "42 min" for a parked OF's dwell (— when unknown). */
const fmtQueueAge = (m: number | null): string =>
  m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`;

/** Floating chip over a machine-tied conveyor: the OF loaded at that machine
 * right now (Entrée/Sortie prefix from the conveyor's role) plus a +N badge for
 * the OFs PARKED at its output — worked there but not yet scanned at the next
 * step (Perçage after Edge, the buffer after Coupe…). Hovering the chip lists
 * them with how long they've been sitting. Rides the WS status push. */
function ConveyorOfChip({ y, role, jobNumber, queued = [], queuedTotal = 0 }: {
  y: number; role: string | null; jobNumber: string | null;
  queued?: QueuedOf[]; queuedTotal?: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const purple = '#a855f7', amber = '#f59e0b';
  return (
    <Html position={[0, y, 0]} center distanceFactor={16} zIndexRange={[25, 0]}
      style={{ pointerEvents: queuedTotal > 0 ? 'auto' : 'none' }}>
      <div
        onMouseEnter={queuedTotal > 0 ? () => setOpen(true) : undefined}
        onMouseLeave={queuedTotal > 0 ? () => setOpen(false) : undefined}
        style={{ position: 'relative', fontFamily: 'system-ui, sans-serif', cursor: queuedTotal > 0 ? 'default' : undefined }}
      >
        <div style={{
          background: 'rgba(13,20,33,0.92)', border: `1px solid ${purple}`, color: '#e5e7eb',
          borderRadius: 9999, padding: '2px 9px', fontSize: 11, fontWeight: 700,
          whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 5,
        }}>
          {role === 'input' || role === 'output' ? (
            <span style={{ color: '#94a3b8', fontWeight: 600 }}>{t(`factoryMap.role_${role}`)}</span>
          ) : null}
          {jobNumber
            ? <span style={{ fontFamily: 'ui-monospace, monospace', color: '#d8b4fe' }}>OF {jobNumber}</span>
            : <span style={{ color: '#64748b' }}>—</span>}
          {queuedTotal > 0 && (
            <span title={t('factoryMap.queuedOfs')} style={{
              background: `${amber}26`, color: amber, border: `1px solid ${amber}55`,
              borderRadius: 9999, padding: '0 6px', fontSize: 10, fontWeight: 800,
            }}>+{queuedTotal}</span>
          )}
        </div>
        {open && queued.length > 0 && (
          <div style={{
            position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)', marginTop: 4,
            background: 'rgba(13,20,33,0.96)', border: `1px solid ${amber}66`, borderRadius: 8,
            padding: '6px 9px', minWidth: 175, zIndex: 5,
          }}>
            <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5, color: '#94a3b8', marginBottom: 4, whiteSpace: 'nowrap' }}>
              {t('factoryMap.queuedOfs')}
            </div>
            {queued.map((q) => (
              <div key={q.job_number} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 11, lineHeight: 1.6, whiteSpace: 'nowrap' }}>
                <span style={{ fontFamily: 'ui-monospace, monospace', color: '#e5e7eb' }}>{q.job_number}</span>
                <span style={{ color: amber, fontWeight: 700 }}>{fmtQueueAge(q.age_minutes)}</span>
              </div>
            ))}
            {queuedTotal > queued.length && (
              <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>+{queuedTotal - queued.length}…</div>
            )}
          </div>
        )}
      </div>
    </Html>
  );
}

const PropBlock = forwardRef<THREE.Group, { p: P3D; cx: number; cy: number; onSelect: SelectFn; editMode?: boolean; selected?: boolean }>(
  function PropBlock({ p, cx, cy, onSelect, editMode = false, selected = false }, ref) {
    const w = Math.max(p.pos_w, 20) * SCALE;
    const d = Math.max(p.pos_h, 20) * SCALE;
    const h = p.height_3d ?? propHeight(p.kind);
    const x = ((p.pos_x + p.pos_w / 2) - cx) * SCALE;
    const z = ((p.pos_y + p.pos_h / 2) - cy) * SCALE;
    // Linked to a real equipment → reflect its live status (colour + animate when running).
    // Unlinked decorative block → neutral grey and always "on".
    const linked = !!p.equipment_id && !!p.status;
    const color = linked ? (STATUS_COLORS[p.status as string] ?? STATUS_COLORS.idle) : '#64748b';
    const animate = (linked ? p.status === 'running' : true) && !editMode;   // freeze while editing
    const label = p.label ?? p.kind;
    const psx = p.model_scale ?? 1;
    const psy = p.scale_y ?? p.model_scale ?? 1;
    const psz = p.scale_z ?? p.model_scale ?? 1;
    const alert = linked && p.status !== 'running' && p.status !== 'idle';
    const fallback = <ProceduralShape kind={p.kind} w={w} d={d} h={h} color={color} id={p.id} name={label} onSelect={onSelect} animate={animate} />;
    return (
      <group ref={ref} position={[x, 0, z]} rotation={[0, -((p.rotation_deg ?? 0) * Math.PI) / 180, 0]}
        scale={[psx, psy, psz]}>
        {p.model_url ? (
          <Suspense fallback={fallback}>
            <GltfModel url={p.model_url} w={w} d={d} h={h} color={color} id={p.id} name={label} onSelect={onSelect} animate={animate} />
          </Suspense>
        ) : fallback}
        {alert && <AlertBeacon y={h + 1.0 / psy} color={color} parentScale={[psx, psy, psz]} />}
        {/* machine-tied conveyor → the OF loaded there now + parked-OFs badge */}
        {(p.job_number || (p.queued_total ?? 0) > 0) && (
          <ConveyorOfChip y={h + 1.35 / psy} role={p.role ?? null} jobNumber={p.job_number ?? null}
            queued={p.queued_ofs ?? []} queuedTotal={p.queued_total ?? 0} />
        )}
        {selected && <SelectionFootprint w={w} d={d} />}
      </group>
    );
  },
);

const PropBlockMemo = memo(PropBlock);

function SelectedProp({ p, cx, cy, mode, snap, onCommit }: { p: P3D; cx: number; cy: number; mode: TMode; snap: boolean; onCommit: PropCommit }) {
  const [grp, setGrp] = useState<THREE.Group | null>(null);
  const sclamp = (v: number) => Math.max(0.05, Math.round(v * 100) / 100);
  const commit = () => {
    if (!grp) return;
    onCommit(p.id, {
      pos_x: Math.round(grp.position.x / SCALE + cx - p.pos_w / 2),
      pos_y: Math.round(grp.position.z / SCALE + cy - p.pos_h / 2),
      model_scale: sclamp(grp.scale.x),
      scale_y: sclamp(grp.scale.y),
      scale_z: sclamp(grp.scale.z),
      rotation_deg: ((Math.round((-grp.rotation.y * 180) / Math.PI) % 360) + 360) % 360,
    });
  };
  return (
    <>
      <PropBlock ref={setGrp} p={p} cx={cx} cy={cy} onSelect={() => {}} editMode selected />
      {grp && (
        <TransformControls
          object={grp} mode={mode}
          showX={mode === 'translate' || mode === 'scale'}
          showY={mode === 'rotate' || mode === 'scale'}
          showZ={mode === 'translate' || mode === 'scale'}
          translationSnap={snap ? SNAP_TRANSLATE : null}
          rotationSnap={snap ? SNAP_ROTATE : null}
          onMouseUp={commit}
        />
      )}
    </>
  );
}

/** Pulsing beacon floating above a machine that needs attention (stopped / in
 * maintenance / open ticket) — the live "control room" cue. */
// The beacon lives inside the machine/prop group, which may be scaled (model_scale,
// scale_y, scale_z). We counter-scale per axis so the beacon stays a constant world
// size AND undistorted; the caller passes `y = h + gap/scaleY` so the gap above the
// (scaled) top is constant regardless of how tall the block was scaled.
function AlertBeacon({ y, color, parentScale = [1, 1, 1] }: { y: number; color: string; parentScale?: [number, number, number] }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (!ref.current) return;
    const p = 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 4);
    const pulse = 0.85 + p * 0.35;
    const [sx, sy, sz] = parentScale;
    ref.current.scale.set(pulse / (sx || 1), pulse / (sy || 1), pulse / (sz || 1));
  });
  return (
    <group ref={ref} position={[0, y, 0]}>
      <mesh rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[0.45, 0.8, 4]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.4} toneMapped={false} />
      </mesh>
    </group>
  );
}

// A polished cartoon ninja-mechanic mascot standing next to a machine a
// technician is actively working (purple / intervention). Big-head cartoon
// proportions with a strong silhouette so he reads from map distance: orange
// hard hat with navy brim, top ridge and a gear badge, round glasses over a
// friendly face, black balaclava with headband tails, navy suit with crossed
// orange harness straps + chest gear, utility belt with pouches, buckle and a
// screwdriver, dark gloves, knee pads, orange-trimmed work boots, and a big
// wrench. He faces the machine and visibly works on it: torso leaning in, the
// wrench arm extended and cranking back and forth, spark bursts flickering at
// the wrench tip on each stroke, head down on the work point with occasional
// side glances. Per-figure `phase` de-syncs crews so a pair never moves in
// lockstep. Materials are shared (one instance each, disposed on unmount) and
// segment counts stay low so the figure remains cheap to render.
// A 3D speech bubble with the tech's initials floats beside his head; hovering
// shows the technician card (name, elapsed time, ticket) in the same style as
// the machine KPI billboard.
// Built around the origin — the parent <TechCrew> places & sizes it.
function TechFigure3D({
  name, since, ticket, phase = 0,
}: {
  name: string; since?: string | null; ticket?: string | null; phase?: number;
}) {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || 'en').slice(0, 2) as 'en' | 'fr' | 'es';
  const [hover, setHover] = useState(false);
  const armRef = useRef<THREE.Group>(null);      // wrench arm — extended, cranking
  const breatheRef = useRef<THREE.Group>(null);  // upper body — lean-in + breathing
  const headRef = useRef<THREE.Group>(null);     // head — down on the work point
  const sparkRef = useRef<THREE.Group>(null);    // spark burst at the wrench tip
  const bubbleRef = useRef<THREE.Group>(null);   // initials bubble — gentle bob
  useFrame((s) => {
    const tm = s.clock.elapsedTime + phase;
    const stroke = Math.sin(tm * 3.4);           // one crank cycle
    // arm swung forward toward the machine (rot.x ≈ level) and cranking
    // side-to-side (rot.z), with a fast little effort tremble on top
    if (armRef.current) {
      armRef.current.rotation.x = 1.05 + Math.sin(tm * 6.8) * 0.05;
      armRef.current.rotation.z = 0.15 + stroke * 0.4;
    }
    // torso leans into the job and rocks with each stroke, still breathing
    if (breatheRef.current) {
      breatheRef.current.rotation.x = 0.13 + stroke * 0.03;
      breatheRef.current.position.y = Math.sin(tm * 1.6) * 0.012;
    }
    // head tilted down watching the wrench, with slow side glances
    if (headRef.current) {
      headRef.current.rotation.x = 0.22;
      headRef.current.rotation.y = Math.sin(tm * 0.7) * 0.12;
    }
    // sparks pop only near the end of each stroke, flickering fast
    if (sparkRef.current) {
      const on = Math.abs(stroke) > 0.8;
      sparkRef.current.visible = on;
      if (on) {
        sparkRef.current.scale.setScalar(0.7 + 0.5 * Math.abs(Math.sin(tm * 37)));
        sparkRef.current.rotation.z = tm * 9;
      }
    }
    // initials bubble floats gently above the head (clear of the hard hat)
    if (bubbleRef.current) bubbleRef.current.position.y = 2.48 + Math.sin(tm * 1.7) * 0.045;
  });

  const ini = initials(name) || '?';
  const navyDark = '#141c2b';   // shared with the bubble initials + hover card below
  const orange = '#f97316';

  // Initials drawn once onto a canvas → texture on the bubble face. Canvas text
  // works offline with system fonts (drei <Text>/troika font loading fails in
  // this app), stays crisp thanks to the oversized backing canvas.
  const iniTexture = useMemo(() => {
    const cvs = document.createElement('canvas');
    cvs.width = 512; cvs.height = 256;
    const ctx = cvs.getContext('2d')!;
    ctx.font = '900 200px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#141c2b';
    ctx.fillText(ini, 256, 140);
    const tex = new THREE.CanvasTexture(cvs);
    tex.anisotropy = 8;
    return tex;
  }, [ini]);
  useEffect(() => () => iniTexture.dispose(), [iniTexture]);

  // Named materials shared across every mesh of the figure — 10 instances total
  // instead of one per mesh — and disposed when the figure unmounts.
  const mats = useMemo(() => ({
    darkSuitMaterial:     new THREE.MeshStandardMaterial({ color: '#2a3650', roughness: 0.65 }),
    suitShadowMaterial:   new THREE.MeshStandardMaterial({ color: '#161d2e', roughness: 0.7 }),
    orangeAccentMaterial: new THREE.MeshStandardMaterial({ color: '#f97316', roughness: 0.5 }),
    helmetMaterial:       new THREE.MeshStandardMaterial({ color: '#fb8a1d', roughness: 0.35 }),
    helmetTrimMaterial:   new THREE.MeshStandardMaterial({ color: '#1e2740', roughness: 0.5 }),
    metalToolMaterial:    new THREE.MeshStandardMaterial({ color: '#b7bfc9', metalness: 0.8, roughness: 0.25 }),
    skinMaterial:         new THREE.MeshStandardMaterial({ color: '#f2c197', roughness: 0.55 }),
    gloveMaterial:        new THREE.MeshStandardMaterial({ color: '#10151f', roughness: 0.6 }),
    eyeWhiteMaterial:     new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.3 }),
    // glossy white "3D icon" balloon — clearcoat gives the soft specular sheen
    bubbleMaterial:       new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.25, emissive: '#ffffff', emissiveIntensity: 0.12 }),
  }), []);
  useEffect(() => () => { Object.values(mats).forEach((m) => m.dispose()); }, [mats]);

  const el = since ? Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 60000)) : null;
  const elapsed = el == null ? null : el >= 60 ? `${Math.floor(el / 60)} h ${String(el % 60).padStart(2, '0')}` : `${el} min`;
  const sinceStr = since ? new Date(since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;

  const row = (label: string, value: string, dot?: string) => (
    <div style={{ background: '#0d1421', border: '1px solid #1f2937', borderRadius: 6, padding: '4px 8px' }}>
      <div style={{ fontSize: 10, color: '#64748b', lineHeight: 1.15 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
        {dot && <span style={{ width: 9, height: 9, borderRadius: '50%', background: dot, display: 'inline-block', flexShrink: 0 }} />}
        {value}
      </div>
    </div>
  );

  // Small gear badge (hub + 6 teeth + metal pin), reused on helmet and chest.
  const gear = (pos: [number, number, number], tilt = 0, s = 1) => (
    <group position={pos} rotation={[Math.PI / 2 + tilt, 0, 0]} scale={s}>
      <mesh material={mats.helmetTrimMaterial}>
        <cylinderGeometry args={[0.05, 0.05, 0.035, 10]} />
      </mesh>
      {Array.from({ length: 6 }).map((_, i) => {
        const a = (i * Math.PI) / 3;
        return (
          <mesh key={`tooth${i}`} material={mats.helmetTrimMaterial} position={[Math.sin(a) * 0.056, 0, Math.cos(a) * 0.056]}>
            <cylinderGeometry args={[0.013, 0.013, 0.038, 6]} />
          </mesh>
        );
      })}
      <mesh material={mats.metalToolMaterial} position={[0, 0.012, 0]}>
        <cylinderGeometry args={[0.018, 0.018, 0.03, 8]} />
      </mesh>
    </group>
  );

  return (
    <group>
      {/* invisible hover hit-volume covering the whole figure (single target →
          no over/out flicker when the pointer crosses between body parts) */}
      <mesh
        position={[0, 1.05, 0]}
        onPointerOver={(e) => { e.stopPropagation(); setHover(true); document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { setHover(false); document.body.style.cursor = 'default'; }}
        onClick={(e) => e.stopPropagation()}
      >
        <cylinderGeometry args={[0.5, 0.5, 2.2, 10]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* ── static lower body ── */}
      {/* work boots: orange sole, dark body, toe cap, orange lace strap */}
      {[-1, 1].map((k) => (
        <group key={`boot${k}`}>
          <mesh material={mats.orangeAccentMaterial} position={[0.15 * k, 0.028, 0.05]}>
            <boxGeometry args={[0.24, 0.055, 0.42]} />
          </mesh>
          <mesh material={mats.suitShadowMaterial} position={[0.15 * k, 0.135, 0.04]} castShadow>
            <boxGeometry args={[0.21, 0.16, 0.36]} />
          </mesh>
          <mesh material={mats.gloveMaterial} position={[0.15 * k, 0.1, 0.225]}>
            <boxGeometry args={[0.19, 0.09, 0.08]} />
          </mesh>
          <mesh material={mats.orangeAccentMaterial} position={[0.15 * k, 0.2, 0.06]}>
            <boxGeometry args={[0.22, 0.03, 0.3]} />
          </mesh>
        </group>
      ))}
      {/* legs + strapped knee pads */}
      {[-1, 1].map((k) => (
        <group key={`leg${k}`}>
          <mesh material={mats.darkSuitMaterial} position={[0.15 * k, 0.44, 0]} castShadow>
            <cylinderGeometry args={[0.105, 0.125, 0.42, 10]} />
          </mesh>
          <mesh material={mats.suitShadowMaterial} position={[0.15 * k, 0.47, 0.105]} rotation={[-0.1, 0, 0]}>
            <boxGeometry args={[0.15, 0.14, 0.05]} />
          </mesh>
          <mesh material={mats.orangeAccentMaterial} position={[0.15 * k, 0.41, 0.1]}>
            <boxGeometry args={[0.16, 0.03, 0.055]} />
          </mesh>
        </group>
      ))}
      {/* hips + utility belt: orange buckle w/ metal pin, side pouches, screwdriver */}
      <mesh material={mats.darkSuitMaterial} position={[0, 0.72, 0]} castShadow>
        <cylinderGeometry args={[0.27, 0.25, 0.22, 14]} />
      </mesh>
      <mesh material={mats.suitShadowMaterial} position={[0, 0.845, 0]}>
        <cylinderGeometry args={[0.285, 0.285, 0.07, 14]} />
      </mesh>
      <mesh material={mats.orangeAccentMaterial} position={[0, 0.845, 0.27]}>
        <boxGeometry args={[0.13, 0.085, 0.05]} />
      </mesh>
      <mesh material={mats.metalToolMaterial} position={[0, 0.845, 0.285]}>
        <boxGeometry args={[0.045, 0.04, 0.03]} />
      </mesh>
      {[-1, 1].map((k) => (
        <group key={`pouch${k}`} position={[0.255 * k, 0.76, 0.12]} rotation={[0, 0.15 * k, 0]}>
          <mesh material={mats.suitShadowMaterial}>
            <boxGeometry args={[0.11, 0.14, 0.09]} />
          </mesh>
          <mesh material={mats.orangeAccentMaterial} position={[0, 0.065, 0]}>
            <boxGeometry args={[0.115, 0.035, 0.095]} />
          </mesh>
        </group>
      ))}
      <group position={[-0.29, 0.66, 0.1]} rotation={[0, 0, 0.12]}>
        <mesh material={mats.orangeAccentMaterial} position={[0, 0.04, 0]}>
          <cylinderGeometry args={[0.026, 0.026, 0.09, 8]} />
        </mesh>
        <mesh material={mats.metalToolMaterial} position={[0, -0.06, 0]}>
          <cylinderGeometry args={[0.011, 0.011, 0.11, 6]} />
        </mesh>
      </group>

      {/* ── upper body (idle breathing) ── */}
      <group ref={breatheRef}>
        {/* torso + crossed orange harness straps + centre buckle + chest gear */}
        <mesh material={mats.darkSuitMaterial} position={[0, 1.1, 0]} castShadow>
          <capsuleGeometry args={[0.28, 0.36, 6, 14]} />
        </mesh>
        {[-1, 1].map((k) => (
          <mesh key={`strap${k}`} material={mats.orangeAccentMaterial} position={[0, 1.14, 0.285]} rotation={[0, 0, 0.55 * k]}>
            <boxGeometry args={[0.075, 0.6, 0.022]} />
          </mesh>
        ))}
        <mesh material={mats.suitShadowMaterial} position={[0, 1.14, 0.3]}>
          <boxGeometry args={[0.1, 0.07, 0.03]} />
        </mesh>
        {gear([0.17, 1.28, 0.24], 0, 0.72)}
        {/* shoulder pads round out the silhouette */}
        {[-1, 1].map((k) => (
          <mesh key={`shoulder${k}`} material={mats.suitShadowMaterial} position={[0.285 * k, 1.38, 0]} castShadow>
            <sphereGeometry args={[0.105, 12, 12]} />
          </mesh>
        ))}

        {/* right arm — hand confidently on the hip */}
        <mesh material={mats.darkSuitMaterial} position={[0.37, 1.2, 0]} rotation={[0, 0, -0.7]} castShadow>
          <capsuleGeometry args={[0.075, 0.22, 6, 10]} />
        </mesh>
        <mesh material={mats.suitShadowMaterial} position={[0.45, 1.06, 0.01]}>
          <sphereGeometry args={[0.07, 10, 10]} />
        </mesh>
        <mesh material={mats.darkSuitMaterial} position={[0.4, 0.95, 0.05]} rotation={[0, 0, 0.85]} castShadow>
          <capsuleGeometry args={[0.062, 0.16, 6, 10]} />
        </mesh>
        <mesh material={mats.gloveMaterial} position={[0.31, 0.86, 0.09]}>
          <sphereGeometry args={[0.09, 12, 12]} />
        </mesh>

        {/* left arm — holds the big wrench; the resting-up pose below is
            re-posed every frame in useFrame (swung toward the machine, cranking) */}
        <group ref={armRef} position={[-0.32, 1.28, 0]}>
          <mesh material={mats.darkSuitMaterial} position={[-0.06, 0.09, 0.02]} rotation={[0, 0, 0.55]} castShadow>
            <capsuleGeometry args={[0.075, 0.22, 6, 10]} />
          </mesh>
          <mesh material={mats.suitShadowMaterial} position={[-0.13, 0.21, 0.03]}>
            <sphereGeometry args={[0.07, 10, 10]} />
          </mesh>
          <mesh material={mats.darkSuitMaterial} position={[-0.155, 0.33, 0.03]} rotation={[0, 0, 0.08]} castShadow>
            <capsuleGeometry args={[0.062, 0.16, 6, 10]} />
          </mesh>
          <mesh material={mats.gloveMaterial} position={[-0.165, 0.45, 0.03]}>
            <sphereGeometry args={[0.095, 12, 12]} />
          </mesh>
          {/* wrench: orange grip, long metal handle, open-end head */}
          <mesh material={mats.orangeAccentMaterial} position={[-0.165, 0.53, 0.03]}>
            <cylinderGeometry args={[0.036, 0.036, 0.1, 8]} />
          </mesh>
          <mesh material={mats.metalToolMaterial} position={[-0.165, 0.7, 0.03]} castShadow>
            <cylinderGeometry args={[0.03, 0.03, 0.34, 8]} />
          </mesh>
          <mesh material={mats.metalToolMaterial} position={[-0.165, 0.9, 0.03]} rotation={[0, 0, 0.55]} castShadow>
            <torusGeometry args={[0.085, 0.03, 8, 14, Math.PI * 1.45]} />
          </mesh>
          {/* spark burst at the wrench tip — rides with the arm, gated on/off
              per stroke in useFrame; unlit materials so they read as glow */}
          <group ref={sparkRef} position={[-0.165, 0.98, 0.05]} visible={false}>
            {([[0.06, 0.02, 0], [-0.05, 0.06, 0.02], [0.01, -0.05, 0.04]] as const).map((p, i) => (
              <mesh key={`spark${i}`} position={[p[0], p[1], p[2]]}>
                <octahedronGeometry args={[0.038 - i * 0.008, 0]} />
                <meshBasicMaterial color={i === 0 ? '#fff7cc' : '#fbbf24'} toneMapped={false} transparent opacity={0.95} depthWrite={false} />
              </mesh>
            ))}
          </group>
        </group>

        {/* ── head — big cartoon proportions, sways slowly ── */}
        <group ref={headRef} position={[0, 1.53, 0]}>
          {/* balaclava + friendly face: skin patch, eyes, round glasses */}
          <mesh material={mats.suitShadowMaterial} position={[0, 0.02, 0]} castShadow>
            <sphereGeometry args={[0.3, 18, 18]} />
          </mesh>
          <mesh material={mats.skinMaterial} position={[0, 0.06, 0.215]} scale={[1, 0.8, 0.5]}>
            <sphereGeometry args={[0.21, 16, 16]} />
          </mesh>
          {[-1, 1].map((k) => (
            <group key={`eye${k}`}>
              <mesh material={mats.eyeWhiteMaterial} position={[0.088 * k, 0.075, 0.295]} scale={[1, 1.2, 0.55]}>
                <sphereGeometry args={[0.048, 12, 12]} />
              </mesh>
              <mesh material={mats.gloveMaterial} position={[0.082 * k, 0.07, 0.316]}>
                <sphereGeometry args={[0.02, 8, 8]} />
              </mesh>
              <mesh material={mats.helmetTrimMaterial} position={[0.088 * k, 0.075, 0.322]}>
                <torusGeometry args={[0.08, 0.013, 8, 14]} />
              </mesh>
              <mesh material={mats.helmetTrimMaterial} position={[0.19 * k, 0.08, 0.24]} rotation={[0, 1.1 * k, 0]}>
                <boxGeometry args={[0.12, 0.014, 0.014]} />
              </mesh>
            </group>
          ))}
          <mesh material={mats.helmetTrimMaterial} position={[0, 0.095, 0.322]}>
            <boxGeometry args={[0.05, 0.018, 0.016]} />
          </mesh>
          {/* headband knot + tails flying behind */}
          <mesh material={mats.suitShadowMaterial} position={[0, 0.05, -0.29]}>
            <boxGeometry args={[0.11, 0.055, 0.05]} />
          </mesh>
          <mesh material={mats.suitShadowMaterial} position={[0.17, 0, -0.3]} rotation={[0, 0.55, 0.18]}>
            <boxGeometry args={[0.3, 0.05, 0.02]} />
          </mesh>
          <mesh material={mats.suitShadowMaterial} position={[0.1, -0.07, -0.33]} rotation={[0, 0.3, -0.3]}>
            <boxGeometry args={[0.34, 0.045, 0.02]} />
          </mesh>
          {/* orange hard hat: dome, navy top ridge + brim band, gear badge */}
          <mesh material={mats.helmetMaterial} position={[0, 0.21, 0]} scale={[1, 0.68, 1]} castShadow>
            <sphereGeometry args={[0.32, 18, 18]} />
          </mesh>
          <mesh material={mats.helmetTrimMaterial} position={[0, 0.21, 0]} rotation={[0, Math.PI / 2, 0]} scale={[1, 0.68, 1]}>
            <torusGeometry args={[0.32, 0.03, 8, 18, Math.PI]} />
          </mesh>
          <mesh material={mats.helmetTrimMaterial} position={[0, 0.155, 0]}>
            <cylinderGeometry args={[0.34, 0.34, 0.05, 18]} />
          </mesh>
          {gear([0, 0.24, 0.3], -0.3, 1)}
        </group>
      </group>

      {/* 3D speech bubble with the initials straight above the head — glossy
          white "3D icon" style balloon: a squashed sphere with a horn tail
          pointing down at the hard hat, no outline, clearcoat sheen catches
          the sun. Billboard keeps it facing the camera from any orbit angle;
          it bobs gently in useFrame. Anchored slightly forward (+z, toward the
          machine) because the working torso leans in — the head ends up ~0.2
          ahead of the hip axis, and without the offset the balloon reads as
          floating behind the head. */}
      <group ref={bubbleRef} position={[0, 2.48, 0.22]}>
        <Billboard>
          <mesh material={mats.bubbleMaterial} scale={[1, 0.8, 0.85]}>
            <sphereGeometry args={[0.36, 24, 18]} />
          </mesh>
          {/* horn tail — base buried in the balloon, apex flaring down toward
              the head; z-flattened so the tilted base disc stays inside */}
          <mesh material={mats.bubbleMaterial} position={[-0.12, -0.27, 0]} rotation={[0, 0, 2.95]} scale={[1, 1, 0.6]}>
            <coneGeometry args={[0.09, 0.3, 12]} />
          </mesh>
          <mesh position={[0, 0, 0.312]}>
            <planeGeometry args={[0.48, 0.24]} />
            <meshBasicMaterial map={iniTexture} transparent toneMapped={false} depthWrite={false} />
          </mesh>
        </Billboard>
      </group>

      {/* hover card — the technician's data, like the machine KPI billboard */}
      {hover && (
        <Html position={[0, 3.05, 0]} center zIndexRange={[50, 0]} style={{ pointerEvents: 'none' }}>
          <div style={{ width: 210, background: 'rgba(13,20,33,0.95)', border: `1.5px solid ${STATUS_COLORS.intervention}`, borderRadius: 10, padding: 10, color: '#e5e7eb', boxShadow: '0 6px 20px rgba(0,0,0,0.55)', fontFamily: 'system-ui, sans-serif' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ width: 26, height: 26, borderRadius: '50%', background: orange, color: navyDark, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 11, flexShrink: 0 }}>{ini}</span>
              <span style={{ fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
            </div>
            <div style={{ display: 'grid', gap: 5 }}>
              {row(t('common.status'), STATUS_LABELS.intervention?.[lang] ?? 'Intervention', STATUS_COLORS.intervention)}
              {sinceStr ? row(t('factoryMap.workingSince'), elapsed ? `${sinceStr} (${elapsed})` : sinceStr) : null}
              {ticket ? row(t('factoryMap.openTicket'), ticket) : null}
            </div>
          </div>
        </Html>
      )}
    </group>
  );
}

// Places ONE ninja-mechanic per technician on the clock, lined up along the
// front edge of the machine and centred, so 2 techs → 2 figures, 10 → 10.
// Each figure is turned ~180° (with a small per-index variation so a row does
// not look cloned) to face the machine it is working on, and gets a distinct
// animation phase so crews never crank in lockstep.
// Counter-scales the parent machine's scale ONCE here (figures then keep a
// constant human size and a constant world spacing regardless of machine scale).
function TechCrew({
  techs, ticket, w, d, parentScale = [1, 1, 1],
}: {
  techs: MapTechnician[]; ticket?: string | null;
  w: number; d: number; parentScale?: [number, number, number];
}) {
  const [sx, sy, sz] = parentScale;
  const SPACING = 1.3;                       // world units between neighbours
  const n = techs.length;
  const rowW = (n - 1) * SPACING;
  // Front edge of the footprint, on the floor. Nudge further out for bigger rows
  // so a long line still clears the machine body.
  const pz = d / 2 + 0.9 + Math.min(rowW * 0.12, 1.5);
  return (
    <group position={[0, 0, pz]} scale={[1 / (sx || 1), 1 / (sy || 1), 1 / (sz || 1)]}>
      {techs.map((tech, i) => (
        <group key={`${tech.name}-${i}`} position={[(i - (n - 1) / 2) * SPACING, 0, 0]}
          rotation={[0, Math.PI + (i % 2 ? 0.14 : -0.14), 0]}>
          <TechFigure3D name={tech.name} since={tech.since} ticket={ticket} phase={i * 1.7} />
        </group>
      ))}
    </group>
  );
}

/** The PLANNED pipeline stacked BEHIND a machine: OFs production planning has
 * queued for it (pending, not yet scanned). A pallet of raw wood panels whose
 * height grows with the queue depth — the cutting saws (Coupe) have no input
 * conveyor, this stack IS their inbox. The top panel (next OF to cut) is tinted;
 * an indigo "Pipeline · N" card names the next OF and hover lists the plan with
 * scheduled dates (late red, due-today amber). Counter-scales the machine's
 * scale so panels + card keep a constant real size. */
function MachinePipeline({ ofs, total, d, parentScale = [1, 1, 1] }: {
  ofs: PipelineOf[]; total: number; d: number; parentScale?: [number, number, number];
}) {
  const { t } = useTranslation();
  const [sx, sy, sz] = parentScale;
  const [open, setOpen] = useState(false);
  const indigo = '#818cf8', amber = '#f59e0b', red = '#f87171';
  const mats = useMemo(() => ({
    pallet: new THREE.MeshStandardMaterial({ color: '#4a3b28', roughness: 0.85 }),
    wood:   new THREE.MeshStandardMaterial({ color: '#c8a46a', roughness: 0.8 }),
    woodDk: new THREE.MeshStandardMaterial({ color: '#a9854e', roughness: 0.82 }),
    next:   new THREE.MeshStandardMaterial({ color: '#efd9a6', roughness: 0.65, emissive: '#e7c98a', emissiveIntensity: 0.18 }),
  }), []);
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);

  const next = ofs[0];
  const N = Math.max(1, Math.min(total, 12));      // panels drawn (cap keeps it tidy)
  const pw = 1.6, pd = 1.0, slab = 0.085, gap = 0.03;
  const palletH = 0.14;
  const jit = (i: number) => (((i * 71) % 13) / 13 - 0.5) * 0.06;   // stable per-index wobble
  const panels = Array.from({ length: N });
  const topY = palletH + N * (slab + gap);

  return (
    <group position={[0, 0, -(d / 2 + pd / 2 + 0.5)]}
      scale={[1 / (sx || 1), 1 / (sy || 1), 1 / (sz || 1)]}>
      {/* pallet */}
      <mesh material={mats.pallet} position={[0, palletH / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[pw + 0.15, palletH, pd + 0.15]} />
      </mesh>
      {/* stacked raw panels — top one (next OF) tinted */}
      {panels.map((_, i) => (
        <mesh key={i} material={i === N - 1 ? mats.next : (i % 2 ? mats.woodDk : mats.wood)}
          position={[jit(i), palletH + slab / 2 + i * (slab + gap), jit(i + 3)]}
          rotation={[0, jit(i) * 0.5, 0]} castShadow>
          <boxGeometry args={[pw, slab, pd]} />
        </mesh>
      ))}
      {/* indigo planning card — count + next OF; hover → the ordered plan */}
      <Html position={[0, topY + 0.55, 0]} center distanceFactor={16} zIndexRange={[24, 0]}
        style={{ pointerEvents: 'auto' }}>
        <div onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
          style={{ position: 'relative', fontFamily: 'system-ui, sans-serif' }}>
          <div style={{
            background: 'rgba(13,20,33,0.92)', border: `1px solid ${indigo}`, color: '#e5e7eb',
            borderRadius: 7, padding: '2px 9px', fontSize: 11, fontWeight: 700,
            whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 5,
          }}>
            <span style={{ color: '#a5b4fc', fontWeight: 700 }}>{t('factoryMap.pipeline')}</span>
            <span style={{ background: `${indigo}26`, color: '#c7d2fe', border: `1px solid ${indigo}55`, borderRadius: 9999, padding: '0 6px', fontSize: 10, fontWeight: 800 }}>{total}</span>
            {next && <span style={{ fontFamily: 'ui-monospace, monospace', color: '#cbd5e1' }}>▶ {next.job_number}</span>}
          </div>
          {open && ofs.length > 0 && (
            <div style={{
              position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: 4,
              background: 'rgba(13,20,33,0.96)', border: `1px solid ${indigo}66`, borderRadius: 8,
              padding: '6px 9px', minWidth: 200, zIndex: 5,
            }}>
              <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5, color: '#94a3b8', marginBottom: 4, whiteSpace: 'nowrap' }}>
                {t('factoryMap.pipelineNext')}
              </div>
              {ofs.map((q, i) => (
                <div key={q.job_number} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 11, lineHeight: 1.6, whiteSpace: 'nowrap' }}>
                  <span style={{ fontFamily: 'ui-monospace, monospace', color: i === 0 ? '#e7c98a' : '#e5e7eb' }}>
                    {i === 0 ? '▶ ' : ''}{q.job_number}
                  </span>
                  <span style={{ color: q.late ? red : q.due_today ? amber : '#94a3b8', fontWeight: q.late || q.due_today ? 700 : 400 }}>
                    {q.scheduled_date ?? '—'}
                  </span>
                </div>
              ))}
              {total > ofs.length && <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>+{total - ofs.length}…</div>}
            </div>
          )}
        </div>
      </Html>
    </group>
  );
}

/** Blue footprint rectangle on the floor under the selected item — lives INSIDE
 * the item's group so it rides along live while the gizmo drags. */
function SelectionFootprint({ w, d }: { w: number; d: number }) {
  const pts = useMemo(() => [
    [-w / 2, 0, -d / 2], [w / 2, 0, -d / 2], [w / 2, 0, d / 2], [-w / 2, 0, d / 2], [-w / 2, 0, -d / 2],
  ] as [number, number, number][], [w, d]);
  return (
    <group position={[0, 0.05, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w, d]} />
        <meshBasicMaterial color="#3b82f6" transparent opacity={0.10} depthWrite={false} />
      </mesh>
      <Line points={pts} color="#60a5fa" lineWidth={1.5} />
    </group>
  );
}

/** Click-to-place: an invisible ground catcher moves a translucent ghost of the
 * item under the cursor; a real click (not an orbit drag) places it at that map
 * position. Snapping rounds to the same 10 px grid as the gizmo. Esc cancels
 * (handled by the page's hotkeys — this component only reports placement). */
function GhostPlacement({ cx, cy, spec, snap, onPlace }: {
  cx: number; cy: number; spec: PlacementSpec; snap: boolean;
  onPlace: (posX: number, posY: number) => void;
}) {
  const ghost = useRef<THREE.Group>(null);
  const [visible, setVisible] = useState(false);
  const w = Math.max(spec.w, 20) * SCALE;
  const d = Math.max(spec.h, 20) * SCALE;
  const h = spec.height;

  const toMapPos = (pt: THREE.Vector3): { x: number; y: number } => {
    let x = Math.round(pt.x / SCALE + cx - spec.w / 2);
    let y = Math.round(pt.z / SCALE + cy - spec.h / 2);
    if (snap) { x = Math.round(x / SNAP_PX) * SNAP_PX; y = Math.round(y / SNAP_PX) * SNAP_PX; }
    return { x, y };
  };

  const moveGhost = (e: ThreeEvent<PointerEvent>) => {
    if (!ghost.current) return;
    const { x, y } = toMapPos(e.point);
    ghost.current.position.set((x + spec.w / 2 - cx) * SCALE, 0, (y + spec.h / 2 - cy) * SCALE);
    if (!visible) setVisible(true);
  };

  useEffect(() => {
    document.body.style.cursor = 'crosshair';
    return () => { document.body.style.cursor = 'default'; };
  }, []);

  return (
    <>
      {/* ground catcher — present only while placing, so no raycast cost otherwise */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]}
        onPointerMove={moveGhost}
        onClick={(e) => {
          if (e.delta > 5) return;                    // orbit drag, not a click
          e.stopPropagation();
          const { x, y } = toMapPos(e.point);
          onPlace(x, y);
        }}
      >
        <planeGeometry args={[2400, 2400]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <group ref={ghost} visible={visible}>
        <mesh position={[0, h / 2, 0]}>
          <boxGeometry args={[w, h, d]} />
          <meshStandardMaterial color="#818cf8" transparent opacity={0.35} depthWrite={false} />
        </mesh>
        <Edges scale={1.001} color="#a5b4fc">
          <boxGeometry args={[w, h, d]} />
        </Edges>
        <SelectionFootprint w={w} d={d} />
        <Html position={[0, h + 0.7, 0]} center zIndexRange={[45, 0]} style={{ pointerEvents: 'none' }}>
          <div style={{
            background: 'rgba(13,20,33,0.92)', border: '1px solid #818cf8', color: '#c7d2fe',
            borderRadius: 8, padding: '2px 9px', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
            fontFamily: 'system-ui, sans-serif',
          }}>{spec.label}</div>
        </Html>
      </group>
    </>
  );
}

/** A zone drawn flat on the 3D floor (edit mode): tinted area + outline + name
 * chip. Click selects it; the gizmo then moves/resizes it like any block. */
const Zone3DBlock = forwardRef<THREE.Group, { z: Z3D; cx: number; cy: number; onSelect?: (id: string) => void; selected?: boolean }>(
  function Zone3DBlock({ z, cx, cy, onSelect, selected = false }, ref) {
    const w = Math.max(z.pos_w, 40) * SCALE;
    const d = Math.max(z.pos_h, 40) * SCALE;
    const x = ((z.pos_x + z.pos_w / 2) - cx) * SCALE;
    const zz = ((z.pos_y + z.pos_h / 2) - cy) * SCALE;
    const pts = useMemo(() => [
      [-w / 2, 0, -d / 2], [w / 2, 0, -d / 2], [w / 2, 0, d / 2], [-w / 2, 0, d / 2], [-w / 2, 0, -d / 2],
    ] as [number, number, number][], [w, d]);
    return (
      <group ref={ref} position={[x, 0, zz]}>
        <mesh
          rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, 0]}
          onClick={onSelect ? (e) => { e.stopPropagation(); onSelect(z.id); } : undefined}
          onPointerOver={onSelect ? (e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; } : undefined}
          onPointerOut={onSelect ? () => { document.body.style.cursor = 'default'; } : undefined}
        >
          <planeGeometry args={[w, d]} />
          <meshBasicMaterial color={z.color} transparent opacity={selected ? 0.22 : 0.10} depthWrite={false} />
        </mesh>
        <group position={[0, 0.03, 0]}>
          <Line points={pts} color={z.color} lineWidth={selected ? 2 : 1} dashed dashSize={0.6} gapSize={0.35} />
        </group>
        <Html position={[-w / 2 + 0.4, 0.1, -d / 2 + 0.4]} zIndexRange={[15, 0]} style={{ pointerEvents: 'none' }}>
          <div style={{
            color: z.color, background: 'rgba(13,20,33,0.75)', border: `1px solid ${z.color}55`,
            borderRadius: 5, padding: '1px 7px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
            fontFamily: 'system-ui, sans-serif', transform: 'translate(0, -50%)',
          }}>{z.name}</div>
        </Html>
      </group>
    );
  },
);

/** One shared translate gizmo for a Ctrl-click multi-selection: sits at the
 * centroid, drags every member's THREE group live via the ref registry, and
 * reports the final world-delta on release (the page persists it as ONE
 * undoable group move). Remounted (via key) after each commit so the bases
 * re-capture from the freshly saved positions. */
function MultiTranslateGizmo({ items, refsMap, snap, onCommit }: {
  items: { id: string; wx: number; wz: number }[];
  refsMap: Map<string, THREE.Group>;
  snap: boolean;
  onCommit: (dxWorld: number, dzWorld: number) => void;
}) {
  const [pivot] = useState(() => new THREE.Group());
  const start = useMemo(() => {
    const cx = items.reduce((a, i) => a + i.wx, 0) / Math.max(items.length, 1);
    const cz = items.reduce((a, i) => a + i.wz, 0) / Math.max(items.length, 1);
    return new THREE.Vector3(cx, 0, cz);
  }, [items]);
  const bases = useMemo(() => {
    const m = new Map<string, THREE.Vector3>();
    for (const i of items) {
      const g = refsMap.get(i.id);
      m.set(i.id, g ? g.position.clone() : new THREE.Vector3(i.wx, 0, i.wz));
    }
    return m;
  }, [items, refsMap]);
  useEffect(() => { pivot.position.copy(start); }, [pivot, start]);

  const apply = () => {
    const dx = pivot.position.x - start.x, dz = pivot.position.z - start.z;
    for (const i of items) {
      const g = refsMap.get(i.id), b = bases.get(i.id);
      if (g && b) g.position.set(b.x + dx, b.y, b.z + dz);
    }
  };
  return (
    <>
      <primitive object={pivot} />
      <TransformControls
        object={pivot} mode="translate" showX showZ showY={false}
        translationSnap={snap ? SNAP_TRANSLATE : null}
        onObjectChange={apply}
        onMouseUp={() => {
          const dx = pivot.position.x - start.x, dz = pivot.position.z - start.z;
          if (Math.abs(dx) > 1e-6 || Math.abs(dz) > 1e-6) onCommit(dx, dz);
        }}
      />
    </>
  );
}

/** Selected zone: gizmo translate moves it, scale reshapes it (committed back
 * into pos_w/pos_h — zones have no rotation in the data model). */
function SelectedZone({ z, cx, cy, mode, snap, onCommit }: { z: Z3D; cx: number; cy: number; mode: TMode; snap: boolean; onCommit: ZoneCommit3D }) {
  const [grp, setGrp] = useState<THREE.Group | null>(null);
  const commit = () => {
    if (!grp) return;
    const newW = Math.max(40, Math.round(z.pos_w * grp.scale.x));
    const newH = Math.max(40, Math.round(z.pos_h * grp.scale.z));
    onCommit(z.id, {
      pos_x: Math.round(grp.position.x / SCALE + cx - newW / 2),
      pos_y: Math.round(grp.position.z / SCALE + cy - newH / 2),
      pos_w: newW,
      pos_h: newH,
    });
    grp.scale.set(1, 1, 1);
  };
  return (
    <>
      <Zone3DBlock ref={setGrp} z={z} cx={cx} cy={cy} selected />
      {grp && (
        <TransformControls
          object={grp} mode={mode === 'rotate' ? 'translate' : mode}
          showX showY={false} showZ
          translationSnap={snap ? SNAP_TRANSLATE : null}
          onMouseUp={commit}
        />
      )}
    </>
  );
}

const MachineBox = forwardRef<THREE.Group, { m: M3D; cx: number; cy: number; onSelect: SelectFn; editMode?: boolean; selected?: boolean }>(
  function MachineBox({ m, cx, cy, onSelect, editMode = false, selected = false }, ref) {
    const w = Math.max(m.pos_w, 40) * SCALE;
    const d = Math.max(m.pos_h, 40) * SCALE;
    const h = m.height_3d ?? heightFor(m);
    const x = ((m.pos_x + m.pos_w / 2) - cx) * SCALE;
    const z = ((m.pos_y + m.pos_h / 2) - cy) * SCALE;
    const color = STATUS_COLORS[m.status] ?? STATUS_COLORS.idle;
    const sx = m.model_scale ?? 1;
    const sy = m.scale_y ?? m.model_scale ?? 1;
    const sz = m.scale_z ?? m.model_scale ?? 1;
    const animate = m.status === 'running' && !editMode;   // freeze while editing → easy to position
    // Explicit choice wins; 'auto'/empty falls back to the name heuristic, then box.
    const kind = m.block_kind && m.block_kind !== 'auto' ? m.block_kind : (isCobot(m) ? 'cobot' : '');
    const fallback = <PlainMesh w={w} d={d} h={h} color={color} id={m.id} name={m.name} onSelect={onSelect} />;
    return (
      <group ref={ref} position={[x, 0, z]} rotation={[0, -((m.rotation_deg ?? 0) * Math.PI) / 180, 0]}
        scale={[sx, sy, sz]}>
        {m.model_url ? (
          <Suspense fallback={fallback}>
            <GltfModel url={m.model_url} w={w} d={d} h={h} color={color} id={m.id} name={m.name} onSelect={onSelect} animate={animate} />
          </Suspense>
        ) : PROCEDURAL_KINDS.has(kind) ? (
          <ProceduralShape kind={kind} w={w} d={d} h={h} color={color} id={m.id} name={m.name} onSelect={onSelect} animate={animate} status={m.status} stopReason={m.stop_reason} lineStats={m.line_stats} />
        ) : kind === 'box' ? fallback
        : m.icon_url ? (
          <Suspense fallback={fallback}>
            <PhotoMesh url={m.icon_url} w={w} d={d} h={h} color={color} id={m.id} name={m.name} onSelect={onSelect} />
          </Suspense>
        ) : fallback}
        {/* the assembly-line scene speaks for itself on a stop (red skirts +
            helmets + justification balloon) — no beacon cone over it */}
        {kind !== 'assembly_line' && (m.status === 'stopped' || m.status === 'maintenance' || m.status === 'planned_stop' || m.status === 'intervention' || m.status === 'unjustified') && (
          <AlertBeacon y={h + 1.2 / sy} color={color} parentScale={[sx, sy, sz]} />
        )}
        {m.status === 'intervention' && m.technicians && m.technicians.length > 0 && (
          <TechCrew techs={m.technicians} ticket={m.open_ticket_number}
            w={w} d={d} parentScale={[sx, sy, sz]} />
        )}
        {/* planned pipeline of pending OFs stacked behind the machine (cutting saws) */}
        {kind !== 'assembly_line' && kind !== 'pit_stop' && (m.pipeline_total ?? 0) > 0 && (
          <MachinePipeline ofs={m.pipeline_ofs ?? []} total={m.pipeline_total ?? 0}
            d={d} parentScale={[sx, sy, sz]} />
        )}
        {selected && <SelectionFootprint w={w} d={d} />}
      </group>
    );
  },
);

// Memoized render path: the 4 s status push rebuilds the M3D array, but each
// machine whose object survived unchanged (same reference — see the stable
// cache in FactoryMap) skips its whole subtree re-render.
const MachineBoxMemo = memo(MachineBox);

function SelectedMachine({ m, cx, cy, mode, snap, onCommit }: { m: M3D; cx: number; cy: number; mode: TMode; snap: boolean; onCommit: Commit }) {
  // Attach the gizmo to the actual positioned group (via `object`), not a wrapper,
  // so the gizmo sits on the block and the drag delta is read back correctly.
  const [grp, setGrp] = useState<THREE.Group | null>(null);
  const sclamp = (v: number) => Math.max(0.05, Math.round(v * 100) / 100);
  const commit = () => {
    if (!grp) return;
    onCommit(m.id, {
      pos_x: Math.round(grp.position.x / SCALE + cx - m.pos_w / 2),
      pos_y: Math.round(grp.position.z / SCALE + cy - m.pos_h / 2),
      model_scale: sclamp(grp.scale.x),
      scale_y: sclamp(grp.scale.y),
      scale_z: sclamp(grp.scale.z),
      rotation_deg: ((Math.round((-grp.rotation.y * 180) / Math.PI) % 360) + 360) % 360,
    });
  };
  return (
    <>
      <MachineBox ref={setGrp} m={m} cx={cx} cy={cy} onSelect={() => {}} editMode selected />
      {grp && (
        <TransformControls
          object={grp} mode={mode}
          showX={mode === 'translate' || mode === 'scale'}
          showY={mode === 'rotate' || mode === 'scale'}
          showZ={mode === 'translate' || mode === 'scale'}
          translationSnap={snap ? SNAP_TRANSLATE : null}
          rotationSnap={snap ? SNAP_ROTATE : null}
          onMouseUp={commit}
        />
      )}
    </>
  );
}

export interface KpiInfo {
  availability_pct?: number;
  parts_per_hour?: number;
  quality_pct?: number;
  oee_pct?: number;
  operator?: string | null;
}

const pct = (v?: number | null) => (v != null ? `${Math.round(v)}%` : '—');

// Floating live-KPI card above the machine the user clicked (View mode).
function KpiBillboard({ m, cx, cy, kpi }: { m: M3D; cx: number; cy: number; kpi: KpiInfo | null }) {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || 'en').slice(0, 2) as 'en' | 'fr' | 'es';
  const statusLabel = (s?: string | null) =>
    s ? STATUS_LABELS[s]?.[lang] ?? s : '—';
  const h = m.height_3d ?? heightFor(m);
  const x = ((m.pos_x + m.pos_w / 2) - cx) * SCALE;
  const z = ((m.pos_y + m.pos_h / 2) - cy) * SCALE;
  const color = STATUS_COLORS[m.status] ?? STATUS_COLORS.idle;
  const cell = (label: string, value: string) => (
    <div style={{ background: '#0d1421', border: '1px solid #1f2937', borderRadius: 6, padding: '5px 8px', minWidth: 0 }}>
      <div style={{ fontSize: 10, color: '#64748b', lineHeight: 1.15 }}>{label}</div>
      <div style={{ fontSize: 15, color: '#e5e7eb', fontWeight: 600, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
    </div>
  );
  // No `distanceFactor` → the card keeps a constant on-screen size, so it stays
  // legible at any zoom level (it always anchors above the clicked machine).
  return (
    <group position={[x, 0, z]}>
      <Html position={[0, h + 1.9, 0]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
        <div style={{ width: 224, background: 'rgba(13,20,33,0.94)', border: `1.5px solid ${color}`, borderRadius: 10, padding: 10, color: '#e5e7eb', boxShadow: '0 6px 20px rgba(0,0,0,0.55)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
            <span style={{ width: 11, height: 11, borderRadius: '50%', background: color, flexShrink: 0 }} />
            <span style={{ fontSize: 15, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
            {kpi ? (
              <>
                {cell(t('factoryMap.oee'), pct(kpi.oee_pct))}
                {cell(t('factoryMap.availability'), pct(kpi.availability_pct))}
                {cell(t('factoryMap.partsPerHour'), kpi.parts_per_hour != null ? String(Math.round(kpi.parts_per_hour)) : '—')}
                {cell(t('factoryMap.quality'), pct(kpi.quality_pct))}
                {cell(t('common.status'), statusLabel(m.status))}
                {cell(t('factoryMap.operator'), kpi.operator || '—')}
              </>
            ) : (
              <div style={{ gridColumn: '1 / 3', fontSize: 12, color: '#64748b' }}>…</div>
            )}
          </div>
        </div>
      </Html>
    </group>
  );
}

// What the camera should fly to. `nonce` bumps on every click so re-selecting
// the same view re-triggers the fly-to. Two flavours:
//  • 'box'  — frame the map-pixel bounding box of a set of machines (department
//             auto-views / overview); keeps the current orbit direction.
//  • 'pose' — restore an EXACT saved camera pose (custom saved views): look-at
//             point in map-pixel space + camera offset vector (world units).
export type FocusTarget =
  | { kind: 'box'; minX: number; minY: number; maxX: number; maxY: number; nonce: number }
  | { kind: 'pose'; targetPxX: number; targetPxY: number; targetY: number; offsetX: number; offsetY: number; offsetZ: number; nonce: number };

// Current camera pose captured for saving — mirrors the 'pose' focus shape.
export interface CameraPose { targetPxX: number; targetPxY: number; targetY: number; offsetX: number; offsetY: number; offsetZ: number }

/** Exposes a reader for the live camera pose to the parent (outside the Canvas).
 * The parent stows the reader in a ref and calls it when the user hits "Save
 * view", capturing exactly where they orbited to — center-independently (look-at
 * in map pixels, camera as an offset vector). */
function PoseReporter({ cx, cy, onPoseReader }: { cx: number; cy: number; onPoseReader?: (reader: (() => CameraPose) | null) => void }) {
  const { camera, controls } = useThree();
  useEffect(() => {
    if (!onPoseReader) return;
    const reader = (): CameraPose => {
      const ctrl = controls as unknown as { target: THREE.Vector3 } | null;
      const tgt = ctrl?.target ?? new THREE.Vector3();
      return {
        targetPxX: tgt.x / SCALE + cx,
        targetPxY: tgt.z / SCALE + cy,
        targetY: tgt.y,
        offsetX: camera.position.x - tgt.x,
        offsetY: camera.position.y - tgt.y,
        offsetZ: camera.position.z - tgt.z,
      };
    };
    onPoseReader(reader);
    return () => onPoseReader(null);
  }, [camera, controls, cx, cy, onPoseReader]);
  return null;
}

/** Smoothly flies the camera + OrbitControls target to frame a FocusTarget.
 * Keeps the CURRENT viewing direction (so it reads as a natural zoom-in/out
 * from wherever you're orbiting) and pulls the distance back just enough to fit
 * the box for the live viewport aspect. Lives inside the Canvas so it can read
 * the same frozen scene centre (cx/cy) the machines are positioned against. */
function CameraRig({ cx, cy, focus }: { cx: number; cy: number; focus: FocusTarget | null }) {
  const { camera, controls, size } = useThree();
  const anim = useRef<{
    fromPos: THREE.Vector3; toPos: THREE.Vector3;
    fromTgt: THREE.Vector3; toTgt: THREE.Vector3; start: number; dur: number;
  } | null>(null);

  useEffect(() => {
    const ctrl = controls as unknown as { target: THREE.Vector3 } | null;
    if (!focus || !ctrl) return;
    let target: THREE.Vector3;
    let toPos: THREE.Vector3;
    if (focus.kind === 'pose') {
      // Restore the exact saved pose: re-project the look-at pixel with the current
      // centroid, put the camera at target + saved offset.
      target = new THREE.Vector3(
        (focus.targetPxX - cx) * SCALE, focus.targetY, (focus.targetPxY - cy) * SCALE,
      );
      toPos = target.clone().add(new THREE.Vector3(focus.offsetX, focus.offsetY, focus.offsetZ));
    } else {
      target = new THREE.Vector3(
        ((focus.minX + focus.maxX) / 2 - cx) * SCALE, 0,
        ((focus.minY + focus.maxY) / 2 - cy) * SCALE,
      );
      // radius that must fit on screen (half the box diagonal, floored so a single
      // machine still gets a sensible close-up)
      const halfW = ((focus.maxX - focus.minX) / 2) * SCALE;
      const halfD = ((focus.maxY - focus.minY) / 2) * SCALE;
      const radius = Math.max(Math.hypot(halfW, halfD), 3);
      const cam = camera as THREE.PerspectiveCamera;
      const vFov = (cam.fov * Math.PI) / 180;
      const aspect = size.width / Math.max(size.height, 1);
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
      const dist = Math.max(radius / Math.tan(vFov / 2), radius / Math.tan(hFov / 2)) * 1.25 + 4;
      // keep the current orbit direction; fall back to a pleasant iso angle if the
      // camera happens to sit on the target
      let dir = camera.position.clone().sub(ctrl.target);
      if (dir.lengthSq() < 1e-4) dir = new THREE.Vector3(0.6, 0.75, 0.9);
      dir.normalize();
      toPos = target.clone().add(dir.multiplyScalar(dist));
    }
    anim.current = {
      fromPos: camera.position.clone(), toPos,
      fromTgt: ctrl.target.clone(), toTgt: target, start: performance.now(), dur: 850,
    };
    // Re-run on `focus` (fresh object+nonce per selection) and when camera/controls
    // first become available — so a focus set on mount (before OrbitControls finished
    // registering) still applies. `size` is deliberately excluded: it changes on every
    // resize/fullscreen and must NOT re-fly the camera.
  }, [focus, camera, controls]);  // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(() => {
    const a = anim.current;
    const ctrl = controls as unknown as { target: THREE.Vector3; update: () => void } | null;
    if (!a || !ctrl) return;
    const k = Math.min(1, (performance.now() - a.start) / a.dur);
    const e = k * k * (3 - 2 * k);                    // smoothstep ease
    camera.position.lerpVectors(a.fromPos, a.toPos, e);
    ctrl.target.lerpVectors(a.fromTgt, a.toTgt, e);
    ctrl.update();
    if (k >= 1) anim.current = null;
  });
  return null;
}

function FloorPlane({ url, cx, cy }: { url: string; cx: number; cy: number }) {
  const tex = useTexture(url);
  const img = tex.image as { width?: number; height?: number } | undefined;
  const aspect = img && img.width ? (img.height as number) / img.width : 0.6;
  const wPx = FLOOR_W;
  const hPx = FLOOR_W * aspect;
  const x = (wPx / 2 - cx) * SCALE;
  const z = (hPx / 2 - cy) * SCALE;
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[x, 0, z]} receiveShadow>
      <planeGeometry args={[wPx * SCALE, hPx * SCALE]} />
      <meshStandardMaterial map={tex} />
    </mesh>
  );
}

// A temperature sensor shows as just a floating label (the reading in the viewer's
// unit, ring coloured blue→red by temperature) at its map position — deliberately
// NO 3D thermometer geometry, so it won't be confused with the machines' own
// temperature probes later. The empty group carries the position for the gizmo.
const Thermometer3D = forwardRef<THREE.Group, {
  s: S3D; cx: number; cy: number; unit: TempUnit; onSelect?: (id: string) => void; editMode?: boolean;
}>(function Thermometer3D({ s, cx, cy, unit, onSelect, editMode = false }, ref) {
  const x = (s.pos_x - cx) * SCALE;
  const z = (s.pos_y - cy) * SCALE;
  const baseY = s.height_3d ?? 3;
  const color = tempColor(s.last_value_c);
  return (
    <group ref={ref} position={[x, baseY, z]}>
      <Html center distanceFactor={16} zIndexRange={[30, 0]} style={{ pointerEvents: editMode ? 'auto' : 'none' }}>
        <div onClick={editMode ? (e) => { e.stopPropagation(); onSelect?.(s.id); } : undefined}
          style={{
            background: 'rgba(13,20,33,0.92)', border: `1px solid ${color}`, color: '#e5e7eb',
            borderRadius: 9999, padding: '2px 9px', fontSize: 13, fontWeight: 700,
            whiteSpace: 'nowrap', fontFamily: 'system-ui, sans-serif',
            cursor: editMode ? 'pointer' : 'default',
          }}>{formatTemp(s.last_value_c, unit)}</div>
      </Html>
    </group>
  );
});

function SelectedSensor({ s, cx, cy, unit, snap, onCommit }: { s: S3D; cx: number; cy: number; unit: TempUnit; snap: boolean; onCommit: SensorCommit }) {
  const [grp, setGrp] = useState<THREE.Group | null>(null);
  const commit = () => {
    if (!grp) return;
    onCommit(s.id, {
      pos_x: Math.round(grp.position.x / SCALE + cx),
      pos_y: Math.round(grp.position.z / SCALE + cy),
    });
  };
  return (
    <>
      <Thermometer3D ref={setGrp} s={s} cx={cx} cy={cy} unit={unit} />
      {grp && (
        <TransformControls object={grp} mode="translate" showX showZ showY={false}
          translationSnap={snap ? SNAP_TRANSLATE : null} onMouseUp={commit} />
      )}
    </>
  );
}

// Tracks which sensor you're looking at (throttled) so the DOM badge can switch
// between that sensor's indoor reading and the outdoor weather. Keys off the point
// on the floor the camera looks at (screen-centre ray ∩ ground), so it follows the
// area you navigate to regardless of camera height. Zoomed right out (overview) or
// looking away from every sensor → null → the badge shows weather.
function NearestSensorTracker({ sensors, machinePoints = [], cx, cy, onChange }: {
  sensors: S3D[]; machinePoints?: MachinePoint[]; cx: number; cy: number; onChange?: (id: string | null) => void;
}) {
  const last = useRef<string | null>(null);
  const acc = useRef(0);
  const dir = useRef(new THREE.Vector3());
  // The badge is DEPARTMENT-aware: a sensor is bound to a department and only ever
  // shows for THAT department, so it never leaks its label into a neighbour. The
  // department of a point = the department of the nearest ANCHOR, where anchors are
  // the machines AND the department-bound sensors themselves — so a machineless
  // department (no machines to anchor it) is anchored by its own sensor and still
  // resolves correctly. A department with no sensor → weather. OVERVIEW_*
  // (camera-to-look-at) forces weather when zoomed right out. Unbound sensors (and
  // plants with no department data at all) fall back to a tight look-at radius.
  const OVERVIEW_IN = 70, OVERVIEW_OUT = 80;
  const RADIUS_IN = 10, RADIUS_OUT = 16;   // fallback for unbound sensors / no department data
  const anchoredSensors = sensors.filter((s) => s.department);
  const hasDeptData = machinePoints.length > 0 || anchoredSensors.length > 0;
  const deptOf = (px: number, py: number): string | null => {
    let best: string | null = null, bestD = Infinity;
    for (const m of machinePoints) {
      const d = (m.x - px) * (m.x - px) + (m.y - py) * (m.y - py);
      if (d < bestD) { bestD = d; best = m.dept; }
    }
    for (const s of anchoredSensors) {
      const d = (s.pos_x - px) * (s.pos_x - px) + (s.pos_y - py) * (s.pos_y - py);
      if (d < bestD) { bestD = d; best = s.department ?? null; }
    }
    return best;
  };
  useFrame((state, delta) => {
    if (!onChange) return;
    acc.current += delta;
    if (acc.current < 0.25) return;    // ~4 Hz is plenty for a badge
    acc.current = 0;
    const cam = state.camera;
    // Ground point the camera looks at (fall back to straight below when level).
    cam.getWorldDirection(dir.current);
    let gx = cam.position.x, gz = cam.position.z;
    if (Math.abs(dir.current.y) > 1e-4) {
      const tt = -cam.position.y / dir.current.y;
      if (tt > 0) { gx = cam.position.x + dir.current.x * tt; gz = cam.position.z + dir.current.z * tt; }
    }
    const camToGround = Math.hypot(cam.position.x - gx, cam.position.y, cam.position.z - gz);
    const showing = last.current !== null;

    const radius = showing ? RADIUS_OUT : RADIUS_IN;
    // Nearest sensor to the look-at among a set, returning null past `maxD` (Infinity = no limit).
    const nearestSensor = (pool: S3D[], maxD: number): string | null => {
      let id: string | null = null, bestD = Infinity;
      for (const s of pool) {
        const sx = (s.pos_x - cx) * SCALE, sz = (s.pos_y - cy) * SCALE;
        const d = Math.hypot(sx - gx, sz - gz);
        if (d < bestD) { bestD = d; id = s.id; }
      }
      return id !== null && bestD < maxD ? id : null;
    };

    let best: string | null = null;
    if (hasDeptData) {
      // Department the camera is looking at → its bound sensor (no limit within a department).
      const lookDept = deptOf(gx / SCALE + cx, gz / SCALE + cy);
      if (lookDept) best = nearestSensor(sensors.filter((s) => s.department === lookDept), Infinity);
      // Unbound sensors still read, but only when you're right on them (tight radius).
      if (best === null) best = nearestSensor(sensors.filter((s) => !s.department), radius);
    } else {
      // No department data at all → nearest sensor within a tight look-at radius.
      best = nearestSensor(sensors, radius);
    }

    const overviewGate = showing ? OVERVIEW_OUT : OVERVIEW_IN;
    const result = (camToGround < overviewGate && best !== null) ? best : null;
    if (result !== last.current) { last.current = result; onChange(result); }
  });
  return null;
}

export default function Factory3D({ machines, floorPlanUrl, onSelect, editMode = false, selectedId = null, mode = 'translate', onCommit,
  props = [], onSelectProp, selectedPropId = null, onPropCommit, infoId = null, infoKpi = null, cameraPosition = [40, 45, 55], focus = null, onPoseReader,
  tvThresholds, globalLineStats = null,
  sensors = [], tempUnit = 'C', selectedSensorId = null, onSelectSensor, onSensorCommit, onNearestSensorChange,
  machinePoints = [], pitStop = null, onSelectPitStopOf, selectedPitStopOfId = null,
  zones = [], selectedZoneId = null, onSelectZone, onZoneCommit,
  snap = true, placement = null, onPlace,
  multiSelection = null, onMultiCommit }: {
  machines: M3D[];
  floorPlanUrl: string | null;
  onSelect: SelectFn;
  tvThresholds?: TvThresholds;   // efficiency-colour thresholds for the line TVs
  globalLineStats?: LineStats | null;   // the plant's global clock (own objective)
  editMode?: boolean;
  selectedId?: string | null;
  mode?: TMode;
  onCommit?: Commit;
  props?: P3D[];
  onSelectProp?: SelectFn;
  selectedPropId?: string | null;
  onPropCommit?: PropCommit;
  infoId?: string | null;
  infoKpi?: KpiInfo | null;
  cameraPosition?: [number, number, number];
  focus?: FocusTarget | null;
  onPoseReader?: (reader: (() => CameraPose) | null) => void;
  sensors?: S3D[];
  tempUnit?: TempUnit;
  selectedSensorId?: string | null;
  onSelectSensor?: (id: string) => void;
  onSensorCommit?: SensorCommit;
  onNearestSensorChange?: (id: string | null) => void;
  machinePoints?: MachinePoint[];
  pitStop?: PitStopState | null;                    // polled buffer state (null = none/no data yet)
  onSelectPitStopOf?: (jobOrderId: string) => void; // click on an OF stack
  selectedPitStopOfId?: string | null;
  zones?: Z3D[];                                    // drawn flat on the floor in edit mode
  selectedZoneId?: string | null;
  onSelectZone?: (id: string) => void;
  onZoneCommit?: ZoneCommit3D;
  snap?: boolean;                                   // grid/angle snapping for the gizmo
  placement?: PlacementSpec | null;                 // click-to-place ghost (edit mode)
  onPlace?: (posX: number, posY: number) => void;
  multiSelection?: MultiSelection | null;           // Ctrl-click group (edit mode)
  onMultiCommit?: (dxPx: number, dyPx: number) => void;   // group-drag delta in map px
}) {
  // Freeze the scene centre once (per mount / plant) so moving a machine doesn't drift everything.
  // Centre on machines (props don't shift it); fall back to props when a plant has only props.
  const centerRef = useRef<[number, number] | null>(null);
  if (centerRef.current === null && (machines.length || props.length)) {
    const boxes = machines.length
      ? machines.map((m) => [m.pos_x, m.pos_y, m.pos_w, m.pos_h] as const)
      : props.map((p) => [p.pos_x, p.pos_y, p.pos_w, p.pos_h] as const);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [px, py, pw, ph] of boxes) {
      minX = Math.min(minX, px); maxX = Math.max(maxX, px + pw);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py + ph);
    }
    centerRef.current = [(minX + maxX) / 2, (minY + maxY) / 2];
  }
  const [cx, cy] = centerRef.current ?? [0, 0];

  // Ref registry for multi-selected groups — the shared gizmo drags them live.
  const multiRefs = useRef(new Map<string, THREE.Group>());
  const multiRefCbs = useRef(new Map<string, (g: THREE.Group | null) => void>());
  const refFor = (id: string) => {
    let cb = multiRefCbs.current.get(id);
    if (!cb) {
      cb = (g) => { if (g) multiRefs.current.set(id, g); else multiRefs.current.delete(id); };
      multiRefCbs.current.set(id, cb);
    }
    return cb;
  };
  const inMultiM = (id: string) => !!multiSelection?.machines.includes(id);
  const inMultiP = (id: string) => !!multiSelection?.props.includes(id);
  const multiItems = useMemo(() => {
    if (!multiSelection) return [];
    const items: { id: string; wx: number; wz: number }[] = [];
    for (const m of machines) {
      if (!multiSelection.machines.includes(m.id)) continue;
      items.push({ id: m.id, wx: ((m.pos_x + m.pos_w / 2) - cx) * SCALE, wz: ((m.pos_y + m.pos_h / 2) - cy) * SCALE });
    }
    for (const p of props) {
      if (!multiSelection.props.includes(p.id)) continue;
      items.push({ id: p.id, wx: ((p.pos_x + p.pos_w / 2) - cx) * SCALE, wz: ((p.pos_y + p.pos_h / 2) - cy) * SCALE });
    }
    return items;
  }, [multiSelection, machines, props, cx, cy]);

  const clearSelection = () => { onSelect(''); onSelectProp?.(''); onSelectSensor?.(''); };

  return (
    <Canvas dpr={[1, 1.5]} camera={{ position: cameraPosition, fov: 45 }} style={{ background: '#0a0f1a' }} onPointerMissed={clearSelection}>
      {/* re-provide inside the Canvas — context does not cross the R3F renderer */}
      <TvThresholdsCtx.Provider value={tvThresholds ?? TV_THRESHOLDS_DEFAULT}>
      <PitStopCtx.Provider value={{ state: pitStop, onSelectOf: onSelectPitStopOf, selectedOfId: selectedPitStopOfId }}>
      <ambientLight intensity={0.4} />
      <SunLight />
      {floorPlanUrl ? (
        <Suspense fallback={null}><FloorPlane url={floorPlanUrl} cx={cx} cy={cy} /></Suspense>
      ) : (
        <>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
            <planeGeometry args={[600, 600]} />
            <meshStandardMaterial color="#3b475c" />
          </mesh>
          <Grid args={[400, 400]} cellSize={2} cellColor="#1f2937" sectionColor="#374151" infiniteGrid fadeDistance={140} position={[0, 0.02, 0]} />
        </>
      )}
      {machines.map((m) => (editMode && selectedId === m.id && onCommit)
        ? <SelectedMachine key={m.id} m={m} cx={cx} cy={cy} mode={mode} snap={snap} onCommit={onCommit} />
        : <MachineBoxMemo key={m.id} ref={editMode && inMultiM(m.id) ? refFor(m.id) : undefined}
            m={m} cx={cx} cy={cy} onSelect={onSelect} editMode={editMode} selected={editMode && inMultiM(m.id)} />)}
      <GlobalLineTV machines={machines} cx={cx} cy={cy} stats={globalLineStats} />
      {props.map((p) => (editMode && selectedPropId === p.id && onPropCommit)
        ? <SelectedProp key={p.id} p={p} cx={cx} cy={cy} mode={mode} snap={snap} onCommit={onPropCommit} />
        : <PropBlockMemo key={p.id} ref={editMode && inMultiP(p.id) ? refFor(p.id) : undefined}
            p={p} cx={cx} cy={cy} onSelect={onSelectProp ?? (() => {})} editMode={editMode} selected={editMode && inMultiP(p.id)} />)}
      {/* Ctrl-click group: one translate gizmo at the centroid; keyed by the group's
          make-up + positions so it re-bases after every commit */}
      {editMode && multiItems.length > 1 && onMultiCommit && (
        <MultiTranslateGizmo
          key={multiItems.map((i) => `${i.id}:${Math.round(i.wx * 100)},${Math.round(i.wz * 100)}`).join('|')}
          items={multiItems} refsMap={multiRefs.current} snap={snap}
          onCommit={(dx, dz) => onMultiCommit(Math.round(dx / SCALE), Math.round(dz / SCALE))}
        />
      )}
      {/* Zones — flat floor areas, editable without leaving 3D (edit mode only).
          While placing, they go click-transparent so the ghost catcher underneath
          receives the click (zones often cover most of the floor). */}
      {editMode && zones.map((z) => (selectedZoneId === z.id && onZoneCommit)
        ? <SelectedZone key={z.id} z={z} cx={cx} cy={cy} mode={mode} snap={snap} onCommit={onZoneCommit} />
        : <Zone3DBlock key={z.id} z={z} cx={cx} cy={cy} onSelect={placement ? undefined : onSelectZone} />)}
      {/* Temperature sensors — little thermometers; drag to reposition in edit mode */}
      {sensors.map((s) => (editMode && selectedSensorId === s.id && onSensorCommit)
        ? <SelectedSensor key={s.id} s={s} cx={cx} cy={cy} unit={tempUnit} snap={snap} onCommit={onSensorCommit} />
        : <Thermometer3D key={s.id} s={s} cx={cx} cy={cy} unit={tempUnit} onSelect={onSelectSensor} editMode={editMode} />)}
      {/* Click-to-place ghost — only mounted while placing */}
      {editMode && placement && onPlace && (
        <GhostPlacement cx={cx} cy={cy} spec={placement} snap={snap} onPlace={onPlace} />
      )}
      {!editMode && <NearestSensorTracker sensors={sensors} machinePoints={machinePoints} cx={cx} cy={cy} onChange={onNearestSensorChange} />}
      {/* Orbit areas — drop a cobot/conveyor inside a machine's orbit to auto-link it */}
      {editMode && machines.filter((m) => (m.asset_type ?? 'production') === 'production').map((m) => {
        const rx = m.orbit_x ?? (m.pos_x - ORBIT_MARGIN);
        const ry = m.orbit_y ?? (m.pos_y - ORBIT_MARGIN);
        const rw = m.orbit_w ?? (Math.max(m.pos_w, 40) + 2 * ORBIT_MARGIN);
        const rh = m.orbit_h ?? (Math.max(m.pos_h, 40) + 2 * ORBIT_MARGIN);
        const w = rw * SCALE, d = rh * SCALE;
        const ox = ((rx + rw / 2) - cx) * SCALE;
        const oz = ((ry + rh / 2) - cy) * SCALE;
        return (
          <mesh key={`orbit-${m.id}`} rotation={[-Math.PI / 2, 0, 0]} position={[ox, 0.04, oz]}>
            <planeGeometry args={[w, d]} />
            <meshBasicMaterial color="#6366f1" transparent opacity={0.12} depthWrite={false} />
          </mesh>
        );
      })}
      {(() => {
        const sel = infoId ? machines.find((m) => m.id === infoId) : null;
        return sel ? <KpiBillboard m={sel} cx={cx} cy={cy} kpi={infoKpi} /> : null;
      })()}
      <CameraRig cx={cx} cy={cy} focus={focus} />
      <PoseReporter cx={cx} cy={cy} onPoseReader={onPoseReader} />
      <OrbitControls
        makeDefault
        target={[0, 0, 0]}
        maxPolarAngle={Math.PI / 2.05}
        zoomToCursor
        zoomSpeed={2.2}
        panSpeed={1.4}
        rotateSpeed={0.95}
        minDistance={0.5}
        maxDistance={260}
      />
      </PitStopCtx.Provider>
      </TvThresholdsCtx.Provider>
    </Canvas>
  );
}
