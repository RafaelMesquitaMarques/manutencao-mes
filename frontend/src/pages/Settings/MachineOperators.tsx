import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Check, X } from 'lucide-react';
import { fetchMachinesAll, addMachineOperator, updateMachineOperatorRecord } from '../../api/machines';
import type { Machine, MachineOperatorOut, MachineOperatorCreate, OperatorShift } from '../../types';
import api from '../../api/axios';

const SHIFTS: OperatorShift[] = ['morning', 'afternoon', 'night', 'all'];

export default function MachineOperators() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [machine, setMachine]     = useState<Machine | null>(null);
  const [operators, setOperators] = useState<MachineOperatorOut[]>([]);
  const [loading, setLoading]     = useState(true);
  const [showAdd, setShowAdd]     = useState(false);
  const [busy, setBusy]           = useState(false);
  const [form, setForm]           = useState<MachineOperatorCreate>({ name: '', shift: 'all' });

  const loadOps = async () => {
    if (!id) return;
    const { data } = await api.get<MachineOperatorOut[]>(`/api/machines/${id}/operators`);
    setOperators(data);
  };

  useEffect(() => {
    if (!id) return;
    fetchMachinesAll().then((machines) => {
      const found = machines.find((m) => m.id === id);
      setMachine(found || null);
      setLoading(false);
    });
    loadOps();
  }, [id]);

  const addOp = async () => {
    if (!id || !form.name.trim()) return;
    setBusy(true);
    const slug = machine?.page_slug || id;
    await addMachineOperator(slug, form);
    setForm({ name: '', shift: 'all' });
    setShowAdd(false);
    await loadOps();
    setBusy(false);
  };

  const toggleActive = async (op: MachineOperatorOut) => {
    await updateMachineOperatorRecord(op.id, { is_active: !op.is_active });
    await loadOps();
  };

  if (loading) return (
    <div className="min-h-screen bg-[#060c17] flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="min-h-screen bg-[#060c17] text-white p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-8">
        <button onClick={() => navigate('/settings/machines')} className="p-2 rounded-xl text-gray-600 hover:text-white hover:bg-white/[0.05] transition-all">
          <ArrowLeft size={20} />
        </button>
        <div>
          <h1 className="text-xl font-black text-white">{machine?.display_name || machine?.name || 'Machine'}</h1>
          <p className="text-sm text-gray-600">Operator list</p>
        </div>
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="ml-auto flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-bold px-4 py-2 rounded-xl text-sm transition-colors"
        >
          <Plus size={14} /> Add Operator
        </button>
      </div>

      {showAdd && (
        <div className="mb-5 p-4 bg-[#0d1421] rounded-2xl border border-white/[0.06] space-y-3">
          <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest">New Operator</h3>
          <div className="flex gap-2">
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Full name..."
              className="flex-1 bg-[#0b1120] border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
            <input
              value={form.employee_code || ''}
              onChange={(e) => setForm((f) => ({ ...f, employee_code: e.target.value }))}
              placeholder="Employee #"
              className="w-32 bg-[#0b1120] border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex gap-2">
            {SHIFTS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setForm((f) => ({ ...f, shift: s }))}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all capitalize ${form.shift === s ? 'bg-blue-600 text-white border-blue-500' : 'bg-white/[0.04] text-gray-400 border-white/10'}`}
              >{s}</button>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={addOp} disabled={busy || !form.name.trim()} className="bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-50 flex items-center gap-1.5">
              <Check size={13} /> Add
            </button>
            <button onClick={() => setShowAdd(false)} className="text-gray-600 px-4 py-2 border border-white/10 rounded-xl text-sm flex items-center gap-1.5">
              <X size={13} /> Cancel
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {operators.length === 0 ? (
          <div className="text-center py-16 text-gray-700">No operators configured yet.</div>
        ) : operators.map((op) => (
          <div
            key={op.id}
            className={`bg-[#0d1421] rounded-2xl border border-white/[0.06] p-4 flex items-center gap-4 ${!op.is_active ? 'opacity-50' : ''}`}
          >
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-lg font-black text-blue-400">
              {op.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-base font-bold text-white">{op.name}</p>
              <div className="flex gap-2 mt-0.5">
                {op.employee_code && <span className="text-xs text-gray-600 font-mono">#{op.employee_code}</span>}
                <span className="text-xs text-gray-600 capitalize">{op.shift}</span>
              </div>
            </div>
            <button
              onClick={() => toggleActive(op)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all ${op.is_active ? 'bg-green-500/10 text-green-400 border-green-500/20 hover:bg-green-500/20' : 'bg-gray-500/10 text-gray-600 border-gray-700 hover:bg-gray-500/20'}`}
            >{op.is_active ? 'Active' : 'Inactive'}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
