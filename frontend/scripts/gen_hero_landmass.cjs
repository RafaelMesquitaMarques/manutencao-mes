// Generates src/pages/Home/americasLandmass.ts — the dot-matrix Americas
// landmass behind the Home hero (see HeroWorldMap.tsx).
//
// Run from frontend/:
//   npm i --no-save world-atlas topojson-client
//   node scripts/gen_hero_landmass.cjs
// (optional visual proof: also `npm i --no-save @resvg/resvg-js` → preview.png)
//
// Real Natural Earth 110m coastlines merged into one landmass, equirectangular
// projection with standard parallel 45N. The PROJECTION FRAME (lon -170..-35 /
// lat 84..6 → 900x735) matches HeroWorldMap.tsx and defines where North
// America sits — never change it, or every plant beacon and the hero layout
// moves. South America is a CONTINUATION past that frame: rings that live
// entirely north of lat 6 (Greenland, Arctic + Caribbean islands) are clipped
// exactly like the original NA-only map and stay byte-identical; only rings
// crossing lat 6 (the mainland, via Darién) or south of it use the extended
// clip window (lon to -33.5 for Brazil's east tip, lat to -57 for Cape Horn,
// keeping Antarctica out). The component keeps viewBox 900x735 with
// overflow:visible, so the extra land bleeds below without moving anything.
const fs = require('fs');
const path = require('path');
const topojson = require('topojson-client');

const topo = JSON.parse(fs.readFileSync(require.resolve('world-atlas/countries-110m.json'), 'utf8'));

// Projection frame — must match HeroWorldMap.tsx exactly.
const LON0 = -170, LON1 = -35, LAT0 = 84, LAT1 = 6;
const W = 900;
const H = 735;
const px = (lon) => ((lon - LON0) / (LON1 - LON0)) * W;
const py = (lat) => ((LAT0 - lat) / (LAT0 - LAT1)) * H;

// Extended clip bounds for the southern continuation (projection unchanged —
// px()/py() extrapolate linearly past the frame).
const S_LON1 = -33.5; // east of Brazil's tip (-34.8)
const S_LAT1 = -57;   // south of Cape Horn (-55.98); keeps Antarctica out

const WANT = new Set([
  'United States of America', 'Canada', 'Mexico', 'Greenland', 'Cuba', 'Haiti',
  'Dominican Rep.', 'Jamaica', 'Bahamas', 'Puerto Rico', 'Guatemala', 'Belize',
  'Honduras', 'El Salvador', 'Nicaragua', 'Costa Rica', 'Panama', 'Colombia',
  'Venezuela', 'Ecuador', 'Guyana', 'Suriname', 'Brazil', 'Trinidad and Tobago',
  'Peru', 'Bolivia', 'Chile', 'Argentina', 'Paraguay', 'Uruguay',
  'Falkland Is.',
  'France', // French Guiana — metropolitan France is far outside the clip
]);
const geoms = topo.objects.countries.geometries.filter((g) => WANT.has(g.properties.name));
console.error('matched countries:', geoms.length, '/ wanted:', WANT.size);
const found = new Set(geoms.map((g) => g.properties.name));
for (const w of WANT) if (!found.has(w)) console.error('  MISSING name:', w);

const merged = topojson.merge(topo, geoms); // MultiPolygon, borders dissolved

