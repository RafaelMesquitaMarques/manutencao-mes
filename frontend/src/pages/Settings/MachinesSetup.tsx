import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Settings, Users, ExternalLink, MapPin, Building2 } from 'lucide-react';
import { fetchMachinesAll } from '../../api/machines';
import type { Machine, MachineStatus } from '../../types';

const STATUS_COLOR: Record<string, string> = {
  running:      'bg-blue-500/15 text-blue-400 border-blue-500/30',
  stopped:      'bg-pink-500/15 text-pink-400 border-pink-500/30',
  maintenance:  'bg-amber-500/15 text-amber-400 border-amber-500/30',
  idle:         'bg-gray-500/15 text-gray-500 border-gray-600/30',
  planned_stop: 'bg-slate-500/15 text-slate-400 border-slate-600/30',
};

export default function MachinesSetup() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    fetchMachinesAll()
      .then(setMachines)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-[#060c17] text-white p-6 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-black text-white">Machine Setup</h1>
        <p className="text-sm text-gray-600 mt-1">Configure machine pages, panels, operators and targets</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-3">
          {machines.map((m) => {
            const status = (m.current_status || 'idle') as string;
            const statusCls = STATUS_COLOR[status] || STATUS_COLOR.idle;
            return (
              <div key={m.id} className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-4 flex items-center gap-4">
                {/* Status dot */}
                <div className={`px-2.5 py-1 rounded-full border text-xs font-bold ${statusCls}`}>
                  {status}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-base font-bold text-white truncate">{m.display_name || m.name}</p>
                  <div className="flex gap-3 mt-0.5">
                    {m.code && <span className="text-xs text-gray-600 font-mono">{m.code}</span>}
                    {m.department && (
                      <span className="flex items-center gap-1 text-xs text-gray-600">
                        <Building2 size={10} /> {m.department}
                      </span>
                    )}
                    {m.location && (
                      <span className="flex items-center gap-1 text-xs text-gray-600">
                        <MapPin size={10} /> {m.location}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {m.page_slug && (
                    <Link
                      to={`/machines/${m.page_slug}`}
                      target="_blank"
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white border border-white/10 hover:border-white/20 transition-all"
                    >
                      <ExternalLink size={12} /> Open page
                    </Link>
                  )}
                  <Link
                    to={`/settings/machines/${m.id}/operators`}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white border border-white/10 hover:border-white/20 transition-all"
                  >
                    <Users size={12} /> Operators
                  </Link>
                  <Link
                    to={`/settings/machines/${m.id}/config`}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-blue-600/20 text-blue-400 border border-blue-500/30 hover:bg-blue-600/30 transition-all font-bold"
                  >
                    <Settings size={12} /> Configure
                  </Link>
                </div>
              </div>
            );
          })}
          {machines.length === 0 && (
            <div className="text-center py-16 text-gray-700">No machines found.</div>
          )}
        </div>
      )}
    </div>
  );
}
