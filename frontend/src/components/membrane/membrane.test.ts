import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startMembrane } from './membrane';

// The membrane only animates on requestAnimationFrame, and rAF is stalled in
// every headless/hidden context we can drive this app from (preview pane,
// headless Chrome) — so its movement is asserted here instead, by stepping a
// fake clock over the real module.

type Attrs = Record<string, string>;

class FakeEl {
  attrs: Attrs = {};
  children: FakeEl[] = [];
  constructor(public tagName: string, public className = '') {}
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  appendChild(c: FakeEl) { this.children.push(c); return c; }
  removeChild(c: FakeEl) { this.children = this.children.filter((x) => x !== c); return c; }
  get firstChild() { return this.children[0] ?? null; }
  querySelector(sel: string) {
    const want = sel.replace('.', '');
    const walk = (el: FakeEl): FakeEl | null => {
      for (const c of el.children) {
        if (c.className === want) return c;
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this);
  }
}

let frames: ((ts: number) => void)[] = [];
let cancelled: number[] = [];
let group: FakeEl;
let body: FakeEl;
let mid: FakeEl;
let pools: FakeEl;

const g = globalThis as unknown as {
  document: { createElementNS: (ns: string, tag: string) => FakeEl };
  window: { matchMedia: (q: string) => { matches: boolean } };
  requestAnimationFrame: (cb: (ts: number) => void) => number;
  cancelAnimationFrame: (id: number) => void;
};

/** Runs the pending rAF callback at `seconds`, the way a real clock would. */
const step = (seconds: number) => {
  const pending = frames;
  frames = [];
  for (const cb of pending) cb(seconds * 1000);
};

const points = (d: string) => {
  const n = (d.match(/-?[\d.]+/g) ?? []).map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
  return out;
};
const radii = (d: string) => points(d).map(([x, y]) => Math.hypot(x - 240, y - 240));
/** Mean per-point movement of the outline between two frames, in px. */
const drift = (a: string, b: string) => {
  const p = points(a), q = points(b);
  const n = Math.min(p.length, q.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.hypot(p[i][0] - q[i][0], p[i][1] - q[i][1]);
  return s / n;
};

beforeEach(() => {
  frames = [];
  cancelled = [];
  body = new FakeEl('path', 'mem-body');
  mid = new FakeEl('path', 'mem-mid');
  pools = new FakeEl('g', 'mem-pools');
  group = new FakeEl('g', 'mem-layer');
  group.appendChild(body);
  group.appendChild(mid);
  group.appendChild(pools);

  g.document = { createElementNS: (_ns, tag) => new FakeEl(tag) };
  g.window = { matchMedia: () => ({ matches: false }) };
  g.requestAnimationFrame = (cb) => frames.push(cb);
  g.cancelAnimationFrame = (id) => { cancelled.push(id); };
});

afterEach(() => {
  frames = [];
});

describe('startMembrane', () => {
  it('draws a finished first frame synchronously, before any rAF runs', () => {
    const stop = startMembrane(group as unknown as SVGGElement, 'test');
    expect(body.getAttribute('d')).toMatch(/^M[\d.]+ [\d.]+L/);
    expect(radii(body.getAttribute('d')!)).toHaveLength(96);
    expect(radii(mid.getAttribute('d')!)).toHaveLength(72);
    stop();
  });

  it('builds the seventeen light pools and removes them on cleanup', () => {
    const stop = startMembrane(group as unknown as SVGGElement, 'test');
    expect(pools.children).toHaveLength(17);
    expect(pools.children.every((p) => p.tagName === 'ellipse')).toBe(true);
    expect(pools.children.every((p) => /^url\(#test-p[1-5]\)$/.test(p.getAttribute('fill')!))).toBe(true);
    stop();
    expect(pools.children).toHaveLength(0);
    expect(cancelled).toHaveLength(1);
  });

  it('keeps deforming: every second moves the outline and never repeats a shape', () => {
    const stop = startMembrane(group as unknown as SVGGElement, 'test');
    const shapes: string[] = [];
    for (let s = 0; s <= 30; s++) {
      step(s);
      shapes.push(body.getAttribute('d')!);
    }
    for (let i = 1; i < shapes.length; i++) {
      expect(drift(shapes[i - 1], shapes[i])).toBeGreaterThan(1);
    }
    expect(new Set(shapes).size).toBe(shapes.length);
    stop();
  });

  it('stays clear of the ninja and of the KPI ring at r=168', () => {
    const stop = startMembrane(group as unknown as SVGGElement, 'test');
    let lo = Infinity, hi = -Infinity;
    for (let s = 0; s < 900; s += 1) {
      step(s);
      for (const r of radii(body.getAttribute('d')!)) {
        if (r < lo) lo = r;
        if (r > hi) hi = r;
      }
    }
    expect(lo).toBeGreaterThan(90);   // the head is clipped at r=78
    expect(hi).toBeLessThan(165);     // KPI nodes sit at r=168
    stop();
  });

  it('moves the light pools independently of the shells', () => {
    const stop = startMembrane(group as unknown as SVGGElement, 'test');
    step(0);
    const first = pools.children.map((p) => p.getAttribute('transform')!);
    step(3);
    const later = pools.children.map((p) => p.getAttribute('transform')!);
    expect(later.every((t, i) => t !== first[i])).toBe(true);
    stop();
  });

  it('honours prefers-reduced-motion with a drawn still frame and no loop', () => {
    g.window = { matchMedia: () => ({ matches: true }) };
    const stop = startMembrane(group as unknown as SVGGElement, 'test');
    expect(body.getAttribute('d')).toMatch(/^M[\d.]/);
    expect(pools.children).toHaveLength(17);
    expect(frames).toHaveLength(0);
    stop();
  });

  it('is inert when the group is missing its parts', () => {
    const empty = new FakeEl('g', 'mem-layer');
    const stop = startMembrane(empty as unknown as SVGGElement, 'test');
    expect(frames).toHaveLength(0);
    expect(() => stop()).not.toThrow();
  });
});
