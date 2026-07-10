import { useMemo, useRef, useEffect, useState, forwardRef, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Grid, Html, Edges, useTexture, useGLTF, useAnimations, TransformControls, Billboard } from '@react-three/drei';
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { useTranslation } from 'react-i18next';
import { STATUS_HEX as STATUS_COLORS, STATUS_LABEL as STATUS_LABELS } from '../../utils/statusColors';
import { initials } from '../../utils/initials';
import type { MapTechnician } from '../../api/factoryMap';
const SCALE = 0.05;
const FLOOR_W = 1600;

export interface M3D {
  id: string;
  name: string;
  status: string;
  technicians?: MapTechnician[] | null;   // techs on the clock when status === 'intervention'
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

interface BoxProps { w: number; d: number; h: number; color: string; id: string; name: string; onSelect: (id: string) => void }

const boxHandlers = (id: string, onSelect: (id: string) => void) => ({
  onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); onSelect(id); },
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

function GltfModel({ url, w, d, color, id, name, onSelect, animate }: BoxProps & { url: string; animate?: boolean }) {
  const { scene, animations } = useGLTF(url);
  // SkeletonUtils.clone keeps skinned-mesh bindings intact so multiple instances
  // (and glTF animation clips) work — plain scene.clone(true) breaks rigged models.
  const cloned = useMemo(() => {
    const c = skeletonClone(scene);
    c.traverse((o) => { (o as THREE.Mesh).castShadow = true; });
    return c;
  }, [scene]);
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
const PROCEDURAL_KINDS = new Set(['cobot', 'conveyor', 'lift_table', 'work_table', 'rack', 'dust_collector', 'beam_saw']);

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

function ConveyorMesh({ w, d, h, color, id, name, onSelect, animate }: BoxProps & { animate?: boolean }) {
  const legH = h * 0.7;
  const beltY = legH;
  const rollers = Math.min(14, Math.max(3, Math.round(w / 0.6)));
  const legW = Math.max(w * 0.03, 0.06), legD = Math.max(d * 0.06, 0.06);
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
      {Array.from({ length: rollers }).map((_, i) => {
        const x = -w / 2 + (i + 0.5) * (w / rollers);
        return (
          <mesh key={i} position={[x, beltY + h * 0.1, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
            <cylinderGeometry args={[d * 0.06, d * 0.06, d * 0.9, 10]} />
            <meshStandardMaterial color="#9ca3af" metalness={0.6} roughness={0.4} />
          </mesh>
        );
      })}
      {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], i) => (
        <mesh key={i} position={[(sx * w) / 2 * 0.9, legH / 2, (sz * d) / 2 * 0.8]} castShadow>
          <boxGeometry args={[legW, legH, legD]} />
          <meshStandardMaterial color="#1f2937" />
        </mesh>
      ))}
      <ConveyorFlow w={w} d={d} y={beltY + h * 0.18} animate={animate ?? true} />
      <Label y={h + 0.6} text={name} />
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

/** Renders the placeholder shape for a block `kind` (used until a .glb is uploaded). */
function ProceduralShape({ kind, w, d, h, color, id, name, onSelect, animate }: BoxProps & { kind: string; animate?: boolean }) {
  switch (kind) {
    case 'conveyor': return <ConveyorMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} animate={animate} />;
    case 'lift_table': return <LiftTableMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} />;
    case 'work_table': return <WorkTableMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} />;
    case 'rack': return <RackMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} />;
    case 'dust_collector': return <DustCollectorMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} />;
    case 'beam_saw': return <BeamSawMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} />;
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
}

export type PropCommit = (id: string, patch: { pos_x: number; pos_y: number; model_scale: number; scale_y: number; scale_z: number; rotation_deg: number }) => void;

const PropBlock = forwardRef<THREE.Group, { p: P3D; cx: number; cy: number; onSelect: (id: string) => void; editMode?: boolean }>(
  function PropBlock({ p, cx, cy, onSelect, editMode = false }, ref) {
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
      </group>
    );
  },
);

