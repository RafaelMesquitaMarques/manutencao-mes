import { useEffect, useState, useCallback } from 'react';
import { Package, CheckCircle, XCircle, Loader2, AlertCircle } from 'lucide-react';
import api from '../../api/axios';

interface PartItem {
  id: string;
  intervention_id: string | null;
  stock_item_id: string | null;
  item_code: string | null;
  item_description: string | null;
  quantity_used: number;
  unit: string | null;
  approval_status: string;
  approved_at: string | null;
  rejection_reason: string | null;
  added_at: string | null;
}

interface Group {
  intervention_id: string;
  called_at: string | null;
  machine_id: string | null;
  parts: PartItem[];
}

export default function PartsApproval() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [totalPending, setTotalPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/parts-approval/pending');
      setGroups(res.data.groups ?? []);
      setTotalPending(res.data.total_pending ?? 0);
    } catch {
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const approve = async (partId: string) => {
    setActing(partId);
    try {
      await api.post(`/api/parts-approval/${partId}/approve`);
      await load();
    } catch { /* ignore */ }
    finally { setActing(null); }
  };

  const reject = async (partId: string) => {
    setActing(partId);
    try {
      await api.post(`/api/parts-approval/${partId}/reject`, {
        reason: rejectReason[partId] || null,
      });
      setRejectingId(null);
      setRejectReason((prev) => { const n = { ...prev }; delete n[partId]; return n; });
      await load();
    } catch { /* ignore */ }
    finally { setActing(null); }
  };

  const approveAll = async (parts: PartItem[]) => {
    const ids = parts.filter((p) => p.approval_status === 'pending').map((p) => p.id);
    if (!ids.length) return;
    setActing('batch-' + ids[0]);
    try {
      await api.post('/api/parts-approval/approve-batch', { part_ids: ids });
      await load();
    } catch { /* ignore */ }
    finally { setActing(null); }
  };

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <Package size={20} className="text-blue-400" />
        <div>
          <h1 className="text-xl font-bold text-white">Approbation des pièces</h1>
          <p className="text-gray-600 text-xs mt-0.5">
            {totalPending} pièce{totalPending !== 1 ? 's' : ''} en attente d'approbation
          </p>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="animate-spin text-gray-500" size={32} />
        </div>
      )}

      {!loading && groups.length === 0 && (
        <div className="glass-card p-8 text-center">
          <CheckCircle size={36} className="mx-auto text-green-500 mb-3" />
          <p className="text-gray-300 font-medium">Aucune pièce en attente</p>
          <p className="text-gray-600 text-sm mt-1">Toutes les pièces ont été traitées.</p>
        </div>
      )}

      {groups.map((group) => {
        const pendingParts = group.parts.filter((p) => p.approval_status === 'pending');
        const batchActing = acting === 'batch-' + pendingParts[0]?.id;
        return (
          <div key={group.intervention_id} className="glass-card overflow-hidden">
            {/* Group header */}
            <div className="flex items-center justify-between px-4 py-3"
              style={{ background: '#111318', borderBottom: '1px solid #21262d' }}>
              <div>
                <p className="text-sm font-semibold text-gray-200">
                  Intervention <span className="font-mono text-blue-400">{group.intervention_id.slice(0, 8)}</span>
                </p>
                <p className="text-xs text-gray-600 mt-0.5">
                  {group.called_at
                    ? new Date(group.called_at).toLocaleString('fr-CA', { dateStyle: 'short', timeStyle: 'short' })
                    : '—'}
                  {group.machine_id && ` · ${group.machine_id.slice(0, 8)}`}
                </p>
              </div>
              {pendingParts.length > 1 && (
                <button
                  disabled={batchActing}
                  onClick={() => approveAll(group.parts)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-all disabled:opacity-40"
                  style={{ background: '#166534', border: '1px solid #22c55e' }}>
                  {batchActing ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle size={13} />}
                  Tout approuver ({pendingParts.length})
                </button>
              )}
            </div>

            {/* Parts list */}
            <div className="divide-y divide-white/5">
              {group.parts.map((part) => (
                <div key={part.id} className="px-4 py-3 space-y-2">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-200 truncate">
                        {part.item_description || part.item_code || '—'}
                      </p>
                      <p className="text-xs text-gray-600 mt-0.5">
                        {part.item_code && <span className="mr-2 font-mono">{part.item_code}</span>}
                        {part.quantity_used} {part.unit || 'un'}
                        {part.added_at && (
                          <span className="ml-2">
                            · {new Date(part.added_at).toLocaleString('fr-CA', { timeStyle: 'short', dateStyle: 'short' })}
                          </span>
                        )}
                      </p>
                    </div>

                    {/* Status badge or actions */}
                    {part.approval_status === 'approved' && (
                      <span className="flex items-center gap-1 text-xs text-green-400 px-2 py-1 rounded-full bg-green-500/10 border border-green-500/20">
                        <CheckCircle size={11} /> Approuvé
                      </span>
                    )}
                    {part.approval_status === 'rejected' && (
                      <span className="flex items-center gap-1 text-xs text-red-400 px-2 py-1 rounded-full bg-red-500/10 border border-red-500/20">
                        <XCircle size={11} /> Rejeté
                      </span>
                    )}
                    {part.approval_status === 'pending' && rejectingId !== part.id && (
                      <div className="flex gap-2 flex-shrink-0">
                        <button
                          disabled={acting === part.id}
                          onClick={() => approve(part.id)}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold text-white transition-all disabled:opacity-40"
                          style={{ background: '#166534', border: '1px solid #22c55e40' }}>
                          {acting === part.id ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle size={12} />}
                          Approuver
                        </button>
                        <button
                          disabled={acting === part.id}
                          onClick={() => setRejectingId(part.id)}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all disabled:opacity-40"
                          style={{ background: '#2d0a0a', border: '1px solid #ef444440', color: '#f87171' }}>
                          <XCircle size={12} /> Rejeter
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Reject reason input */}
                  {rejectingId === part.id && (
                    <div className="flex gap-2 items-center mt-1">
                      <AlertCircle size={13} className="text-amber-400 flex-shrink-0" />
                      <input
                        autoFocus
                        value={rejectReason[part.id] ?? ''}
                        onChange={(e) => setRejectReason((prev) => ({ ...prev, [part.id]: e.target.value }))}
                        placeholder="Raison du rejet (optionnel)"
                        className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 outline-none"
                      />
                      <button onClick={() => reject(part.id)} disabled={acting === part.id}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40"
                        style={{ background: '#7f1d1d' }}>
                        {acting === part.id ? <Loader2 size={12} className="animate-spin" /> : 'Confirmer'}
                      </button>
                      <button onClick={() => setRejectingId(null)} className="text-gray-600 hover:text-gray-400 transition-colors">
                        <XCircle size={16} />
                      </button>
                    </div>
                  )}

                  {/* Show rejection reason if already rejected */}
                  {part.approval_status === 'rejected' && part.rejection_reason && (
                    <p className="text-xs text-red-400/70 italic ml-1">Raison : {part.rejection_reason}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
