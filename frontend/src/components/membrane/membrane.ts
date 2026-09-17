// Dense living membrane that sits BEHIND the ninja core.
//
// Shared by the Home neural HUD and the Ask Ninja voice orb. The maths always
// runs in the HUD's 480x480 design space; a smaller host scales the whole layer
// with one transform (see MEMBRANE_VIEWBOX / membraneTransform) so both places
// keep the same silhouette and the same first frame.
//
// Two deforming shells give the mass; 17 gradient light-pools orbit inside them
// on incommensurable periods, so the density visibly pools and drifts like
// caustics on the bottom of a pool. Everything is additive (`screen` in the
// CSS), so the cyan HUD painted underneath is only ever brightened, never
// covered — the rings stay the foreground.
//
// The shell radius is `R0 * (harmonics + organic)`:
//   - `harmonics` is the original three-wave field (kept exactly as designed),
//   - `organic` is a 1/f spectrum (m = 2..11) where every harmonic carries its
//     own slow amplitude envelope, so lobes are born and die instead of
//     orbiting forever. Three fixed harmonics on their own read as a rotating
//     clover; the envelopes are what make the movement read as organic.
// Measured over 900 s of simulation: radius stays within 107..160 px (the KPI
// nodes sit at r=168 and the mask is already down to ~0.35 there), and the
// outline moves at ~4.4 px/s.

const NS = 'http://www.w3.org/2000/svg';

/** The membrane is authored in this square; hosts scale it with a transform. */
export const MEMBRANE_VIEWBOX = 480;

/**
 * Places the 480-space layer inside a host of any size: `cx`/`cy` is where the
 * ninja sits in the host's own coordinates, and `scale` shrinks the membrane
 * around it (1 in the HUD, 0.5 in the voice orb).
 */
export const membraneTransform = (cx: number, cy: number, scale: number) =>
  `translate(${cx} ${cy}) scale(${scale}) translate(-240 -240)`;

const C = 240;
const TAU = Math.PI * 2;

/**
 * First frame, baked at t=24.4s. Rendered straight from the markup so the
 * layer is never empty between React paint and the first rAF tick, and so a
 * reduced-motion viewer sees a finished shape even if JS never runs.
 */
export const BAKED_BODY_D =
  'M365.6 240.0L364.6 248.2L364.1 256.3L363.6 264.6L362.9 272.9L361.6 281.3L359.3 289.4L356.0 297.2L352.0 304.7L347.6 311.9L343.0 319.0L338.2 326.1L333.0 333.0L327.3 339.6L320.9 345.4L313.7 350.3L306.1 354.5L298.4 358.3L290.6 362.2L283.0 366.5L275.2 371.4L267.2 376.7L258.6 381.6L249.5 385.4L240.0 387.7L230.3 388.1L220.7 386.8L211.3 384.1L202.4 380.3L193.9 375.7L186.0 370.4L178.8 364.2L172.4 357.1L166.9 349.5L162.1 341.5L157.8 333.8L153.4 326.6L148.5 320.3L142.8 314.6L136.6 309.1L130.1 303.5L123.9 297.2L118.6 290.3L114.3 282.7L110.9 274.6L108.3 266.2L106.2 257.6L104.5 248.9L103.5 240.0L103.3 231.0L104.3 222.1L106.6 213.5L110.0 205.2L114.2 197.3L118.7 189.7L123.0 182.3L127.2 174.9L131.2 167.3L135.3 159.7L139.9 152.2L145.2 145.2L151.1 138.7L157.7 132.8L164.9 127.6L172.4 122.9L180.2 118.8L188.3 115.3L196.7 112.3L205.2 110.1L213.9 108.6L222.6 107.7L231.3 107.3L240.0 107.4L248.7 107.8L257.3 108.6L265.9 109.7L274.5 111.2L283.1 113.1L291.7 115.3L300.3 117.8L308.8 120.8L317.3 124.3L325.5 128.5L333.2 133.7L340.2 139.8L346.4 146.7L351.6 154.3L356.2 162.4L360.0 170.7L363.4 179.2L366.0 187.8L367.9 196.6L368.9 205.5L368.8 214.4L368.0 223.1L366.8 231.7Z';
