import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, RotateCcw, RotateCw, Copy, Trash2, Box, Camera, MapPinOff, Link2, ExternalLink } from 'lucide-react';
import type { MapMachine, MapProp, MapSensor } from '../../api/factoryMap';
import type { MapEditorApi } from './useMapEditor';
import { BLOCK_KINDS, PROP_KINDS } from './catalog';

// ── Properties panel (3D edit mode) ───────────────────────────────────────────
// One place to see and set EVERYTHING about the selected item with exact
// numbers — replaces the window.prompt()s and the overloaded toolbar selects.

export type PanelZone = { id: string; name: string; color: string; pos_x: number; pos_y: number; pos_w: number; pos_h: number };

export type PanelSelection =
  | { kind: 'machine'; m: MapMachine }
  | { kind: 'prop'; p: MapProp }
  | { kind: 'sensor'; s: MapSensor }
  | { kind: 'zone'; z: PanelZone };

interface Option { id: string; name: string }

/** Numeric field that commits on blur/Enter (Esc reverts), only when changed. */
function NumField({ label, value, onCommit, step = 1, min, max, unit }: {
  label: string; value: number | null | undefined;
  onCommit: (v: number) => void; step?: number; min?: number; max?: number; unit?: string;
}) {
  const [text, setText] = useState(value != null ? String(value) : '');
  useEffect(() => { setText(value != null ? String(value) : ''); }, [value]);
  const commit = () => {
    const v = parseFloat(text.replace(',', '.'));
    if (!Number.isFinite(v)) { setText(value != null ? String(value) : ''); return; }
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
    if (clamped !== (value ?? null)) onCommit(clamped);
    else setText(value != null ? String(value) : '');
  };
  return (
    <label className="block">
      <span className="block text-[10px] text-gray-500 mb-0.5">{label}{unit ? ` (${unit})` : ''}</span>
      <input
        type="number" step={step} value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') { setText(value != null ? String(value) : ''); (e.target as HTMLInputElement).blur(); }
          e.stopPropagation();   // keep Delete/M/R/S from triggering editor hotkeys while typing
        }}
        className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-indigo-500"
      />
    </label>
  );
}

/** Text field, same commit rules as NumField. */
function TextField({ label, value, onCommit, placeholder }: {
  label: string; value: string | null | undefined; onCommit: (v: string) => void; placeholder?: string;
}) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => { setText(value ?? ''); }, [value]);
  const commit = () => { const v = text.trim(); if (v !== (value ?? '')) onCommit(v); };
  return (
    <label className="block">
      <span className="block text-[10px] text-gray-500 mb-0.5">{label}</span>
      <input
        value={text} placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') { setText(value ?? ''); (e.target as HTMLInputElement).blur(); }
          e.stopPropagation();
        }}
        className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-indigo-500"
      />
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 pt-3 border-t border-gray-800 first:mt-0 first:pt-0 first:border-0">
      <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">{title}</p>
      {children}
    </div>
  );
}

const norm = (deg: number) => ((Math.round(deg) % 360) + 360) % 360;

