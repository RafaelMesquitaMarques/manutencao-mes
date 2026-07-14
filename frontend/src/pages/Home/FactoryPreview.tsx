import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Map as MapIcon, Star } from 'lucide-react';
import { fetchFactoryMap, setHomeView, type FactoryMapData } from '../../api/factoryMap';
import { fetchPitStopState, type PitStopState } from '../../api/pitStop';
import Factory3D, { SCALE, type M3D, type P3D, type FocusTarget } from '../FactoryMap/Factory3D';
import Spinner from '../../components/ui/Spinner';

const FOV = 45;          // must match the Canvas camera in Factory3D
const REFRESH_MS = 30000; // live statuses follow the map page's slow-poll cadence

/** Bird's-eye framing that fits the whole plant: centre = the machines' bbox
 * centre (props as fallback) — the same point Factory3D freezes as its scene
 * centre — high above it with a slight forward tilt so heights still read as 3D.
 * Returns the centre in MAP PIXELS (cx/cy) plus the camera height y. */
function overviewFrame(machines: M3D[], props: P3D[]): { cx: number; cy: number; y: number } {
  const base = machines.length ? machines : props;
  if (!base.length) return { cx: 0, cy: 0, y: 55 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const b of base) {
    minX = Math.min(minX, b.pos_x); maxX = Math.max(maxX, b.pos_x + b.pos_w);
    minY = Math.min(minY, b.pos_y); maxY = Math.max(maxY, b.pos_y + b.pos_h);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  // fit radius covers EVERYTHING (machines + props) measured from that centre
  let r = 0;
  for (const b of [...machines, ...props]) {
    r = Math.max(
      r,
      Math.abs(b.pos_x - cx), Math.abs(b.pos_x + b.pos_w - cx),
      Math.abs(b.pos_y - cy), Math.abs(b.pos_y + b.pos_h - cy),
    );
  }
  const half = Math.max(r * SCALE, 10);
  const dist = (half / Math.tan((FOV / 2) * (Math.PI / 180))) * 1.18 + 4;
  const y = Math.min(Math.max(dist, 26), 240);
  return { cx, cy, y };
}

/** Home-page window onto the live 3D factory: every equipment (production +
 * auxiliary) of the active plant. The landing shot is the user's favourite saved
 * view (picked here, per plant) or an automatic top-down when none is set.
 * Statuses refresh in the background; clicking anything jumps to the full map. */
export default function FactoryPreview({ plantId }: { plantId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [data, setData] = useState<FactoryMapData | null>(null);
  const [pitStop, setPitStop] = useState<PitStopState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [favoriteId, setFavoriteId] = useState<string | null>(null);
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const nonceRef = useRef(0);
  const initedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    const load = () => fetchFactoryMap(plantId, 'all')
      .then((d) => {
        if (!alive) return;
        setData(d);
        setIsLoading(false);
        // The Pit Stop buffer draws its OF stacks + scoreboard from its own read
        // model — fetch it on the same slow cadence when the plant has the zone.
        if (d.machines.some((m) => m.block_kind === 'pit_stop')) {
          fetchPitStopState(plantId)
            .then((s) => { if (alive) setPitStop(s); })
            .catch(() => { /* keep the last good state */ });
        } else {
          setPitStop(null);
        }
      })
      .catch(() => { if (alive) setIsLoading(false); });
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [plantId]);

  const machines = useMemo<M3D[]>(() => (data?.machines ?? [])
    .filter((m) => m.pos_x != null && m.pos_y != null)
    .map((m) => ({
      id: m.id, name: m.name, status: m.status, technicians: m.technicians,
      stop_reason: m.stop_reason, open_ticket_number: m.open_ticket_number,
      pos_x: m.pos_x as number, pos_y: m.pos_y as number,
      pos_w: m.pos_w ?? 152, pos_h: m.pos_h ?? 64,
      icon_url: m.icon_url, model_url: m.model_url, height_3d: m.height_3d,
      model_scale: m.model_scale, scale_y: m.scale_y, scale_z: m.scale_z,
      rotation_deg: m.rotation_deg, family: m.family, subtype: m.subtype,
      function_label: m.function_label, block_kind: m.block_kind, asset_type: m.asset_type,
      line_stats: m.line_stats, pipeline_ofs: m.pipeline_ofs, pipeline_total: m.pipeline_total,
    })), [data]);

  // Decorative props take the live status of their linked equipment (colour + animation).
  const props3d = useMemo<P3D[]>(() => {
    if (!data) return [];
    const statusById = new Map(data.machines.map((m) => [m.id, m.status]));
    return data.props.map((p) => ({ ...p, status: p.equipment_id ? statusById.get(p.equipment_id) ?? null : null }));
  }, [data]);

  const views = data?.views ?? [];

  // Freeze the automatic top-down as the immediate first frame (before any fly).
  const camRef = useRef<[number, number, number] | null>(null);
  if (camRef.current === null && (machines.length || props3d.length)) {
    const f = overviewFrame(machines, props3d);
    camRef.current = [0, f.y, f.y * 0.22];
  }

  // Build a pose-focus for a favourite view id, or the automatic top-down when null.
  const poseFor = (fav: string | null): FocusTarget => {
    nonceRef.current += 1;
    const v = fav ? views.find((x) => x.id === fav) : null;
    if (v) {
      return {
        kind: 'pose', nonce: nonceRef.current,
        targetPxX: v.target_px_x, targetPxY: v.target_px_y, targetY: v.target_y,
        offsetX: v.offset_x, offsetY: v.offset_y, offsetZ: v.offset_z,
      };
    }
    const f = overviewFrame(machines, props3d);
    return {
      kind: 'pose', nonce: nonceRef.current,
      targetPxX: f.cx, targetPxY: f.cy, targetY: 0,
      offsetX: 0, offsetY: f.y, offsetZ: f.y * 0.22,
    };
  };

  // Apply the saved favourite once, on first load with real content. A favourite
  // flies the camera in from the top-down arrival; no favourite → stay top-down.
  useEffect(() => {
    if (!data || initedRef.current) return;
    if (!machines.length && !props3d.length) return;
    initedRef.current = true;
    setFavoriteId(data.home_view_id);
    if (data.home_view_id && views.some((v) => v.id === data.home_view_id)) {
      setFocus(poseFor(data.home_view_id));
    }
  }, [data, machines, props3d]);  // eslint-disable-line react-hooks/exhaustive-deps

  const chooseFavorite = (fav: string | null) => {
    setFavoriteId(fav);
    setFocus(poseFor(fav));
    setHomeView(plantId, fav).catch(() => { /* preference-only; keep the local choice */ });
  };

  return (
    <div className="glass-card overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-white/[0.06]">
        <h2 className="text-white font-semibold text-sm">{t('home.factoryOverview')}</h2>
        <div className="flex items-center gap-3">
          {views.length > 0 && (
            <label className="flex items-center gap-1.5" title={t('home.favoriteViewHint')}>
              <Star size={13} className={favoriteId ? 'text-amber-400 fill-amber-400' : 'text-gray-500'} />
              <select
                value={favoriteId ?? ''}
                onChange={(e) => chooseFavorite(e.target.value || null)}
                className="bg-gray-800/80 border border-white/10 text-xs text-gray-200 rounded-md pl-2 pr-6 py-1 focus:outline-none focus:border-blue-500 max-w-[150px]"
              >
                <option value="">{t('home.favoriteAutomatic')}</option>
                {views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
          )}
          <Link
            to="/factory-map"
            className="flex items-center gap-1.5 text-blue-400 hover:text-blue-300 text-xs font-medium transition-colors whitespace-nowrap"
          >
            {t('home.openFactoryMap')} <ArrowRight size={12} />
          </Link>
        </div>
      </div>
      <div className="h-[320px] md:h-[420px]">
        {isLoading ? (
          <div className="h-full flex items-center justify-center">
            <Spinner size="lg" />
          </div>
        ) : machines.length || props3d.length ? (
          <Factory3D
            machines={machines}
            props={props3d}
            floorPlanUrl={data?.floor_plan_url ?? null}
            onSelect={(id) => { if (id) navigate('/factory-map'); }}
            cameraPosition={camRef.current ?? undefined}
            focus={focus}
            tvThresholds={data?.line_tv_thresholds}
            globalLineStats={data?.global_line_stats ?? null}
            pitStop={pitStop}
            onSelectPitStopOf={() => navigate('/factory-map')}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
            <MapIcon size={28} className="text-gray-700" />
            <p className="text-gray-500 text-sm">{t('home.factoryOverviewEmpty')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
