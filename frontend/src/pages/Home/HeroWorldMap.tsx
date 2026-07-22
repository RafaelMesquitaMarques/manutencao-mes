import { useEffect, useState } from 'react';
import api from '../../api/axios';
import { usePlantStore } from '../../store/plantStore';
import { AMERICAS_LANDMASS_PATH } from './americasLandmass';
import './HeroWorldMap.css';

// Holographic dot-matrix Americas for the Home hero. Sits between the
// greeting card background and the NeuralHud (banner < map < radar).
// Real Natural Earth coastlines (see americasLandmass.ts), equirectangular
// projection with standard parallel 45°N; frame lon -170..-35, lat 84..6 —
// plant beacons projected with px/py below share the same frame. The frame
// (and the svg layout box) covers North America only: South America is drawn
// past the viewBox and shows through overflow:visible (.hwm-map), so the
// continent continues south without moving the layout an inch.
const LON0 = -170;
const LON1 = -35;
const LAT0 = 84;
const LAT1 = 6;
const W = 900;
const H = 735;
const px = (lon: number) => ((lon - LON0) / (LON1 - LON0)) * W;
const py = (lat: number) => ((LAT0 - lat) / (LAT0 - LAT1)) * H;


interface PlantRow {
  id: string;
  code: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
}

interface Beacon {
  plantId: string;
  code: string;
  name: string;
  x: number;
  y: number;
  active: boolean;
  clustered: boolean;
}

