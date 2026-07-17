import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { LucideIcon } from 'lucide-react';
import './NeuralHud.css';

export interface HudNode {
  to?: string;
  label: string;
  value?: string;
  icon: LucideIcon;
  img?: string;
}

interface NeuralHudProps {
  nodes: HudNode[];
  /** Route opened when the core is clicked (omit when the user lacks access). */
  coreTo?: string;
  /** Hover bubble text shown over the core; only rendered when coreTo is set. */
  coreHint?: string;
}

// Design-space constants: the stage is laid out at a fixed size and scaled to
// fit the card, so the SVG viewBox math and pixel label offsets stay exact.
const STAGE_W = 520;
const STAGE_H = 372;
const HUD = 344;
const VB = 480;
const CX = 240;
const R_NODE = 168;
const R_LINE_IN = 90;
const R_LINE_OUT = 159;

const polar = (deg: number, r: number): [number, number] => {
  const rad = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(rad), CX + r * Math.sin(rad)];
};

const nodeAngle = (i: number, n: number) => -90 + (i * 360) / Math.max(n, 1);

// Anchor the HTML label on the correct side of its node so text always grows
// away from the ring, whatever the node count.
const labelPlacement = (deg: number, x: number, y: number) => {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const style: CSSProperties = { left: `${(x / VB) * 100}%`, top: `${(y / VB) * 100}%` };
  let align: 'left' | 'right' | 'center';
  if (Math.abs(c) < 0.35) {
    align = 'center';
    style.transform = s < 0 ? 'translate(-50%, calc(-100% - 13px))' : 'translate(-50%, 15px)';
  } else if (c > 0) {
    align = 'left';
    style.transform =
      s < -0.35 ? 'translate(11px, calc(-100% - 5px))'
      : s > 0.35 ? 'translate(11px, 7px)'
      : 'translate(14px, -50%)';
  } else {
    align = 'right';
    style.transform =
      s < -0.35 ? 'translate(calc(-100% - 11px), calc(-100% - 5px))'
      : s > 0.35 ? 'translate(calc(-100% - 11px), 7px)'
      : 'translate(calc(-100% - 14px), -50%)';
  }
  style.textAlign = align;
  return { style, align };
};

const SVG_NS = 'http://www.w3.org/2000/svg';