// Sutherland–Hodgman clip of a ring against a lon/lat rect.
function clipRing(ring, lon1, lat1) {
  const edges = [
    { inside: (p) => p[0] >= LON0, inter: (a, b) => lerpLon(a, b, LON0) },
    { inside: (p) => p[0] <= lon1, inter: (a, b) => lerpLon(a, b, lon1) },
    { inside: (p) => p[1] >= lat1, inter: (a, b) => lerpLat(a, b, lat1) },
    { inside: (p) => p[1] <= LAT0, inter: (a, b) => lerpLat(a, b, LAT0) },
  ];
  let pts = ring;
  for (const e of edges) {
    if (pts.length === 0) break;
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      const curIn = e.inside(cur);
      const prevIn = e.inside(prev);
      if (curIn) {
        if (!prevIn) out.push(e.inter(prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(e.inter(prev, cur));
      }
    }
    pts = out;
  }
  return pts;
}
function lerpLon(a, b, lon) {
  const t = (lon - a[0]) / (b[0] - a[0]);
  return [lon, a[1] + t * (b[1] - a[1])];
}
function lerpLat(a, b, lat) {
  const t = (lat - a[1]) / (b[1] - a[1]);
  return [a[0] + t * (b[0] - a[0]), lat];
}

// Douglas–Peucker for closed rings, in projected px space. GeoJSON rings are
// closed (first == last), which degenerates the naive root segment, so anchor
// the recursion on the point farthest from pts[0].
function dp(ring, tol) {
  let pts = ring;
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) {
    pts = pts.slice(0, -1);
  }
  if (pts.length < 3) return pts;
  let far = 1, best = -1;
  for (let i = 1; i < pts.length; i++) {
    const d0 = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d0 > best) { best = d0; far = i; }
  }
  const points = pts.concat([pts[0]]);
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[far] = keep[points.length - 1] = true;
  const stack = [[0, far], [far, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    const [x1, y1] = points[s], [x2, y2] = points[e];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1e-9;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs(dy * points[i][0] - dx * points[i][1] + x2 * y1 - y2 * x1) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out = points.filter((_, i) => keep[i]);
  out.pop(); // drop the duplicated closing point — the SVG path closes with Z
  return out;
}

function ringArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

const TOL = 1.2;      // px simplification tolerance
const MIN_AREA = 55;  // px² — drop islets that read as noise at hero scale

const rings = [];
const drop = { clip: 0, dp: 0, area: 0 };
for (const poly of merged.coordinates) {
  for (const ring of poly) {
    const allNorth = ring.every((p) => p[1] >= LAT1);
    const clipped = allNorth ? clipRing(ring, LON1, LAT1) : clipRing(ring, S_LON1, S_LAT1);
    if (clipped.length < 3) { drop.clip++; continue; }
    let pts = clipped.map(([lon, lat]) => [px(lon), py(lat)]);
    pts = dp(pts, TOL);
    if (pts.length < 3) { drop.dp++; continue; }
    if (ringArea(pts) < MIN_AREA) { drop.area++; continue; }
    rings.push(pts);
  }
}
console.error('dropped:', JSON.stringify(drop));
console.error('rings kept:', rings.length, 'total points:', rings.reduce((n, r) => n + r.length, 0));

const all = rings
  .map((r) => 'M' + r.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L') + 'Z')
  .join('');
const maxY = Math.max(...rings.flat().map(([, y]) => y));
const maxX = Math.max(...rings.flat().map(([x]) => x));
console.error('path bytes:', all.length, 'maxX:', maxX.toFixed(1), 'maxY:', maxY.toFixed(1));

// Regression check: how much of the committed path survives a regeneration.
const OUT = path.join(__dirname, '..', 'src', 'pages', 'Home', 'americasLandmass.ts');
if (fs.existsSync(OUT)) {
  const m = fs.readFileSync(OUT, 'utf8').match(/"(M[^"]+)"/);
  if (m) {
    const oldSubs = m[1].split('M').filter(Boolean).map((s) => 'M' + s);
    const same = oldSubs.filter((s) => all.includes(s)).length;
    console.error(`vs committed path: ${same}/${oldSubs.length} subpaths identical`);
  }
}

const header = `// Americas landmass for the Home hero world map.
// Generated from Natural Earth 110m data (world-atlas npm package): countries
// of the Americas merged into one landmass, projected (equirectangular,
// standard parallel 45N) into the 900x735 hero frame (lon -170..-35 /
// lat 84..6), Douglas-Peucker simplified. The landmass intentionally BLEEDS
// past the frame: South America continues below y=735 (down to Cape Horn,
// y~1316) and Brazil's east tip pokes ~2px past x=900 — the component keeps
// viewBox 900x735 and overflow:visible, so North America stays pixel-identical
// while the continent carries on south.
// Regenerate with: node frontend/scripts/gen_hero_landmass.cjs (see header there).
export const AMERICAS_LANDMASS_PATH =
`;
fs.writeFileSync(OUT, header + '  "' + all + '";\n');
console.error('wrote', OUT);

// Optional visual proof (needs @resvg/resvg-js): full extended extent with the
// old frame bottom marked.
try {
  const { Resvg } = require('@resvg/resvg-js');
  const PH = 1340;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${PH}" width="${W}" height="${PH}">
<rect width="${W}" height="${PH}" fill="#0d1421"/>
<line x1="0" y1="${H}" x2="${W}" y2="${H}" stroke="#f43f5e" stroke-opacity="0.5" stroke-dasharray="6 6"/>
<defs><pattern id="d" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="3.5" cy="3.5" r="1.7" fill="#22d3ee"/></pattern></defs>
<g opacity="0.5"><path d="${all}" fill="url(#d)" fill-opacity="0.55"/><path d="${all}" fill="none" stroke="#22d3ee" stroke-opacity="0.3" stroke-width="1.5"/></g>
</svg>`;
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 760 } }).render().asPng();
  fs.writeFileSync(path.join(__dirname, 'preview.png'), png);
  console.error('preview.png written next to the script');
} catch {
  console.error('(@resvg/resvg-js not installed — skipping preview.png)');
}
