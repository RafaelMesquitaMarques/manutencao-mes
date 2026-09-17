import { useEffect, useRef } from 'react';
import { BAKED_BODY_D, BAKED_MID_D, startMembrane, membraneTransform } from './membrane';
import './membrane.css';

/**
 * The membrane's gradients and fade mask. Every id is namespaced by `id`, so two
 * mounted membranes (the Home HUD and the voice orb overlap while the user is
 * talking to the ninja) never resolve each other's defs — if they shared ids,
 * unmounting one would strip the other's fills.
 *
 * Render this inside the host svg's own <defs>.
 */
export const MembraneDefs = ({ id }: { id: string }) => (
  <>
    <radialGradient id={`${id}-body`} cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stopColor="#4c1d95" stopOpacity="0.06" />
      <stop offset="0.3" stopColor="#1d4ed8" stopOpacity="0.17" />
      <stop offset="0.52" stopColor="#0e7490" stopOpacity="0.32" />
      <stop offset="0.72" stopColor="#0e7490" stopOpacity="0.4" />
      <stop offset="0.88" stopColor="#1d4ed8" stopOpacity="0.28" />
      <stop offset="0.97" stopColor="#4c1d95" stopOpacity="0.08" />
      <stop offset="1" stopColor="#4c1d95" stopOpacity="0" />
    </radialGradient>
    <radialGradient id={`${id}-mid`} cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stopColor="#0e7490" stopOpacity="0.05" />
      <stop offset="0.38" stopColor="#1d4ed8" stopOpacity="0.16" />
      <stop offset="0.66" stopColor="#22d3ee" stopOpacity="0.3" />
      <stop offset="0.88" stopColor="#4c1d95" stopOpacity="0.2" />
      <stop offset="1" stopColor="#4c1d95" stopOpacity="0" />
    </radialGradient>
    <radialGradient id={`${id}-p1`} cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stopColor="#22d3ee" stopOpacity="0.34" />
      <stop offset="0.42" stopColor="#0e7490" stopOpacity="0.24" />
      <stop offset="0.76" stopColor="#0e7490" stopOpacity="0.07" />
      <stop offset="1" stopColor="#0e7490" stopOpacity="0" />
    </radialGradient>
    <radialGradient id={`${id}-p2`} cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stopColor="#6d28d9" stopOpacity="0.3" />
      <stop offset="0.46" stopColor="#4c1d95" stopOpacity="0.2" />
      <stop offset="1" stopColor="#4c1d95" stopOpacity="0" />
    </radialGradient>
    <radialGradient id={`${id}-p3`} cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stopColor="#2563eb" stopOpacity="0.3" />
      <stop offset="0.5" stopColor="#1d4ed8" stopOpacity="0.15" />
      <stop offset="1" stopColor="#1d4ed8" stopOpacity="0" />
    </radialGradient>
    <radialGradient id={`${id}-p4`} cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stopColor="#67e8f9" stopOpacity="0.3" />
      <stop offset="0.34" stopColor="#22d3ee" stopOpacity="0.2" />
      <stop offset="0.72" stopColor="#1d4ed8" stopOpacity="0.08" />
      <stop offset="1" stopColor="#1d4ed8" stopOpacity="0" />
    </radialGradient>
    <radialGradient id={`${id}-p5`} cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stopColor="#a5f3fc" stopOpacity="0.4" />
      <stop offset="0.3" stopColor="#67e8f9" stopOpacity="0.26" />
      <stop offset="0.68" stopColor="#22d3ee" stopOpacity="0.08" />
      <stop offset="1" stopColor="#22d3ee" stopOpacity="0" />
    </radialGradient>
    <radialGradient id={`${id}-fade`} gradientUnits="userSpaceOnUse" cx="240" cy="240" r="185">
      <stop offset="0" stopColor="#ffffff" stopOpacity="0.34" />
      <stop offset="0.22" stopColor="#ffffff" stopOpacity="0.44" />
      <stop offset="0.4" stopColor="#ffffff" stopOpacity="0.88" />
      <stop offset="0.58" stopColor="#ffffff" stopOpacity="1" />
      <stop offset="0.74" stopColor="#ffffff" stopOpacity="0.92" />
      <stop offset="0.86" stopColor="#ffffff" stopOpacity="0.45" />
      <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
    </radialGradient>
    <mask id={`${id}-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width="480" height="480">
      <circle cx="240" cy="240" r="185" fill={`url(#${id}-fade)`} />
    </mask>
  </>
);

interface MembraneLayerProps {
  /** Namespace for the defs; must match the `id` given to MembraneDefs. */
  id: string;
  /** Where the ninja sits in the host's coordinates. */
  cx: number;
  cy: number;
  /** Shrinks the 480-space membrane around that point. 1 = the Home HUD. */
  scale?: number;
}

/**
 * The membrane itself. Render it AFTER the host's rings and BEFORE the ninja
 * image, so the ninja occludes it — the whole point is that it moves *behind*
 * the head. It starts its own rAF loop and cleans up on unmount.
 */
export const MembraneLayer = ({ id, cx, cy, scale = 1 }: MembraneLayerProps) => {
  const ref = useRef<SVGGElement>(null);

  useEffect(() => {
    const g = ref.current;
    if (!g) return;
    return startMembrane(g, id);
  }, [id]);

  return (
    <g transform={scale === 1 && cx === 240 && cy === 240 ? undefined : membraneTransform(cx, cy, scale)}>
      <g ref={ref} className="mem-layer" mask={`url(#${id}-mask)`}>
        <path className="mem-body" fill={`url(#${id}-body)`} d={BAKED_BODY_D} />
        <path className="mem-mid" fill={`url(#${id}-mid)`} d={BAKED_MID_D} />
        <g className="mem-pools" />
      </g>
    </g>
  );
};
