import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Factory, ExternalLink, Circle, Play, StopCircle, Wrench, RefreshCw } from 'lucide-react';
import { fetchMachinesAll } from '../../api/machines';
import type { Machine, MachineStatus } from '../../types';
import Spinner from '../../components/ui/Spinner';

const STATUS_STYLE: Record<MachineStatus, { label: string; dot: string; text: string }> = {
  running:     { label: 'Running',     dot: 'bg-green-400',  text: 'text-green-400'  },
  stopped:     { label: 'Stopped',     dot: 'bg-red-400',    text: 'text-red-400'    },
  maintenance: { label: 'Maintenance', dot: 'bg-amber-400',  text: 'text-amber-400'  },
  idle:        { label: 'Idle',        dot: 'bg-gray-500',   text: 'text-gray-400'   },
};

export default function MachineList() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading]   = useState(true);

  const load = () => {
    setLoading(true);
    fetchMachinesAll()
      .then(setMachines)
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const machineRef = (m: Machine) => m.page_slug ?? m.id;

  return (
    <div className="p-6 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Factory size={22} className="text-blue-400" />
            Machines
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">Machine pages and status overview</p>
        </div>
        <button onClick={load} className="btn-secondary py-1.5 px-3">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48"><Spinner size="lg" /></div>
      ) : machines.length === 0 ? (
        <div className="glass-card flex flex-col items-center justify-center h-48 gap-3">
          <Factory size={36} className="text-gray-700" />
          <p className="text-gray-500 text-sm">No machines configured</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {machines.map((m) => {
            const st = STATUS_STYLE[m.current_status as MachineStatus] ?? STATUS_STYLE.running;
            const ref = machineRef(m);
            return (
              <div key={m.id} className="glass-card p-5 space-y-3 hover:border-white/10 transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-semibold text-base truncate">{m.name}</p>
                    {m.code && <p className="text-xs font-mono text-gray-600 mt-0.5">{m.code}</p>}
                  </div>
                  <span className={`flex items-center gap-1.5 text-xs font-medium ${st.text}`}>
                    <span className={`w-2 h-2 rounded-full ${st.dot}`} />
                    {st.label}
                  </span>
                </div>

                {(m.department || m.location) && (
                  <p className="text-xs text-gray-500 truncate">
                    {[m.department, m.location].filter(Boolean).join(' · ')}
                  </p>
                )}

                {m.current_operator && (
                  <p className="text-xs text-gray-500">
                    Operator: <span className="text-gray-300">{m.current_operator}</span>
                    {m.current_shift && <span className="text-gray-600"> · {m.current_shift}</span>}
                  </p>
                )}

                <div className="pt-1">
                  <Link
                    to={`/machines/${ref}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    <ExternalLink size={12} />
                    Open machine page
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