export const BAKED_MID_D =
  'M335.1 240.0L334.0 248.2L333.0 256.4L331.9 264.6L330.4 272.9L328.3 281.2L325.4 289.3L321.5 297.1L316.7 304.3L310.9 310.9L304.6 317.0L298.0 322.8L291.2 328.7L284.1 334.6L276.4 340.0L267.9 344.2L258.8 346.7L249.4 347.3L240.0 346.4L230.9 344.6L222.0 342.1L213.3 339.6L204.7 337.1L195.7 334.9L186.4 332.9L176.6 330.5L167.1 326.9L158.7 321.3L152.4 313.5L148.6 304.0L147.0 293.7L146.8 283.5L146.9 273.9L146.8 265.0L146.4 256.5L146.0 248.2L145.7 240.0L145.7 231.7L145.9 223.4L146.7 215.0L148.4 206.7L151.2 198.6L155.0 191.0L159.3 183.5L163.7 176.0L168.2 168.2L173.3 160.5L179.5 153.6L187.0 148.2L195.6 144.7L204.5 142.6L213.5 141.0L222.3 139.4L231.0 137.7L240.0 136.1L249.2 135.2L258.5 135.2L267.9 135.9L277.4 137.2L286.9 139.5L295.9 143.2L304.0 148.5L310.9 155.5L316.6 163.4L321.5 171.6L326.2 179.6L330.7 187.6L334.5 195.9L337.1 204.7L338.0 213.7L337.6 222.8L336.4 231.6Z';

/** Deformation speed, and the calmer rate the light pools drift at. */
const SHELL_SPEED = 4;
const POOL_SPEED = 1.8;

/** [harmonic, amplitude, angularSpeed, phase, envelopeSpeed, envelopePhase] */
const ORGANIC: number[][] = [
  [2, 0.04519, -0.2141, 4.798, 0.0642, 3.542],
  [3, 0.02835, 0.4928, 0.914, 0.1621, 5.313],
  [4, 0.02037, -0.3335, 3.313, 0.0838, 0.801],
  [5, 0.01576, 0.1742, 5.712, 0.1817, 2.572],
  [6, 0.01278, -0.453, 1.828, 0.1034, 4.343],
  [7, 0.0107, 0.2937, 4.227, 0.2013, 6.114],
  [8, 0.00918, -0.1344, 0.342, 0.123, 1.602],
  [9, 0.00801, 0.4132, 2.741, 0.0447, 3.373],
  [10, 0.0071, -0.2539, 5.14, 0.1426, 5.144],
  [11, 0.00636, 0.0946, 1.256, 0.0642, 0.631],
];

const organic = (th: number, t: number) => {
  let k = 0;
  for (const h of ORGANIC) {
    k += h[1] * (0.4 + 0.6 * Math.sin(h[4] * t + h[5])) * Math.sin(h[0] * th + h[2] * t + h[3]);
  }
  return k;
};

/** [harmonic, amplitude, angularSpeed, phase] — the original travelling waves. */
const BODY_WAVES: number[][] = [[3, 0.052, 0.143, 0], [5, 0.034, -0.0971, 1.7], [2, 0.03, 0.0619, 3.1]];
const MID_WAVES: number[][] = [[2, 0.06, -0.1187, 0.6], [4, 0.038, 0.0833, 2.4], [7, 0.021, -0.0521, 5]];

const shell = (el: SVGPathElement, n: number, r0: number, waves: number[][], phase: number) => (t: number) => {
  let d = '';
  for (let i = 0; i < n; i++) {
    const th = (i / n) * TAU;
    const k = 1
      + waves[0][1] * Math.sin(waves[0][0] * th + waves[0][2] * t + waves[0][3])
      + waves[1][1] * Math.sin(waves[1][0] * th + waves[1][2] * t + waves[1][3])
      + waves[2][1] * Math.sin(waves[2][0] * th + waves[2][2] * t + waves[2][3]);
    const r = r0 * (k + organic(th + phase, t + phase * 2.7));
    d += (i ? 'L' : 'M') + (C + r * Math.cos(th)).toFixed(1) + ' ' + (C + r * Math.sin(th)).toFixed(1);
  }
  el.setAttribute('d', d + 'Z');
};