export default function HeroWorldMap({
  activePlantId,
  className,
}: {
  activePlantId?: string | null;
  className?: string;
}) {
  const [plants, setPlants] = useState<PlantRow[]>([]);
  const memberships = usePlantStore((s) => s.memberships);
  const setActivePlant = usePlantStore((s) => s.setActivePlant);

  // Same semantics as the header plant switcher: swap the context, then hard
  // reload so no page state, filters or cached lists survive across plants.
  const openPlant = (plantId: string) => {
    if (plantId === activePlantId) return;
    if (!memberships.some((m) => m.plant_id === plantId)) return;
    setActivePlant(plantId);
    window.location.reload();
  };

  useEffect(() => {
    let alive = true;
    api
      .get<PlantRow[] | { items: PlantRow[] }>('/api/plants/')
      .then((r) => {
        if (!alive) return;
        const rows = Array.isArray(r.data) ? r.data : (r.data?.items ?? []);
        setPlants(rows.filter((p) => p.active !== false && p.latitude != null && p.longitude != null));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // One beacon per plant. Plants that project onto (nearly) the same pixel
  // (Saint-Jérôme and Mirabel are ~1px apart at this scale) stay distinct
  // dots: the cluster fans out vertically around the shared spot, keeping the
  // real north→south order (northernmost plant gets the top dot).
  const clusters: PlantRow[][] = [];
  for (const p of plants) {
    const x = px(p.longitude as number);
    const y = py(p.latitude as number);
    const near = clusters.find((c) =>
      c.some((q) => Math.hypot(px(q.longitude as number) - x, py(q.latitude as number) - y) < 26)
    );
    if (near) near.push(p);
    else clusters.push([p]);
  }
  const SPREAD = 34;
  const beacons: Beacon[] = clusters.flatMap((cluster) => {
    const cx = cluster.reduce((s, p) => s + px(p.longitude as number), 0) / cluster.length;
    const cy = cluster.reduce((s, p) => s + py(p.latitude as number), 0) / cluster.length;
    return [...cluster]
      .sort((a, b) => (b.latitude as number) - (a.latitude as number) || a.code.localeCompare(b.code))
      .map((p, i) => ({
        plantId: p.id,
        code: p.code,
        name: p.name,
        x: cx,
        y: cy + (i - (cluster.length - 1) / 2) * SPREAD,
        active: p.id === activePlantId,
        clustered: cluster.length > 1,
      }));
  });

  // Glimmer run: a bright dot leaves the southernmost beacon of the eastern
  // cluster (Mirabel), flies to the farthest plant first and hops back through
  // the nearer ones (QM → NL → QS today), on a Catmull-Rom spline that starts
  // and ends exactly on the beacons.
  const shootingPath = (() => {
    if (beacons.length < 2) return '';
    const start = [...beacons].sort((a, b) => b.x - a.x || b.y - a.y)[0];
    const rest = beacons
      .filter((b) => b !== start)
      .sort(
        (a, b) =>
          Math.hypot(b.x - start.x, b.y - start.y) - Math.hypot(a.x - start.x, a.y - start.y)
      );
    const pts = [start, ...rest].map((b) => ({ x: b.x, y: b.y }));
    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(i - 1, 0)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(i + 2, pts.length - 1)];
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }
    return d;
  })();

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={`hwm-map${className ? ` ${className}` : ''}`} aria-hidden="true">
      <defs>
        <pattern id="hwm-dots" width="7" height="7" patternUnits="userSpaceOnUse">
          <circle cx="3.5" cy="3.5" r="1.7" fill="#22d3ee" />
        </pattern>
      </defs>
      <g opacity="0.5">
        <path d={AMERICAS_LANDMASS_PATH} fill="url(#hwm-dots)" fillOpacity="0.55" />
        <path d={AMERICAS_LANDMASS_PATH} fill="none" stroke="#22d3ee" strokeOpacity="0.3" strokeWidth="1.5" strokeLinejoin="round" />
      </g>
      {beacons.map((b) => {
        // Mouse-only shortcut into the plant's context; the header plant
        // switcher stays the accessible path (the svg is aria-hidden).
        const clickable = !b.active && memberships.some((m) => m.plant_id === b.plantId);
        return (
          <g
            key={b.plantId}
            className={`hwm-beacon${clickable ? ' hwm-beacon--click' : ''}`}
            pointerEvents="all"
            onClick={clickable ? () => openPlant(b.plantId) : undefined}
          >
            <title>{b.name}</title>
            {/* Clustered dots sit 34px apart — shrink the hit halo so each
                beacon keeps its own click target. */}
            <circle cx={b.x} cy={b.y} r={b.clustered ? 16 : 28} fill="transparent" stroke="none" />
            <circle cx={b.x} cy={b.y} r="18" fill="none" stroke="#5eead4" strokeOpacity="0.6" strokeWidth="2" className="hwm-ping" />
            {/* The active plant reads by ring glow alone — every dot keeps the
                same size. The halo breathes slowly (see .hwm-halo). */}
            {b.active && (
              <circle cx={b.x} cy={b.y} r="13" fill="none" stroke="#5eead4" strokeWidth="6" className="hwm-halo" />
            )}
            <circle cx={b.x} cy={b.y} r="13" fill="none" stroke="#5eead4" strokeOpacity={b.active ? 1 : 0.55} strokeWidth={b.active ? 2 : 1.5} />
            <circle cx={b.x} cy={b.y} r="5.5" fill="#5eead4" />
            <text
              x={b.x + 24}
              y={b.y - 4}
              fill="#8be9d8"
              fillOpacity="0.9"
              fontSize="20"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              letterSpacing="2"
            >
              {b.code}
            </text>
          </g>
        );
      })}
      {shootingPath && (
        // Every ~10s (2.4s flight + 7.6s idle — SMIL re-arms itself through
        // begin="...end+7.6s") a glowing dot travels the beacon circuit. The
        // group's static opacity is 0, so it only shows mid-flight.
        <g opacity="0" pointerEvents="none">
          <circle r="2.3" fill="#a5f3fc" fillOpacity="0.3" />
          <circle r="1" fill="#f0fdff" />
          <animateMotion id="hwmStarMove" path={shootingPath} dur="2.4s" begin="2s;hwmStarMove.end+7.6s" />
          <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.08;0.9;1" dur="2.4s" begin="2s;hwmStarMove.end+7.6s" />
        </g>
      )}
    </svg>
  );
}