const NeuralHud = ({ nodes, coreTo, coreHint }: NeuralHudProps) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [hovered, setHovered] = useState<number | null>(null);
  const [coreHover, setCoreHover] = useState(false);
  const [scale, setScale] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const packetsRef = useRef<SVGGElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);

  const n = nodes.length;
  const positions = nodes.map((_, i) => {
    const deg = nodeAngle(i, n);
    return { deg, p: polar(deg, R_NODE), s: polar(deg, R_LINE_IN), e: polar(deg, R_LINE_OUT) };
  });

  // Fit the fixed-size stage into whatever width the host gives us. Measure
  // synchronously on mount, then track resizes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const apply = (w: number) => {
      if (w > 0) setScale(Math.min(1, w / STAGE_W));
    };
    apply(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      apply(entries[0]?.contentRect.width ?? 0);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Data packets along the spokes + sparks rising from the projection base.
  useEffect(() => {
    const g = packetsRef.current;
    if (!g || n === 0) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const ends = nodes.map((_, i) => {
      const deg = nodeAngle(i, n);
      return { s: polar(deg, R_LINE_IN), p: polar(deg, R_NODE) };
    });
    type Packet = { el: SVGCircleElement; i: number; ph: number; d: number; rev: boolean };
    type Spark = { el: SVGCircleElement; dx: number; ph: number; d: number };
    const packets: Packet[] = [];
    const sparks: Spark[] = [];
    const mkPacket = (i: number, ph: number, d: number, rev: boolean) => {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('r', '2.4');
      c.setAttribute('fill', rev ? '#60a5fa' : '#67e8f9');
      g.appendChild(c);
      packets.push({ el: c, i, ph, d, rev });
    };
    nodes.forEach((_, i) => mkPacket(i, i * 0.35, 2.6 + (i % 3) * 0.5, false));
    nodes.forEach((_, i) => {
      if (i % 2 === 0 && i / 2 < 4) mkPacket(i, 0.2 + i * 0.4, 2.2 + (i % 4) * 0.3, true);
    });
    [[-34, 0, 2.6], [-15, 0.45, 3.1], [4, 0.8, 2.3], [20, 0.25, 3.4], [36, 0.6, 2.8]].forEach(
      ([dx, ph, d]) => {
        const c = document.createElementNS(SVG_NS, 'circle');
        c.setAttribute('r', '1.6');
        c.setAttribute('fill', '#7ff3ff');
        g.appendChild(c);
        sparks.push({ el: c, dx, ph, d });
      },
    );

    let raf = 0;
    const frame = (ts: number) => {
      const time = ts / 1000;
      for (const pk of packets) {
        let u = (time / pk.d + pk.ph) % 1;
        if (pk.rev) u = 1 - u;
        const { s, p } = ends[pk.i];
        pk.el.setAttribute('cx', String(s[0] + (p[0] - s[0]) * u * 0.92));
        pk.el.setAttribute('cy', String(s[1] + (p[1] - s[1]) * u * 0.92));
        pk.el.setAttribute('opacity', (Math.sin(Math.PI * u) * 0.9).toFixed(2));
      }
      for (const sp of sparks) {
        const v = (time / sp.d + sp.ph) % 1;
        sp.el.setAttribute('cx', String(CX + sp.dx + Math.sin(v * 6.28 + sp.ph * 7) * 4));
        sp.el.setAttribute('cy', String(312 - v * 118));
        sp.el.setAttribute('opacity', (Math.sin(Math.PI * v) * 0.65).toFixed(2));
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      while (g.firstChild) g.removeChild(g.firstChild);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);

  // Fake telemetry readout, updated outside the React render cycle.
  useEffect(() => {
    const id = setInterval(() => {
      if (readoutRef.current) {
        readoutRef.current.textContent = `SYNC ${(99.9 + Math.random() * 0.09).toFixed(2)}%`;
      }
    }, 900);
    return () => clearInterval(id);
  }, []);

  const hoverP = hovered != null && positions[hovered] ? positions[hovered].p : null;

  return (
    <div
      ref={containerRef}
      className="nhud-root relative w-full"
      style={{ height: STAGE_H * scale, perspective: 900 }}
    >
      <div
        className="absolute top-0 left-1/2"
        style={{ width: STAGE_W, height: STAGE_H, transform: `translateX(-50%) scale(${scale})`, transformOrigin: 'top center' }}
      >
        <div className="relative mx-auto" style={{ width: HUD, height: HUD }}>
          <svg viewBox={`0 0 ${VB} ${VB}`} className="block w-full h-full" aria-hidden="true">
            <defs>
              <filter id="nhud-glow" x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="3.2" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <linearGradient id="nhud-sweep-grad" gradientUnits="userSpaceOnUse" x1="342" y1="102" x2="250" y2="176">
                <stop offset="0" stopColor="#22d3ee" stopOpacity="0.55" />
                <stop offset="1" stopColor="#22d3ee" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="nhud-beam-grad" gradientUnits="userSpaceOnUse" x1="240" y1="314" x2="240" y2="185">
                <stop offset="0" stopColor="#22d3ee" stopOpacity="0.2" />
                <stop offset="1" stopColor="#22d3ee" stopOpacity="0" />
              </linearGradient>
              <clipPath id="nhud-clip">
                <circle cx="240" cy="240" r="78" />
                <rect x="172" y="262" width="136" height="56" />
              </clipPath>
            </defs>

            <line x1="240" y1="8" x2="240" y2="24" stroke="#f87171" strokeOpacity="0.55" strokeWidth="1.2" />
            <line x1="240" y1="456" x2="240" y2="472" stroke="#f87171" strokeOpacity="0.3" strokeWidth="1" />
            <line x1="8" y1="240" x2="24" y2="240" stroke="#22d3ee" strokeOpacity="0.3" />
            <line x1="456" y1="240" x2="472" y2="240" stroke="#22d3ee" strokeOpacity="0.3" />

            <circle className="nhud-a1" cx="240" cy="240" r="214" fill="none" stroke="rgba(103,232,249,.14)" strokeDasharray="3 5" />
            <circle className="nhud-a2" cx="240" cy="240" r="196" fill="none" stroke="rgba(34,211,238,.28)" strokeWidth="1.5" strokeDasharray="40 8 12 8" />
            <circle className="nhud-a5" cx="240" cy="240" r="178" fill="none" stroke="rgba(94,234,212,.16)" strokeWidth="7" strokeDasharray="1.5 7.4" />
            <circle className="nhud-a3" cx="240" cy="240" r="196" fill="none" stroke="#22d3ee" strokeWidth="3" strokeLinecap="round" strokeDasharray="90 1141" opacity="0.8" filter="url(#nhud-glow)" />
            <circle className="nhud-a4" cx="240" cy="240" r="214" fill="none" stroke="#60a5fa" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="50 1294" opacity="0.7" />
            <circle className="nhud-a6" cx="240" cy="240" r="120" fill="none" stroke="rgba(148,163,184,.16)" strokeDasharray="2 4" />
            <circle className="nhud-a2" cx="240" cy="240" r="132" fill="none" stroke="rgba(125,211,252,.32)" strokeWidth="1.2" strokeDasharray="160 100 60 509" />
            <g className="nhud-a7">
              <path d="M240 240 L240 78 A162 162 0 0 1 342 102 Z" fill="url(#nhud-sweep-grad)" opacity="0.16" />
            </g>
            <g className="nhud-a2">
              <path d="M240 20 l5 9 h-10 z" fill="#22d3ee" opacity="0.6" />
              <path d="M240 460 l5 -9 h-10 z" fill="#22d3ee" opacity="0.35" />
            </g>

            {positions.map(({ p, s, e }, i) => (
              <g
                key={`${i}-${nodes[i].label}`}
                className={`nhud-node${hovered === i ? ' on' : ''}`}
                style={{ cursor: nodes[i].to ? undefined : 'default' }}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => { const to = nodes[i].to; if (to) navigate(to); }}
              >
                <line className="nhud-ln" x1={s[0]} y1={s[1]} x2={e[0]} y2={e[1]} />
                <circle cx={p[0]} cy={p[1]} r="16" fill="transparent" />
                <circle className="nhud-rg" cx={p[0]} cy={p[1]} r="9" />
                <circle className="nhud-dot" cx={p[0]} cy={p[1]} r="3.5" />
              </g>
            ))}

            <polygon points="216,314 264,314 284,186 196,186" fill="url(#nhud-beam-grad)" />
            <g ref={packetsRef} />
            <circle className={`nhud-a8 nhud-corering${coreHover ? ' on' : ''}`} cx="240" cy="240" r="86" fill="none" stroke="rgba(34,211,238,.3)" strokeDasharray="10 6" />
            <g className={`nhud-core${coreHover ? ' on' : ''}`}>
              <image
                href="/core-hud.png"
                x="162"
                y="162"
                width="156"
                height="156"
                clipPath="url(#nhud-clip)"
                preserveAspectRatio="xMidYMid slice"
              />
            </g>
            <ellipse cx="240" cy="316" rx="72" ry="13" fill="rgba(34,211,238,.07)" />
            <ellipse className="nhud-p1" cx="240" cy="316" rx="72" ry="13" fill="none" stroke="#22d3ee" strokeOpacity="0.6" strokeWidth="1.5" strokeDasharray="7 5" filter="url(#nhud-glow)" />
            <ellipse className="nhud-p2" cx="240" cy="316" rx="54" ry="9.5" fill="none" stroke="rgba(103,232,249,.35)" strokeWidth="1" strokeDasharray="2 5" />
            <ellipse className="nhud-p3" cx="240" cy="316" rx="88" ry="16.5" fill="none" stroke="rgba(96,165,250,.28)" strokeWidth="1" strokeDasharray="1 6" />

            {hoverP && (
              <g transform={`translate(${hoverP[0]} ${hoverP[1]})`}>
                <g className="nhud-reticle" stroke="#f87171" strokeWidth="1.6" fill="none">
                  <path d="M -15 -7 L -15 -15 L -7 -15" />
                  <path d="M 7 -15 L 15 -15 L 15 -7" />
                  <path d="M 15 7 L 15 15 L 7 15" />
                  <path d="M -7 15 L -15 15 L -15 7" />
                </g>
              </g>
            )}

          </svg>

          {coreTo && (
            <div
              className="nhud-core-hit"
              role="link"
              tabIndex={0}
              aria-label={coreHint}
              onMouseEnter={() => setCoreHover(true)}
              onMouseLeave={() => setCoreHover(false)}
              onClick={() => navigate(coreTo)}
              onKeyDown={(e) => { if (e.key === 'Enter') navigate(coreTo); }}
            />
          )}

          {coreTo && coreHint && (
            <div className={`nhud-bubble${coreHover ? ' show' : ''}`} aria-hidden={!coreHover}>
              {coreHint}
            </div>
          )}

          {positions.map(({ deg, p }, i) => {
            const node = nodes[i];
            const { style, align } = labelPlacement(deg, p[0], p[1]);
            const Icon = node.icon;
            const className = `nhud-lb lb-${align}${hovered === i ? ' on' : ''}`;
            const handlers = {
              onMouseEnter: () => setHovered(i),
              onMouseLeave: () => setHovered(null),
            };
            const content = (
              <>
                <span className="nhud-lb-name">
                  {node.img
                    ? <img src={node.img} alt="" className="w-[11px] h-[11px] object-contain" />
                    : <Icon size={11} />}
                  {node.label}
                </span>
                {node.value && <span className="nhud-lb-value">{node.value}</span>}
              </>
            );
            return node.to ? (
              <Link key={`${i}-${node.label}`} to={node.to} className={className} style={style} {...handlers}>
                {content}
              </Link>
            ) : (
              <span key={`${i}-${node.label}`} className={className} style={{ ...style, cursor: 'default' }} {...handlers}>
                {content}
              </span>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 px-1" style={{ marginTop: 6 }}>
          <span className="nhud-status">
            ▸ {hovered != null && nodes[hovered] ? nodes[hovered].label : t('hud.selectModule')}
          </span>
          <span ref={readoutRef} className="nhud-readout">SYNC 99.97%</span>
        </div>
      </div>
    </div>
  );
};

export default NeuralHud;