// gradient, rx, ry, orbitA, orbitB, orbitSpeed, orbitPhase, epicycle,
// epicycleSpeed, epicyclePhase, breatheSpeed, breathePhase, rot0, rotSpeed.
// Round ones pool; the long ones are the caustic streaks whose crossings make
// the bright knots.
const POOLS: [string, number, number, number, number, number, number, number, number, number, number, number, number, number][] = [
  ['p1', 60, 53, 70, 60, 0.041, 0, 16, 0.203, 0.6, 0.0731, 0, 12, 0.009],
  ['p1', 52, 58, 82, 66, -0.0337, 2.1, 19, 0.171, 2.3, 0.0617, 1.4, -40, -0.0071],
  ['p2', 68, 56, 64, 78, 0.0286, 4.05, 13, 0.233, 4.1, 0.0524, 2.9, 65, 0.0053],
  ['p2', 56, 64, 86, 72, -0.0473, 1.05, 18, 0.149, 5.6, 0.0812, 4.3, -110, -0.0104],
  ['p3', 64, 50, 76, 86, 0.0231, 3.3, 21, 0.191, 0.9, 0.0463, 5.7, 28, 0.0067],
  ['p3', 48, 54, 94, 80, -0.0392, 5.15, 15, 0.259, 3.4, 0.0689, 0.8, -150, -0.0083],
  ['p4', 72, 15, 78, 66, 0.0347, 0.8, 18, 0.181, 1.5, 0.0571, 2.2, 35, 0.0117],
  ['p4', 64, 12, 90, 76, -0.0269, 2.55, 14, 0.221, 3.9, 0.0643, 3.6, -70, -0.0139],
  ['p4', 76, 17, 68, 84, 0.0414, 4.6, 22, 0.157, 5.2, 0.0497, 5.1, 100, 0.0091],
  ['p1', 56, 11, 92, 70, -0.0311, 1.7, 17, 0.241, 0.3, 0.0759, 1.1, -25, -0.0126],
  ['p4', 68, 14, 84, 96, 0.0253, 3.85, 12, 0.199, 2.7, 0.0538, 4.8, 80, 0.0078],
  ['p1', 60, 13, 100, 78, -0.0438, 5.4, 20, 0.167, 4.5, 0.0703, 0.3, -135, -0.0109],
  ['p5', 22, 19, 80, 70, 0.0561, 0.45, 24, 0.293, 1.1, 0.101, 3.2, 0, 0],
  ['p5', 18, 21, 96, 84, -0.0487, 2.95, 19, 0.317, 3.6, 0.0917, 5.4, 0, 0],
  ['p5', 20, 16, 66, 92, 0.0523, 4.85, 26, 0.271, 5.8, 0.113, 1.7, 0, 0],
  ['p5', 16, 18, 106, 76, -0.0596, 1.35, 17, 0.347, 2.4, 0.0851, 4.1, 0, 0],
  ['p5', 24, 20, 88, 102, 0.0449, 3.6, 22, 0.229, 0.5, 0.0983, 2.6, 0, 0],
];

/**
 * Builds the light pools inside `group`, draws one finished frame synchronously,
 * then animates on rAF unless the viewer asked for reduced motion.
 * `idPrefix` must match the MembraneDefs namespace, because two membranes are
 * mounted at once while the user is talking to the ninja.
 * Returns the cleanup to run on unmount.
 */
export const startMembrane = (group: SVGGElement, idPrefix = 'mem'): (() => void) => {
  const bodyEl = group.querySelector<SVGPathElement>('.mem-body');
  const midEl = group.querySelector<SVGPathElement>('.mem-mid');
  const poolG = group.querySelector<SVGGElement>('.mem-pools');
  if (!bodyEl || !midEl || !poolG) return () => {};

  const drawBody = shell(bodyEl, 96, 134, BODY_WAVES, 0);
  const drawMid = shell(midEl, 72, 103, MID_WAVES, 1.9);

  const pools = POOLS.map((p) => {
    const el = document.createElementNS(NS, 'ellipse');
    el.setAttribute('cx', '0');
    el.setAttribute('cy', '0');
    el.setAttribute('rx', String(p[1]));
    el.setAttribute('ry', String(p[2]));
    el.setAttribute('fill', `url(#${idPrefix}-${p[0]})`);
    poolG.appendChild(el);
    return { el, p };
  });

  const drawPools = (t: number) => {
    for (const { el, p } of pools) {
      // Slow elliptical orbit + a faster Lissajous epicycle: a wander that
      // never retraces the same path.
      const a = p[5] * t + p[6];
      const b = p[8] * t + p[9];
      const x = C + p[3] * Math.cos(a) + p[7] * Math.cos(b);
      const y = C + p[4] * Math.sin(a) + p[7] * Math.sin(b * 1.37 + 0.9);
      const sx = 1 + 0.22 * Math.sin(p[10] * t + p[11]);
      const sy = 1 + 0.17 * Math.sin(p[10] * 1.61 * t + p[11] * 0.7 + 2.1);
      const rot = p[12] + p[13] * t * 57.2958;
      el.setAttribute(
        'transform',
        `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot.toFixed(1)}) scale(${sx.toFixed(3)} ${sy.toFixed(3)})`,
      );
    }
  };

  const render = (t: number) => {
    drawBody(t * SHELL_SPEED);
    drawMid(t * SHELL_SPEED);
    drawPools(t * POOL_SPEED);
  };

  // First frame drawn synchronously, so the membrane is never blank and a
  // reduced-motion viewer simply keeps this frame as a finished still.
  render(6.1);

  let still = false;
  try {
    still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    still = false;
  }

  let raf = 0;
  if (!still) {
    const tick = (ts: number) => {
      render(ts / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  return () => {
    if (raf) cancelAnimationFrame(raf);
    while (poolG.firstChild) poolG.removeChild(poolG.firstChild);
  };
};
