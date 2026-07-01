import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import GridLayout, { WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { ArrowLeft, Plus, Save, Pencil, Eye, Maximize2, Minimize2, Trash2 } from 'lucide-react';
import {
  fetchDashboard, updateDashboard, type Dashboard, type DashboardTile, type WidgetType,
} from '../../api/dashboards';
import { fetchMachinesAll } from '../../api/machines';
import type { Machine } from '../../types';
import { Widget } from './widgets';
import { useRole } from '../../hooks/usePermission';

const RGL = WidthProvider(GridLayout);
const WIDGETS: WidgetType[] = ['status', 'stops', 'production'];
const DEFAULT_SIZE: Record<WidgetType, { w: number; h: number }> = {
  status: { w: 3, h: 4 }, stops: { w: 6, h: 4 }, production: { w: 6, h: 5 },
};

export default function DashboardPage() {
  const { slug } = useParams<{ slug: string }>();
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const canEdit = useRole('supervisor', 'plant_manager', 'director', 'admin');
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [tiles, setTiles] = useState<DashboardTile[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [edit, setEdit] = useState(params.get('edit') === '1');
  const [isFull, setIsFull] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [addMachine, setAddMachine] = useState('');
  const [addWidget, setAddWidget] = useState<WidgetType>('status');
  const viewRef = useRef<HTMLDivElement>(null);

  const widgetLabel = (w: string) => t(`dashboards.widget_${w}`, w);

  useEffect(() => {
    if (!slug) return;
    fetchDashboard(slug).then((d) => { setDash(d); setTiles(d.tiles || []); }).catch(() => setDash(null));
  }, [slug]);
  useEffect(() => { fetchMachinesAll().then(setMachines).catch(() => {}); }, []);
  useEffect(() => {
    const onFs = () => setIsFull(document.fullscreenElement === viewRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const editing = edit && canEdit;
  const layout: Layout[] = useMemo(() => tiles.map((t2) => ({ i: t2.i, x: t2.x, y: t2.y, w: t2.w, h: t2.h })), [tiles]);

  const onLayoutChange = (lay: Layout[]) => {
    setTiles((ts) => ts.map((t2) => {
      const l = lay.find((x) => x.i === t2.i);
      return l ? { ...t2, x: l.x, y: l.y, w: l.w, h: l.h } : t2;
    }));
    if (editing) setDirty(true);
  };

  const addTile = () => {
    if (!addMachine) return;
    const sz = DEFAULT_SIZE[addWidget];
    const maxY = tiles.reduce((mx, t2) => Math.max(mx, t2.y + t2.h), 0);
    setTiles((ts) => [...ts, { i: `t${Date.now()}`, machine_id: addMachine, widget: addWidget, x: 0, y: maxY, ...sz }]);
    setDirty(true);
  };
  const removeTile = (i: string) => { setTiles((ts) => ts.filter((t2) => t2.i !== i)); setDirty(true); };
  const save = async () => { if (!slug) return; await updateDashboard(slug, { tiles }); setDirty(false); };

  const toggleFull = () => {
    const el = viewRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => {});
  };
  const machineName = (id: string | null) => machines.find((m) => m.id === id)?.name ?? '—';

  if (!dash) return <div className="h-full bg-gray-950 text-gray-500 flex items-center justify-center">…</div>;

  return (
    <div className="h-full flex flex-col bg-gray-950 text-gray-100">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 flex-wrap">
        <Link to="/dashboards" className="text-gray-400 hover:text-white"><ArrowLeft size={18} /></Link>
        <h1 className="text-base font-semibold text-white truncate">{dash.name}</h1>
        {canEdit && (
          <span className="inline-flex rounded-lg border border-gray-700 overflow-hidden text-sm">
            <button onClick={() => setEdit(false)} className={`flex items-center gap-1.5 px-3 py-1.5 ${!editing ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}><Eye size={14} /> {t('dashboards.view', 'View')}</button>
            <button onClick={() => setEdit(true)} className={`flex items-center gap-1.5 px-3 py-1.5 ${editing ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}><Pencil size={14} /> {t('dashboards.edit', 'Edit')}</button>
          </span>
        )}
        {editing && (
          <div className="flex items-center gap-2 flex-wrap">
            <select value={addMachine} onChange={(e) => setAddMachine(e.target.value)} className="bg-gray-800 border border-gray-700 rounded text-sm text-gray-200 px-2 py-1.5 max-w-[200px] focus:outline-none focus:border-indigo-500">
              <option value="">{t('dashboards.machine', 'Machine…')}</option>
              {machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <select value={addWidget} onChange={(e) => setAddWidget(e.target.value as WidgetType)} className="bg-gray-800 border border-gray-700 rounded text-sm text-gray-200 px-2 py-1.5 focus:outline-none focus:border-indigo-500">
              {WIDGETS.map((w) => <option key={w} value={w}>{widgetLabel(w)}</option>)}
            </select>
            <button onClick={addTile} disabled={!addMachine} className="flex items-center gap-1 px-2.5 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded disabled:opacity-40"><Plus size={14} /> {t('dashboards.add', 'Add')}</button>
            <button onClick={save} disabled={!dirty} className="flex items-center gap-1 px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 rounded disabled:opacity-40"><Save size={14} /> {t('dashboards.save', 'Save')}</button>
          </div>
        )}
        <button onClick={toggleFull} title={t('dashboards.fullscreen', 'Fullscreen')} className="ml-auto p-2 text-gray-300 hover:text-white hover:bg-gray-800 rounded-lg">
          {isFull ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>

      <div ref={viewRef} className="flex-1 overflow-auto bg-gray-950 p-2">
        {tiles.length === 0 ? (
          <div className="h-full flex items-center justify-center text-gray-600 text-sm">
            {editing ? t('dashboards.emptyEdit', 'Add cards with the selectors above.') : t('dashboards.emptyView', 'Empty dashboard.')}
          </div>
        ) : (
          <RGL className="layout" layout={layout} cols={12} rowHeight={48} isDraggable={editing} isResizable={editing}
            draggableHandle=".dash-drag" compactType="vertical" margin={[8, 8]} onLayoutChange={onLayoutChange}>
            {tiles.map((tile) => (
              <div key={tile.i} className="relative">
                {editing && (
                  <div className="dash-drag absolute top-0 left-0 right-0 h-7 z-30 cursor-move flex items-center justify-between px-2 rounded-t-xl bg-indigo-500/80 text-white text-[11px] font-bold select-none">
                    <span className="truncate">⠿ {machineName(tile.machine_id)} · {widgetLabel(tile.widget)}</span>
                    <button onClick={() => removeTile(tile.i)} className="hover:text-red-200 shrink-0"><Trash2 size={13} /></button>
                  </div>
                )}
                <div className={editing ? 'h-full pt-7' : 'h-full'}>
                  <Widget widget={tile.widget} machineId={tile.machine_id} />
                </div>
              </div>
            ))}
          </RGL>
        )}
      </div>
    </div>
  );
}
