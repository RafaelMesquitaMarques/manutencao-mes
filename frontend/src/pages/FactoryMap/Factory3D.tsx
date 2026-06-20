import { useMemo, useRef, useEffect, useState, forwardRef, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Grid, Html, Edges, useTexture, useGLTF, useAnimations, TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

const STATUS_COLORS: Record<string, string> = {
  running: '#22c55e', stopped: '#ef4444', maintenance: '#f59e0b', planned_stop: '#f59e0b', idle: '#6b7280',
};
const SCALE = 0.05;
const FLOOR_W = 1600;

export interface M3D {
  id: string;
  name: string;
  status: string;
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
 * runs a smooth pick-and-place cycle: the base swings between two stations and
 * the arm dips to pick/place a wood panel at each end (no spinning). A panel is
 * held at the gripper and a stack sits beside it. Stopped → eases to home pose. */
function CobotMesh({ h, color, id, name, onSelect, animate }: BoxProps & { animate?: boolean }) {
  const u = h / 3;                                   // scale unit (default height 3)
  const white = '#eef1f4', dark = '#2b2f36', green = '#8ec63f', wood = '#caa46a';
  const j1 = useRef<THREE.Group>(null);              // base yaw (Y)
  const j2 = useRef<THREE.Group>(null);              // shoulder pitch (Z)
  const j3 = useRef<THREE.Group>(null);              // elbow pitch (Z)
  const j4 = useRef<THREE.Group>(null);              // wrist pitch (Z)
  const gripPanel = useRef<THREE.Mesh>(null);        // the wood panel the gripper holds

  // Pick starts at yaw 0 — i.e. the direction you rotated the block to face — and
  // the place is 180° opposite. So the scene begins exactly where you aimed it.
  const CA = 0, MA = Math.PI;

  // Work cycle: dwell+pick at the conveyor → carry → dwell+place in the machine → return.
  useFrame((state) => {
    const a = animate ? 1 : 0;
    const T = 8;
    const p = (state.clock.elapsedTime % T) / T;     // 0..1 cycle phase
    const ss = (lo: number, hi: number, x: number) => {
      const k = THREE.MathUtils.clamp((x - lo) / (hi - lo), 0, 1);
      return k * k * (3 - 2 * k);
    };
    let yaw = CA;                                    // dwell at conveyor → swing → dwell at machine → swing back
    if (p < 0.30) yaw = CA;
    else if (p < 0.48) yaw = THREE.MathUtils.lerp(CA, MA, ss(0.30, 0.48, p));
    else if (p < 0.78) yaw = MA;
    else yaw = THREE.MathUtils.lerp(MA, CA, ss(0.78, 1.0, p));
    const bump = (c: number, wd: number) => { const z = (p - c) / wd; return Math.max(0, 1 - z * z); };
    const dip = Math.min(1, bump(0.15, 0.12) + bump(0.63, 0.12));   // reach down to pick (~0.15) and place (~0.63)
    const yawT = a ? yaw : 0, dipT = a ? dip : 0;
    if (j1.current) j1.current.rotation.y = THREE.MathUtils.lerp(j1.current.rotation.y, yawT, 0.12);
    if (j2.current) j2.current.rotation.z = THREE.MathUtils.lerp(j2.current.rotation.z, -0.25 - dipT * 0.72, 0.12);
    if (j3.current) j3.current.rotation.z = THREE.MathUtils.lerp(j3.current.rotation.z, 0.6 + dipT * 0.8, 0.12);
    if (j4.current) j4.current.rotation.z = THREE.MathUtils.lerp(j4.current.rotation.z, 0.35 + dipT * 0.5, 0.12);
    // hold the panel from the grab (one side) through the place (other side); empty on the way back
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
const propHeight = (kind: string): number => PROP_CATALOG.find((c) => c.kind === kind)?.height ?? 2;
// block_kinds that render as a procedural mesh (the rest fall back to box/photo)
const PROCEDURAL_KINDS = new Set(['cobot', 'conveyor', 'lift_table', 'work_table', 'rack', 'dust_collector']);

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

/** Renders the placeholder shape for a block `kind` (used until a .glb is uploaded). */
function ProceduralShape({ kind, w, d, h, color, id, name, onSelect, animate }: BoxProps & { kind: string; animate?: boolean }) {
  switch (kind) {
    case 'conveyor': return <ConveyorMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} animate={animate} />;
    case 'lift_table': return <LiftTableMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} />;
    case 'work_table': return <WorkTableMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} />;
    case 'rack': return <RackMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} />;
    case 'dust_collector': return <DustCollectorMesh w={w} d={d} h={h} color={color} id={id} name={name} onSelect={onSelect} />;
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
    const alert = linked && (p.status === 'stopped' || p.status === 'maintenance' || p.status === 'planned_stop');
    const fallback = <ProceduralShape kind={p.kind} w={w} d={d} h={h} color={color} id={p.id} name={label} onSelect={onSelect} animate={animate} />;
    return (
      <group ref={ref} position={[x, 0, z]} rotation={[0, -((p.rotation_deg ?? 0) * Math.PI) / 180, 0]}
        scale={[p.model_scale ?? 1, p.scale_y ?? p.model_scale ?? 1, p.scale_z ?? p.model_scale ?? 1]}>
        {p.model_url ? (
          <Suspense fallback={fallback}>
            <GltfModel url={p.model_url} w={w} d={d} h={h} color={color} id={p.id} name={label} onSelect={onSelect} animate={animate} />
          </Suspense>
        ) : fallback}
        {alert && <AlertBeacon y={h + 1.2} color={color} />}
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
function AlertBeacon({ y, color }: { y: number; color: string }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (!ref.current) return;
    const p = 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 4);
    ref.current.scale.setScalar(0.85 + p * 0.35);
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

const MachineBox = forwardRef<THREE.Group, { m: M3D; cx: number; cy: number; onSelect: (id: string) => void; editMode?: boolean }>(
  function MachineBox({ m, cx, cy, onSelect, editMode = false }, ref) {
    const w = Math.max(m.pos_w, 40) * SCALE;
    const d = Math.max(m.pos_h, 40) * SCALE;
    const h = m.height_3d ?? heightFor(m);
    const x = ((m.pos_x + m.pos_w / 2) - cx) * SCALE;
    const z = ((m.pos_y + m.pos_h / 2) - cy) * SCALE;
    const color = STATUS_COLORS[m.status] ?? STATUS_COLORS.idle;
    const animate = m.status === 'running' && !editMode;   // freeze while editing → easy to position
    // Explicit choice wins; 'auto'/empty falls back to the name heuristic, then box.
    const kind = m.block_kind && m.block_kind !== 'auto' ? m.block_kind : (isCobot(m) ? 'cobot' : '');
    const fallback = <PlainMesh w={w} d={d} h={h} color={color} id={m.id} name={m.name} onSelect={onSelect} />;
    return (
      <group ref={ref} position={[x, 0, z]} rotation={[0, -((m.rotation_deg ?? 0) * Math.PI) / 180, 0]}
        scale={[m.model_scale ?? 1, m.scale_y ?? m.model_scale ?? 1, m.scale_z ?? m.model_scale ?? 1]}>
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
        {(m.status === 'stopped' || m.status === 'maintenance' || m.status === 'planned_stop') && (
          <AlertBeacon y={h + 1.4} color={color} />
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

export interface KpiInfo { backlog_count: number; mttr_hours: number; pm_compliance_pct: number; total_cost_cad: number }

// Floating live-KPI card above the machine the user clicked (View mode).
function KpiBillboard({ m, cx, cy, kpi }: { m: M3D; cx: number; cy: number; kpi: KpiInfo | null }) {
  const h = m.height_3d ?? heightFor(m);
  const x = ((m.pos_x + m.pos_w / 2) - cx) * SCALE;
  const z = ((m.pos_y + m.pos_h / 2) - cy) * SCALE;
  const color = STATUS_COLORS[m.status] ?? STATUS_COLORS.idle;
  const cell = (label: string, value: string) => (
    <div style={{ background: '#0d1421', border: '1px solid #1f2937', borderRadius: 4, padding: '2px 5px' }}>
      <div style={{ fontSize: 7, color: '#64748b', lineHeight: 1.1 }}>{label}</div>
      <div style={{ fontSize: 10, color: '#e5e7eb', fontWeight: 600, lineHeight: 1.2 }}>{value}</div>
    </div>
  );
  return (
    <group position={[x, 0, z]}>
      <Html position={[0, h + 1.9, 0]} center distanceFactor={26} zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
        <div style={{ width: 132, background: 'rgba(13,20,33,0.92)', border: `1px solid ${color}`, borderRadius: 7, padding: 6, color: '#e5e7eb', boxShadow: '0 4px 14px rgba(0,0,0,0.5)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
            <span style={{ fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
            {kpi ? (
              <>
                {cell('Open WOs', String(kpi.backlog_count))}
                {cell('MTTR', `${kpi.mttr_hours.toFixed(1)}h`)}
                {cell('PM', `${kpi.pm_compliance_pct.toFixed(0)}%`)}
                {cell('Cost 30d', `$${Math.round(kpi.total_cost_cad).toLocaleString()}`)}
              </>
            ) : (
              <div style={{ gridColumn: '1 / 3', fontSize: 9, color: '#64748b' }}>…</div>
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