function SelectedProp({ p, cx, cy, mode, onCommit }: { p: P3D; cx: number; cy: number; mode: TMode; onCommit: PropCommit }) {
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
      <PropBlock ref={setGrp} p={p} cx={cx} cy={cy} onSelect={() => {}} editMode />
      {grp && (
        <TransformControls
          object={grp} mode={mode}
          showX={mode === 'translate' || mode === 'scale'}
          showY={mode === 'rotate' || mode === 'scale'}
          showZ={mode === 'translate' || mode === 'scale'}
          rotationSnap={Math.PI / 4}
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

const MachineBox = forwardRef<THREE.Group, { m: M3D; cx: number; cy: number; onSelect: (id: string) => void; editMode?: boolean }>(
  function MachineBox({ m, cx, cy, onSelect, editMode = false }, ref) {
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
          <ProceduralShape kind={kind} w={w} d={d} h={h} color={color} id={m.id} name={m.name} onSelect={onSelect} animate={animate} />
        ) : kind === 'box' ? fallback
        : m.icon_url ? (
          <Suspense fallback={fallback}>
            <PhotoMesh url={m.icon_url} w={w} d={d} h={h} color={color} id={m.id} name={m.name} onSelect={onSelect} />
          </Suspense>
        ) : fallback}
        {(m.status === 'stopped' || m.status === 'maintenance' || m.status === 'planned_stop' || m.status === 'intervention' || m.status === 'unjustified') && (
          <AlertBeacon y={h + 1.2 / sy} color={color} parentScale={[sx, sy, sz]} />
        )}
        {m.status === 'intervention' && m.technicians && m.technicians.length > 0 && (
          <TechCrew techs={m.technicians} ticket={m.open_ticket_number}
            w={w} d={d} parentScale={[sx, sy, sz]} />
        )}
      </group>
    );
  },
);

function SelectedMachine({ m, cx, cy, mode, onCommit }: { m: M3D; cx: number; cy: number; mode: TMode; onCommit: Commit }) {
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
      <MachineBox ref={setGrp} m={m} cx={cx} cy={cy} onSelect={() => {}} editMode />
      {grp && (
        <TransformControls
          object={grp} mode={mode}
          showX={mode === 'translate' || mode === 'scale'}
          showY={mode === 'rotate' || mode === 'scale'}
          showZ={mode === 'translate' || mode === 'scale'}
          rotationSnap={Math.PI / 4}
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

export default function Factory3D({ machines, floorPlanUrl, onSelect, editMode = false, selectedId = null, mode = 'translate', onCommit,
  props = [], onSelectProp, selectedPropId = null, onPropCommit, infoId = null, infoKpi = null }: {
  machines: M3D[];
  floorPlanUrl: string | null;
  onSelect: (id: string) => void;
  editMode?: boolean;
  selectedId?: string | null;
  mode?: TMode;
  onCommit?: Commit;
  props?: P3D[];
  onSelectProp?: (id: string) => void;
  selectedPropId?: string | null;
  onPropCommit?: PropCommit;
  infoId?: string | null;
  infoKpi?: KpiInfo | null;
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

  const clearSelection = () => { onSelect(''); onSelectProp?.(''); };

  return (
    <Canvas dpr={[1, 1.5]} camera={{ position: [40, 45, 55], fov: 45 }} style={{ background: '#0a0f1a' }} onPointerMissed={clearSelection}>
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
        ? <SelectedMachine key={m.id} m={m} cx={cx} cy={cy} mode={mode} onCommit={onCommit} />
        : <MachineBox key={m.id} m={m} cx={cx} cy={cy} onSelect={onSelect} editMode={editMode} />)}
      {props.map((p) => (editMode && selectedPropId === p.id && onPropCommit)
        ? <SelectedProp key={p.id} p={p} cx={cx} cy={cy} mode={mode} onCommit={onPropCommit} />
        : <PropBlock key={p.id} p={p} cx={cx} cy={cy} onSelect={onSelectProp ?? (() => {})} editMode={editMode} />)}
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
      <OrbitControls
        makeDefault
        target={[0, 0, 0]}
        maxPolarAngle={Math.PI / 2.05}
        zoomToCursor
        zoomSpeed={2.2}
        panSpeed={1.4}
        rotateSpeed={0.95}
        minDistance={4}
        maxDistance={260}
      />
    </Canvas>
  );
}