export default function MapEditorPanel({ selection, editor, equipOptions, machineOptions, onClose,
  onPickMachinePhoto, onPickMachineModel, onPickPropModel, onDuplicateProp, onDeleteProp, onUnplaceMachine, onDeleteZone }: {
  selection: PanelSelection;
  editor: MapEditorApi;
  equipOptions: Option[];
  machineOptions: Option[];
  onClose: () => void;
  onPickMachinePhoto: (id: string) => void;
  onPickMachineModel: (id: string) => void;
  onPickPropModel: (id: string) => void;
  onDuplicateProp: (id: string) => void;
  onDeleteProp: (id: string) => void;
  onUnplaceMachine: (id: string) => void;
  onDeleteZone: (id: string) => void;
}) {
  const { t } = useTranslation();

  const rotateRow = (current: number, apply: (deg: number) => void) => (
    <div className="flex items-center gap-1 mt-1.5">
      {[-90, -45, 45, 90].map((d) => (
        <button key={d} onClick={() => apply(norm(current + d))}
          className="flex-1 flex items-center justify-center gap-0.5 px-1 py-1 text-[11px] text-gray-300 bg-gray-800 border border-gray-700 rounded hover:bg-gray-700">
          {d < 0 ? <RotateCcw size={11} /> : <RotateCw size={11} />}{Math.abs(d)}°
        </button>
      ))}
    </div>
  );

  const header = (title: string, subtitle?: string | null) => (
    <div className="flex items-start justify-between mb-3">
      <div className="min-w-0">
        <h3 className="text-white font-semibold text-sm leading-snug truncate">{title}</h3>
        {subtitle && <p className="text-[11px] text-gray-500 font-mono truncate">{subtitle}</p>}
      </div>
      <button onClick={onClose} title={`${t('common.close')} (Esc)`} className="text-gray-500 hover:text-gray-300 flex-shrink-0 ml-2"><X size={16} /></button>
    </div>
  );

  return (
    <aside className="w-72 flex-shrink-0 border-l border-gray-800 overflow-y-auto p-3.5 bg-gray-950">
      {selection.kind === 'machine' && (() => {
        const m = selection.m;
        return (
          <>
            {header(m.name, m.code)}
            <Section title={t('factoryMap.panelPlacement')}>
              <div className="grid grid-cols-2 gap-2">
                <NumField label="X" unit="px" value={m.pos_x} onCommit={(v) => editor.patchMachine(m.id, { pos_x: Math.round(v), pos_y: m.pos_y ?? 0 })} />
                <NumField label="Y" unit="px" value={m.pos_y} onCommit={(v) => editor.patchMachine(m.id, { pos_x: m.pos_x ?? 0, pos_y: Math.round(v) })} />
                <NumField label={t('factoryMap.panelWidth')} unit="px" value={m.pos_w ?? 152} min={20} onCommit={(v) => editor.patchMachine(m.id, { pos_w: Math.round(v) })} />
                <NumField label={t('factoryMap.panelDepth')} unit="px" value={m.pos_h ?? 64} min={20} onCommit={(v) => editor.patchMachine(m.id, { pos_h: Math.round(v) })} />
              </div>
              <div className="mt-2">
                <NumField label={t('factoryMap.rotation')} unit="°" value={norm(m.rotation_deg ?? 0)} onCommit={(v) => editor.patchMachine(m.id, { rotation_deg: norm(v) }, { label: 'rotate' })} />
                {rotateRow(m.rotation_deg ?? 0, (deg) => editor.patchMachine(m.id, { rotation_deg: deg }, { label: 'rotate' }))}
              </div>
            </Section>
            <Section title={t('factoryMap.panel3d')}>
              <div className="grid grid-cols-2 gap-2">
                <NumField label={t('factoryMap.height3d')} unit="m" value={m.height_3d} min={0.1} step={0.1} onCommit={(v) => editor.patchMachine(m.id, { height_3d: v })} />
                <label className="block">
                  <span className="block text-[10px] text-gray-500 mb-0.5">{t('factoryMap.shape3d')}</span>
                  <select value={m.block_kind ?? 'auto'}
                    onChange={(e) => editor.patchMachine(m.id, { block_kind: e.target.value === 'auto' ? null : e.target.value })}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-xs text-gray-200 focus:outline-none focus:border-indigo-500">
                    {BLOCK_KINDS.map((k) => <option key={k} value={k}>{t(`factoryMap.block_${k}`)}</option>)}
                  </select>
                </label>
              </div>
              <div className="grid grid-cols-3 gap-2 mt-2">
                <NumField label={`${t('factoryMap.scale')} X`} value={m.model_scale ?? 1} min={0.05} step={0.05} onCommit={(v) => editor.patchMachine(m.id, { model_scale: v }, { label: 'scale' })} />
                <NumField label="Y" value={m.scale_y ?? m.model_scale ?? 1} min={0.05} step={0.05} onCommit={(v) => editor.patchMachine(m.id, { scale_y: v }, { label: 'scale' })} />
                <NumField label="Z" value={m.scale_z ?? m.model_scale ?? 1} min={0.05} step={0.05} onCommit={(v) => editor.patchMachine(m.id, { scale_z: v }, { label: 'scale' })} />
              </div>
              <button onClick={() => editor.patchMachine(m.id, { model_scale: 1, scale_y: 1, scale_z: 1 }, { label: 'scale' })}
                className="mt-1.5 w-full px-2 py-1 text-[11px] text-gray-400 bg-gray-800 border border-gray-700 rounded hover:text-gray-200 hover:bg-gray-700">
                {t('factoryMap.resetScale')}
              </button>
            </Section>
            <Section title={t('factoryMap.panelLinks')}>
              <label className="block">
                <span className="block text-[10px] text-gray-500 mb-0.5">{t('factoryMap.parentTitle')}</span>
                <select value={m.parent_equipment_id ?? ''}
                  onChange={(e) => editor.patchMachine(m.id, { parent_equipment_id: (e.target.value || null) as MapMachine['parent_equipment_id'] })}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-xs text-gray-200 focus:outline-none focus:border-indigo-500">
                  <option value="">{t('factoryMap.noParent')}</option>
                  {equipOptions.filter((o) => o.id !== m.id).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </label>
            </Section>
            <Section title={t('factoryMap.panelAppearance')}>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => onPickMachineModel(m.id)} className="flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs text-gray-200 bg-gray-800 border border-gray-700 rounded hover:bg-gray-700">
                  <Box size={13} /> {m.model_url ? t('factoryMap.replaceGlb') : t('factoryMap.uploadGlb3')}
                </button>
                <button onClick={() => onPickMachinePhoto(m.id)} className="flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs text-gray-200 bg-gray-800 border border-gray-700 rounded hover:bg-gray-700">
                  <Camera size={13} /> {t('factoryMap.setPhoto')}
                </button>
              </div>
              {m.model_url && (
                <button onClick={() => editor.patchMachine(m.id, { model_url: null })}
                  className="mt-1.5 w-full px-2 py-1 text-[11px] text-gray-400 bg-gray-800 border border-gray-700 rounded hover:text-red-300 hover:bg-gray-700">
                  {t('factoryMap.removeGlb')}
                </button>
              )}
            </Section>
            <Section title={t('factoryMap.actions')}>
              <button onClick={() => onUnplaceMachine(m.id)}
                title={t('factoryMap.removeFromMapHint')}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 hover:bg-amber-500/20">
                <MapPinOff size={13} /> {t('factoryMap.removeFromMap')}
              </button>
            </Section>
          </>
        );
      })()}

      {selection.kind === 'prop' && (() => {
        const p = selection.p;
        const isConveyor = p.kind === 'conveyor';
        return (
          <>
            {header(p.label || t(`factoryMap.block_${p.kind}`), t(`factoryMap.block_${p.kind}`))}
            <Section title={t('factoryMap.panelIdentity')}>
              <TextField label={t('factoryMap.panelLabel')} value={p.label} placeholder={t(`factoryMap.block_${p.kind}`)}
                onCommit={(v) => editor.patchProp(p.id, { label: v || null })} />
              <label className="block mt-2">
                <span className="block text-[10px] text-gray-500 mb-0.5">{t('factoryMap.panelKind')}</span>
                <select value={p.kind}
                  onChange={(e) => editor.patchProp(p.id, { kind: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-xs text-gray-200 focus:outline-none focus:border-indigo-500">
                  {PROP_KINDS.map((k) => <option key={k} value={k}>{t(`factoryMap.block_${k}`)}</option>)}
                </select>
              </label>
            </Section>
            <Section title={t('factoryMap.panelPlacement')}>
              <div className="grid grid-cols-2 gap-2">
                <NumField label="X" unit="px" value={p.pos_x} onCommit={(v) => editor.patchProp(p.id, { pos_x: Math.round(v), pos_y: p.pos_y })} />
                <NumField label="Y" unit="px" value={p.pos_y} onCommit={(v) => editor.patchProp(p.id, { pos_x: p.pos_x, pos_y: Math.round(v) })} />
                <NumField label={t('factoryMap.panelWidth')} unit="px" value={p.pos_w} min={20} onCommit={(v) => editor.patchProp(p.id, { pos_w: Math.round(v) })} />
                <NumField label={t('factoryMap.panelDepth')} unit="px" value={p.pos_h} min={20} onCommit={(v) => editor.patchProp(p.id, { pos_h: Math.round(v) })} />
              </div>
              <div className="mt-2">
                <NumField label={t('factoryMap.rotation')} unit="°" value={norm(p.rotation_deg ?? 0)} onCommit={(v) => editor.patchProp(p.id, { rotation_deg: norm(v) }, { label: 'rotate' })} />
                {rotateRow(p.rotation_deg ?? 0, (deg) => editor.patchProp(p.id, { rotation_deg: deg }, { label: 'rotate' }))}
              </div>
            </Section>
            <Section title={t('factoryMap.panel3d')}>
              <NumField label={t('factoryMap.height3d')} unit="m" value={p.height_3d} min={0.1} step={0.1} onCommit={(v) => editor.patchProp(p.id, { height_3d: v })} />
              <div className="grid grid-cols-3 gap-2 mt-2">
                <NumField label={`${t('factoryMap.scale')} X`} value={p.model_scale ?? 1} min={0.05} step={0.05} onCommit={(v) => editor.patchProp(p.id, { model_scale: v }, { label: 'scale' })} />
                <NumField label="Y" value={p.scale_y ?? p.model_scale ?? 1} min={0.05} step={0.05} onCommit={(v) => editor.patchProp(p.id, { scale_y: v }, { label: 'scale' })} />
                <NumField label="Z" value={p.scale_z ?? p.model_scale ?? 1} min={0.05} step={0.05} onCommit={(v) => editor.patchProp(p.id, { scale_z: v }, { label: 'scale' })} />
              </div>
            </Section>
            <Section title={t('factoryMap.panelLinks')}>
              <label className="block">
                <span className="block text-[10px] text-gray-500 mb-0.5"><Link2 size={10} className="inline mr-1" />{t('factoryMap.linkTitle')}</span>
                <select value={p.equipment_id ?? ''}
                  onChange={(e) => editor.patchProp(p.id, { equipment_id: (e.target.value || null) as MapProp['equipment_id'] })}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-xs text-gray-200 focus:outline-none focus:border-indigo-500">
                  <option value="">{t('factoryMap.notLinked')}</option>
                  {equipOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </label>
              {isConveyor && (
                <>
                  <label className="block mt-2">
                    <span className="block text-[10px] text-gray-500 mb-0.5">{t('factoryMap.ofMachineTitle')}</span>
                    <select value={p.machine_id ?? ''}
                      onChange={(e) => editor.patchProp(p.id, { machine_id: (e.target.value || null) as MapProp['machine_id'] })}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-xs text-gray-200 focus:outline-none focus:border-indigo-500">
                      <option value="">{t('factoryMap.ofNoMachine')}</option>
                      {machineOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  </label>
                  {p.machine_id && (
                    <div className="inline-flex mt-2 rounded border border-gray-700 overflow-hidden text-xs">
                      {(['input', 'output'] as const).map((r) => (
                        <button key={r} onClick={() => editor.patchProp(p.id, { role: p.role === r ? null : r })}
                          className={`px-2.5 py-1 ${p.role === r ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
                          {t(`factoryMap.role_${r}`)}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </Section>
            <Section title={t('factoryMap.panelAppearance')}>
              <button onClick={() => onPickPropModel(p.id)} className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs text-gray-200 bg-gray-800 border border-gray-700 rounded hover:bg-gray-700">
                <Box size={13} /> {p.model_url ? t('factoryMap.replaceGlb') : t('factoryMap.uploadGlb3')}
              </button>
              {p.model_url && (
                <button onClick={() => editor.patchProp(p.id, { model_url: null })}
                  className="mt-1.5 w-full px-2 py-1 text-[11px] text-gray-400 bg-gray-800 border border-gray-700 rounded hover:text-red-300 hover:bg-gray-700">
                  {t('factoryMap.removeGlb')}
                </button>
              )}
            </Section>
            <Section title={t('factoryMap.actions')}>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => onDuplicateProp(p.id)} title={`${t('factoryMap.duplicateTitle')} (Ctrl+D)`}
                  className="flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-xs text-gray-200 bg-gray-800 border border-gray-700 hover:bg-gray-700">
                  <Copy size={13} /> {t('factoryMap.duplicate')}
                </button>
                <button onClick={() => onDeleteProp(p.id)} title={`${t('factoryMap.deleteBlock')} (Del)`}
                  className="flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-xs text-red-300 bg-red-500/10 border border-red-500/30 hover:bg-red-500/20">
                  <Trash2 size={13} /> {t('common.delete')}
                </button>
              </div>
            </Section>
          </>
        );
      })()}

      {selection.kind === 'sensor' && (() => {
        const s = selection.s;
        return (
          <>
            {header(s.name, s.department)}
            <Section title={t('factoryMap.panelPlacement')}>
              <div className="grid grid-cols-2 gap-2">
                <NumField label="X" unit="px" value={s.pos_x} onCommit={(v) => editor.patchSensor(s.id, { pos_x: Math.round(v) })} />
                <NumField label="Y" unit="px" value={s.pos_y} onCommit={(v) => editor.patchSensor(s.id, { pos_y: Math.round(v) })} />
                <NumField label={t('factoryMap.height3d')} unit="m" value={s.height_3d ?? 3} min={0.2} step={0.1} onCommit={(v) => editor.patchSensor(s.id, { height_3d: v })} />
              </div>
            </Section>
            <p className="mt-3 text-[11px] text-gray-500 flex items-center gap-1">
              <ExternalLink size={11} /> {t('factoryMap.sensorManagedIn')}
            </p>
          </>
        );
      })()}

      {selection.kind === 'zone' && (() => {
        const z = selection.z;
        return (
          <>
            {header(z.name)}
            <Section title={t('factoryMap.panelIdentity')}>
              <TextField label={t('factoryMap.panelLabel')} value={z.name} onCommit={(v) => { if (v) editor.patchZone(z.id, { name: v }); }} />
              <label className="block mt-2">
                <span className="block text-[10px] text-gray-500 mb-0.5">{t('factoryMap.panelColor')}</span>
                <input type="color" value={z.color}
                  onChange={(e) => editor.patchZone(z.id, { color: e.target.value }, { history: false })}
                  className="w-full h-8 bg-gray-800 border border-gray-700 rounded cursor-pointer" />
              </label>
            </Section>
            <Section title={t('factoryMap.panelPlacement')}>
              <div className="grid grid-cols-2 gap-2">
                <NumField label="X" unit="px" value={z.pos_x} onCommit={(v) => editor.patchZone(z.id, { pos_x: Math.round(v), pos_y: z.pos_y })} />
                <NumField label="Y" unit="px" value={z.pos_y} onCommit={(v) => editor.patchZone(z.id, { pos_x: z.pos_x, pos_y: Math.round(v) })} />
                <NumField label={t('factoryMap.panelWidth')} unit="px" value={z.pos_w} min={40} onCommit={(v) => editor.patchZone(z.id, { pos_w: Math.round(v) })} />
                <NumField label={t('factoryMap.panelDepth')} unit="px" value={z.pos_h} min={40} onCommit={(v) => editor.patchZone(z.id, { pos_h: Math.round(v) })} />
              </div>
            </Section>
            <Section title={t('factoryMap.actions')}>
              <button onClick={() => onDeleteZone(z.id)}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs text-red-300 bg-red-500/10 border border-red-500/30 hover:bg-red-500/20">
                <Trash2 size={13} /> {t('factoryMap.deleteZone')}
              </button>
            </Section>
          </>
        );
      })()}
    </aside>
  );
}
