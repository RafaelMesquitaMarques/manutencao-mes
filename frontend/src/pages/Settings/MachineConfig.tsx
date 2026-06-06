import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import { fetchMachinesAll, updateMachineConfig } from '../../api/machines';
import type { Machine, MachineConfigUpdate } from '../../types';

const LANG_OPTIONS = [
  { value: 'fr', label: 'Français' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
];

const COLOR_PRESETS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center justify-between cursor-pointer">
      <span className="text-sm text-gray-300">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative w-11 h-6 rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-gray-700'}`}
      >
        <span className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${checked ? 'left-6' : 'left-1'}`} />
      </button>
    </label>
  );
}

export default function MachineConfig() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [machine, setMachine] = useState<Machine | null>(null);
  const [form, setForm]       = useState<MachineConfigUpdate>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);

  useEffect(() => {
    fetchMachinesAll().then((machines) => {
      const found = machines.find((m) => m.id === id);
      if (found) {
        setMachine(found);
        setForm({
          display_name:            found.display_name || '',
          page_language:           found.page_language || 'fr',
          custom_color:            found.custom_color || '',
          target_availability_pct: found.target_availability_pct ?? 70,
          target_count:            found.target_count ?? 0,
          show_production_panel:   found.show_production_panel ?? true,
          show_reject_panel:       found.show_reject_panel ?? true,
          show_availability_gauge: found.show_availability_gauge ?? true,
          show_job_number:         found.show_job_number ?? true,
        });
      }
      setLoading(false);
    });
  }, [id]);

  const set = <K extends keyof MachineConfigUpdate>(key: K, val: MachineConfigUpdate[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  const save = async () => {
    if (!id) return;
    setSaving(true);
    await updateMachineConfig(id, form);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (loading) return (
    <div className="min-h-screen bg-[#060c17] flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
    </div>
  );

  if (!machine) return (
    <div className="min-h-screen bg-[#060c17] flex items-center justify-center">
      <p className="text-gray-500">Machine not found</p>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#060c17] text-white p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-8">
        <button onClick={() => navigate('/settings/machines')} className="p-2 rounded-xl text-gray-600 hover:text-white hover:bg-white/[0.05] transition-all">
          <ArrowLeft size={20} />
        </button>
        <div>
          <h1 className="text-xl font-black text-white">{machine.display_name || machine.name}</h1>
          <p className="text-sm text-gray-600">Machine page configuration</p>
        </div>
      </div>

      <div className="space-y-6">
        {/* Display */}
        <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5 space-y-4">
          <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">Display</h2>

          <div>
            <label className="block text-sm text-gray-500 mb-1.5">Display Name (override)</label>
            <input
              value={form.display_name || ''}
              onChange={(e) => set('display_name', e.target.value)}
              placeholder={machine.name}
              className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-500 mb-1.5">Page Language</label>
            <div className="flex gap-2">
              {LANG_OPTIONS.map((l) => (
                <button
                  key={l.value}
                  type="button"
                  onClick={() => set('page_language', l.value)}
                  className={`px-4 py-2 rounded-xl text-sm font-bold border transition-all ${form.page_language === l.value ? 'bg-blue-600 text-white border-blue-500' : 'bg-white/[0.04] text-gray-400 border-white/10 hover:border-white/20'}`}
                >{l.label}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-500 mb-1.5">Accent Color</label>
            <div className="flex gap-2 items-center">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set('custom_color', c)}
                  className="w-8 h-8 rounded-full border-2 transition-all"
                  style={{ backgroundColor: c, borderColor: form.custom_color === c ? 'white' : 'transparent' }}
                />
              ))}
              <input
                type="text"
                value={form.custom_color || ''}
                onChange={(e) => set('custom_color', e.target.value)}
                placeholder="#3b82f6"
                className="w-28 bg-[#0b1120] border border-white/10 rounded-xl px-3 py-1.5 text-white text-sm font-mono focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
        </div>

        {/* Panels */}
        <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5 space-y-4">
          <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">Panels</h2>
          <Toggle label="Show Production Panel" checked={!!form.show_production_panel} onChange={(v) => set('show_production_panel', v)} />
          <Toggle label="Show Availability Gauge" checked={!!form.show_availability_gauge} onChange={(v) => set('show_availability_gauge', v)} />
          <Toggle label="Show Reject Panel" checked={!!form.show_reject_panel} onChange={(v) => set('show_reject_panel', v)} />
          <Toggle label="Show Job Number" checked={!!form.show_job_number} onChange={(v) => set('show_job_number', v)} />
        </div>

        {/* Targets */}
        <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-5 space-y-4">
          <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">Targets</h2>
          <div>
            <label className="block text-sm text-gray-500 mb-1.5">Target Availability (%)</label>
            <input
              type="number" min={0} max={100}
              value={form.target_availability_pct ?? 70}
              onChange={(e) => set('target_availability_pct', Number(e.target.value))}
              className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-500 mb-1.5">Daily Production Target</label>
            <input
              type="number" min={0}
              value={form.target_count ?? 0}
              onChange={(e) => set('target_count', Number(e.target.value))}
              className="w-full bg-[#0b1120] border border-white/10 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        <button
          onClick={save}
          disabled={saving}
          className={`w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl font-black text-base transition-all ${saved ? 'bg-green-600' : 'bg-blue-600 hover:bg-blue-500'} text-white disabled:opacity-50`}
        >
          <Save size={18} />
          {saved ? 'Saved!' : saving ? 'Saving...' : 'Save Configuration'}
        </button>
      </div>
    </div>
  );
}
