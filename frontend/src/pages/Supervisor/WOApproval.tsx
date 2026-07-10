import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ClipboardCheck, CheckCircle, XCircle, Loader2, AlertCircle,
  Wrench, Package, Clock, User as UserIcon, Pencil, Trash2, Search,
} from 'lucide-react';
import api from '../../api/axios';
import { searchInventory, type InventorySearchItem } from '../../api/machineOperator';
import { humanMinutes } from '../../utils/duration';

interface PartItem {
  id: string;
  item_code: string | null;
  item_description: string | null;
  quantity_used: number;
  unit: string | null;
  unit_cost: number | null;
  total_cost: number | null;
  approval_status: string;
  rejection_reason: string | null;
}

interface WorkOrder {
  source: 'intervention' | 'wo';
  id: string;
  approval_status: string;
  wo_number: string | null;
  machine_name: string | null;
  machine_code: string | null;
  intervention_type_name: string | null;
  mechanic_note: string | null;
  operator_note: string | null;
  diagnosis: string | null;
  corrective_action: string | null;
  technician_name: string | null;
  called_at: string | null;
  completed_at: string | null;
  response_time_minutes: number | null;
  intervention_duration_minutes: number | null;
  total_downtime_minutes: number | null;
  parts: PartItem[];
  parts_total: number;
  cost_center: string | null;
  /** Machine's default cost center — pre-selected in the picker until overridden. */
  default_cost_center: string | null;
  supports_part_reject: boolean;
  can_edit_diagnosis: boolean;
}

interface CostCenterOption {
  name: string;
  code: string | null;
}

interface WorkDoneDraft {
  diagnosis: string;
  corrective_action: string;
  mechanic_note: string;
}

export default function WOApproval() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'fr' ? 'fr-CA' : i18n.language === 'es' ? 'es-ES' : 'en-CA';

  const [items, setItems] = useState<WorkOrder[]>([]);
  const [totalPending, setTotalPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({});
  // Cost center picked per work order at approval (required to approve).
  const [costCenters, setCostCenters] = useState<CostCenterOption[]>([]);
  const [ccChoice, setCcChoice] = useState<Record<string, string>>({});
  const [ccError, setCcError] = useState<Record<string, boolean>>({});

  // Inline edit-before-approve state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkDoneDraft>({ diagnosis: '', corrective_action: '', mechanic_note: '' });
  const [qtyDraft, setQtyDraft] = useState<Record<string, string>>({});
  const [partQuery, setPartQuery] = useState('');
  const [partResults, setPartResults] = useState<InventorySearchItem[]>([]);
  const [partQty, setPartQty] = useState('1');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/wo-approval/pending');
      setItems(res.data.items ?? []);
      setTotalPending(res.data.total_pending ?? 0);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/api/wo-approval/cost-centers')
      .then((res) => setCostCenters(Array.isArray(res.data) ? res.data : []))
      .catch(() => setCostCenters([]));
  }, []);

  // Debounced inventory lookup for the add-part field
  useEffect(() => {
    const q = partQuery.trim();
    if (q.length < 2) { setPartResults([]); return; }
    const timer = setTimeout(async () => {
      try {
        const res = await searchInventory(q, 20);
        setPartResults(res.items ?? []);
      } catch {
        setPartResults([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [partQuery]);

  const replaceItem = (view: WorkOrder) => {
    setItems((prev) => prev.map((i) => (i.source === view.source && i.id === view.id ? view : i)));
    setQtyDraft(Object.fromEntries(view.parts.map((p) => [p.id, String(p.quantity_used)])));
  };

  const startEdit = (wo: WorkOrder) => {
    setEditingId(wo.id);
    setRejectingId(null);
    setDraft({
      diagnosis: wo.diagnosis ?? '',
      corrective_action: wo.corrective_action ?? '',
      mechanic_note: wo.mechanic_note ?? '',
    });
    setQtyDraft(Object.fromEntries(wo.parts.map((p) => [p.id, String(p.quantity_used)])));
    setPartQuery('');
    setPartResults([]);
    setPartQty('1');
  };

  const saveEdit = async (wo: WorkOrder) => {
    setActing(wo.id);
    try {
      const payload: Record<string, string | null> = {
        mechanic_note: draft.mechanic_note.trim() || null,
      };
      if (wo.can_edit_diagnosis) {
        payload.diagnosis = draft.diagnosis.trim() || null;
        payload.corrective_action = draft.corrective_action.trim() || null;
      }
      const res = await api.patch(`/api/wo-approval/${wo.source}/${wo.id}`, payload);
      replaceItem(res.data);
      setEditingId(null);
    } catch { /* ignore */ }
    finally { setActing(null); }
  };

  const parseQty = (raw: string) => {
    const q = parseFloat(raw.replace(',', '.'));
    return Number.isFinite(q) && q > 0 ? q : null;
  };

  const addPart = async (wo: WorkOrder, stockItem: InventorySearchItem | null) => {
    const qty = parseQty(partQty) ?? 1;
    const payload = stockItem
      ? { stock_item_id: stockItem.id, quantity: qty }
      : { item_description: partQuery.trim(), quantity: qty };
    setActing(`add-${wo.id}`);
    try {
      const res = await api.post(`/api/wo-approval/${wo.source}/${wo.id}/parts`, payload);
      replaceItem(res.data);
      setPartQuery('');
      setPartResults([]);
      setPartQty('1');
    } catch { /* ignore */ }
    finally { setActing(null); }
  };

  const commitQty = async (wo: WorkOrder, part: PartItem) => {
    const q = parseQty(qtyDraft[part.id] ?? '');
    if (q === null || q === part.quantity_used) {
      setQtyDraft((prev) => ({ ...prev, [part.id]: String(part.quantity_used) }));
      return;
    }
    setActing(part.id);
    try {
      const res = await api.patch(`/api/wo-approval/${wo.source}/${wo.id}/parts/${part.id}`, { quantity: q });
      replaceItem(res.data);
    } catch { /* ignore */ }
    finally { setActing(null); }
  };

  const removePart = async (wo: WorkOrder, part: PartItem) => {
    setActing(part.id);
    try {
      const res = await api.delete(`/api/wo-approval/${wo.source}/${wo.id}/parts/${part.id}`);
      replaceItem(res.data);
    } catch { /* ignore */ }
    finally { setActing(null); }
  };

  const approve = async (wo: WorkOrder) => {
    const cost_center = (ccChoice[wo.id] ?? wo.cost_center ?? wo.default_cost_center ?? '').trim();
    if (!cost_center) {
      setCcError((prev) => ({ ...prev, [wo.id]: true }));
      return;
    }
    setActing(wo.id);
    try {
      await api.post(`/api/wo-approval/${wo.source}/${wo.id}/approve`, { cost_center });
      await load();
    } catch { /* ignore */ }
    finally { setActing(null); }
  };

  const reject = async (wo: WorkOrder) => {
    setActing(wo.id);
    try {
      await api.post(`/api/wo-approval/${wo.source}/${wo.id}/reject`, { reason: rejectReason[wo.id] || null });
      setRejectingId(null);
      setRejectReason((prev) => { const n = { ...prev }; delete n[wo.id]; return n; });
      await load();
    } catch { /* ignore */ }
    finally { setActing(null); }
  };

  const rejectPart = async (woId: string, partId: string) => {
    setActing(partId);
    try {
      const res = await api.post(`/api/wo-approval/intervention/${woId}/parts/${partId}/reject`, { reason: null });
      replaceItem(res.data);
    } catch { /* ignore */ }
    finally { setActing(null); }
  };

  const fmtDate = (s: string | null) =>
    s ? new Date(s).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) : '—';

  const inputCls = 'w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 outline-none';

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <ClipboardCheck size={20} className="text-blue-400" />
        <div>
          <h1 className="text-xl font-bold text-white">{t('woApproval.title')}</h1>
          <p className="text-gray-600 text-xs mt-0.5">
            {t('woApproval.subtitle', { count: totalPending })}
          </p>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="animate-spin text-gray-500" size={32} />
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className="glass-card p-8 text-center">
          <CheckCircle size={36} className="mx-auto text-green-500 mb-3" />
          <p className="text-gray-300 font-medium">{t('woApproval.empty')}</p>
          <p className="text-gray-600 text-sm mt-1">{t('woApproval.emptyHint')}</p>
        </div>
      )}

      {items.map((wo) => {
        const busy = acting === wo.id;
        const editing = editingId === wo.id;
        return (
          <div key={`${wo.source}-${wo.id}`} className="glass-card overflow-hidden">
            {/* Header */}
            <div className="flex items-start justify-between gap-3 px-4 py-3"
              style={{ background: '#111318', borderBottom: '1px solid #21262d' }}>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-200 truncate">
                  {wo.wo_number && <span className="font-mono text-blue-400 mr-2">{wo.wo_number}</span>}
                  {wo.machine_name || '—'}
                  {wo.machine_code && <span className="text-gray-600 ml-1.5 text-xs">({wo.machine_code})</span>}
                </p>
                <p className="text-xs text-gray-600 mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  {wo.technician_name && (
                    <span className="inline-flex items-center gap-1"><UserIcon size={11} />{wo.technician_name}</span>
                  )}
                  <span className="inline-flex items-center gap-1"><Clock size={11} />{fmtDate(wo.completed_at)}</span>
                </p>
              </div>
              {!editing && (
                <button
                  onClick={() => startEdit(wo)}
                  title={t('woApproval.edit')}
                  className="text-gray-600 hover:text-blue-400 transition-colors flex-shrink-0 p-1"
                >
                  <Pencil size={15} />
                </button>
              )}
            </div>

            {/* Work done */}
            <div className="px-4 py-3 space-y-2 border-b border-white/5">
              <p className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold flex items-center gap-1.5">
                <Wrench size={12} /> {t('woApproval.workDone')}
              </p>
              {wo.intervention_type_name && (
                <p className="text-sm text-gray-300">
                  <span className="text-gray-600">{t('woApproval.type')}: </span>{wo.intervention_type_name}
                </p>
              )}
              {editing ? (
                <div className="space-y-2">
                  {wo.can_edit_diagnosis && (
                    <>
                      <label className="block text-xs text-gray-600">
                        {t('woApproval.diagnosis')}
                        <textarea
                          rows={2}
                          value={draft.diagnosis}
                          onChange={(e) => setDraft((d) => ({ ...d, diagnosis: e.target.value }))}
                          className={`${inputCls} mt-1 resize-none`}
                        />
                      </label>
                      <label className="block text-xs text-gray-600">
                        {t('woApproval.correctiveAction')}
                        <textarea
                          rows={2}
                          value={draft.corrective_action}
                          onChange={(e) => setDraft((d) => ({ ...d, corrective_action: e.target.value }))}
                          className={`${inputCls} mt-1 resize-none`}
                        />
                      </label>
                    </>
                  )}
                  <label className="block text-xs text-gray-600">
                    {t('woApproval.mechanicNote')}
                    <textarea
                      rows={2}
                      value={draft.mechanic_note}
                      onChange={(e) => setDraft((d) => ({ ...d, mechanic_note: e.target.value }))}
                      className={`${inputCls} mt-1 resize-none`}
                    />
                  </label>
                </div>
              ) : (
                <>
                  {wo.diagnosis && (
                    <p className="text-sm text-gray-300">
                      <span className="text-gray-600">{t('woApproval.diagnosis')}: </span>{wo.diagnosis}
                    </p>
                  )}
                  {wo.corrective_action && (
                    <p className="text-sm text-gray-300">
                      <span className="text-gray-600">{t('woApproval.correctiveAction')}: </span>{wo.corrective_action}
                    </p>
                  )}
                  {wo.mechanic_note && (
                    <p className="text-sm text-gray-300">
                      <span className="text-gray-600">{t('woApproval.mechanicNote')}: </span>{wo.mechanic_note}
                    </p>
                  )}
                </>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 pt-1">
                {wo.total_downtime_minutes != null && (
                  <span>{t('woApproval.downtime')}: <span className="text-gray-300">{humanMinutes(wo.total_downtime_minutes)}</span></span>
                )}
                {wo.intervention_duration_minutes != null && (
                  <span>{t('woApproval.duration')}: <span className="text-gray-300">{humanMinutes(wo.intervention_duration_minutes)}</span></span>
                )}
                {wo.response_time_minutes != null && (
                  <span>{t('woApproval.response')}: <span className="text-gray-300">{humanMinutes(wo.response_time_minutes)}</span></span>
                )}
              </div>
            </div>

            {/* Parts used */}
            <div className="px-4 py-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold flex items-center gap-1.5">
                  <Package size={12} /> {t('woApproval.partsUsed')}
                </p>
                {wo.parts.length > 0 && (
                  <p className="text-xs text-gray-500">
                    {t('woApproval.partsTotal')}: <span className="font-mono text-emerald-400">${wo.parts_total.toFixed(2)}</span>
                  </p>
                )}
              </div>

              {wo.parts.length === 0 && !editing && (
                <p className="text-xs text-gray-600 italic">{t('woApproval.noParts')}</p>
              )}

              {wo.parts.map((part) => (
                <div key={part.id} className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm truncate ${part.approval_status === 'rejected' ? 'text-gray-600 line-through' : 'text-gray-200'}`}>
                      {part.item_description || part.item_code || '—'}
                    </p>
                    <p className="text-xs text-gray-600 mt-0.5">
                      {part.item_code && <span className="mr-2 font-mono">{part.item_code}</span>}
                      {!(editing && part.approval_status !== 'rejected') && <>{part.quantity_used} {part.unit || 'un'}</>}
                      {part.total_cost != null && (
                        <span className="ml-2 font-mono text-emerald-400/80">${part.total_cost.toFixed(2)}</span>
                      )}
                    </p>
                    {part.approval_status === 'rejected' && part.rejection_reason && (
                      <p className="text-xs text-red-400/70 italic">{part.rejection_reason}</p>
                    )}
                  </div>
                  {editing && part.approval_status !== 'rejected' ? (
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <input
                        value={qtyDraft[part.id] ?? String(part.quantity_used)}
                        onChange={(e) => setQtyDraft((prev) => ({ ...prev, [part.id]: e.target.value }))}
                        onBlur={() => commitQty(wo, part)}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        inputMode="decimal"
                        title={t('woApproval.qty')}
                        className="w-16 bg-[#0d1117] border border-[#30363d] rounded-lg px-2 py-1 text-sm text-gray-200 text-right outline-none"
                      />
                      <span className="text-xs text-gray-600 w-8 truncate">{part.unit || 'un'}</span>
                      <button
                        disabled={acting === part.id}
                        onClick={() => removePart(wo, part)}
                        title={t('woApproval.removePart')}
                        className="text-gray-600 hover:text-red-400 transition-colors disabled:opacity-40"
                      >
                        {acting === part.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                      </button>
                    </div>
                  ) : part.approval_status === 'rejected' ? (
                    <span className="flex items-center gap-1 text-xs text-red-400 flex-shrink-0">
                      <XCircle size={11} /> {t('woApproval.rejected')}
                    </span>
                  ) : wo.supports_part_reject && !editing ? (
                    <button
                      disabled={acting === part.id}
                      onClick={() => rejectPart(wo.id, part.id)}
                      title={t('woApproval.rejectPart')}
                      className="text-gray-600 hover:text-red-400 transition-colors flex-shrink-0 disabled:opacity-40"
                    >
                      {acting === part.id ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
                    </button>
                  ) : null}
                </div>
              ))}

              {/* Add part (edit mode) */}
              {editing && (
                <div className="relative pt-1">
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-600" />
                      <input
                        value={partQuery}
                        onChange={(e) => setPartQuery(e.target.value)}
                        placeholder={t('woApproval.searchPart')}
                        className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg pl-8 pr-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 outline-none"
                      />
                    </div>
                    <input
                      value={partQty}
                      onChange={(e) => setPartQty(e.target.value)}
                      inputMode="decimal"
                      title={t('woApproval.qty')}
                      className="w-16 bg-[#0d1117] border border-[#30363d] rounded-lg px-2 py-1.5 text-sm text-gray-200 text-right outline-none"
                    />
                  </div>
                  {partQuery.trim().length >= 2 && (
                    // In-flow (not absolute): the card clips overflow, so a floating
                    // dropdown would be cut off after the first result.
                    <div className="mt-1 rounded-lg shadow-xl max-h-64 overflow-y-auto"
                      style={{ background: '#161b22', border: '1px solid #30363d' }}>
                      {partResults.map((r) => (
                        <button
                          key={r.id}
                          disabled={acting === `add-${wo.id}`}
                          onClick={() => addPart(wo, r)}
                          className="w-full text-left px-3 py-2 hover:bg-white/5 transition-colors disabled:opacity-40"
                        >
                          <p className="text-sm text-gray-200 truncate">{r.name || r.description || r.code}</p>
                          <p className="text-xs text-gray-600">
                            {r.code && <span className="font-mono mr-2">{r.code}</span>}
                            {r.quantity} {r.unit}
                          </p>
                        </button>
                      ))}
                      {partResults.length === 0 && (
                        <p className="px-3 py-2 text-xs text-gray-600 italic">{t('woApproval.noResults')}</p>
                      )}
                      <button
                        disabled={acting === `add-${wo.id}`}
                        onClick={() => addPart(wo, null)}
                        className="w-full text-left px-3 py-2 border-t border-white/5 text-xs text-blue-400 hover:bg-white/5 transition-colors disabled:opacity-40"
                      >
                        {acting === `add-${wo.id}`
                          ? <Loader2 size={12} className="animate-spin" />
                          : t('woApproval.addAsText', { text: partQuery.trim() })}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="px-4 py-3 border-t border-white/5" style={{ background: '#0f1117' }}>
              {editing ? (
                <div className="flex gap-2 justify-end">
                  <button
                    disabled={busy}
                    onClick={() => setEditingId(null)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-400 transition-all disabled:opacity-40"
                    style={{ background: '#1c2128', border: '1px solid #30363d' }}>
                    {t('common.cancel')}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => saveEdit(wo)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-all disabled:opacity-40"
                    style={{ background: '#1d4ed8', border: '1px solid #3b82f6' }}>
                    {busy ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle size={13} />}
                    {t('common.save')}
                  </button>
                </div>
              ) : rejectingId === wo.id ? (
                <div className="flex gap-2 items-center">
                  <AlertCircle size={14} className="text-amber-400 flex-shrink-0" />
                  <input
                    autoFocus
                    value={rejectReason[wo.id] ?? ''}
                    onChange={(e) => setRejectReason((prev) => ({ ...prev, [wo.id]: e.target.value }))}
                    placeholder={t('woApproval.rejectReason')}
                    className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 outline-none"
                  />
                  <button onClick={() => reject(wo)} disabled={busy}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40"
                    style={{ background: '#7f1d1d' }}>
                    {busy ? <Loader2 size={12} className="animate-spin" /> : t('woApproval.confirm')}
                  </button>
                  <button onClick={() => setRejectingId(null)} className="text-gray-600 hover:text-gray-400 transition-colors">
                    <XCircle size={16} />
                  </button>
                </div>
              ) : (
                <div className="flex gap-2 justify-end items-center flex-wrap">
                  <div className="flex flex-col mr-auto">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-gray-500 uppercase tracking-wide">{t('woApproval.costCenter')}</span>
                      <select
                        value={ccChoice[wo.id] ?? wo.cost_center ?? wo.default_cost_center ?? ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          setCcChoice((prev) => ({ ...prev, [wo.id]: v }));
                          setCcError((prev) => ({ ...prev, [wo.id]: false }));
                        }}
                        className={`bg-[#0d1117] border rounded-lg px-2 py-1.5 text-sm text-gray-200 outline-none ${
                          ccError[wo.id] ? 'border-red-500' : 'border-[#30363d]'}`}>
                        <option value="">{t('woApproval.selectCostCenter')}</option>
                        {costCenters.map((cc) => (
                          <option key={cc.name} value={cc.name}>{cc.code ? `${cc.code} · ${cc.name}` : cc.name}</option>
                        ))}
                      </select>
                    </div>
                    {ccError[wo.id] && <span className="text-[11px] text-red-400 mt-0.5">{t('woApproval.costCenterRequired')}</span>}
                  </div>
                  <button
                    disabled={busy}
                    onClick={() => setRejectingId(wo.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all disabled:opacity-40"
                    style={{ background: '#2d0a0a', border: '1px solid #ef444440', color: '#f87171' }}>
                    <XCircle size={13} /> {t('woApproval.reject')}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => approve(wo)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-all disabled:opacity-40"
                    style={{ background: '#166534', border: '1px solid #22c55e' }}>
                    {busy ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle size={13} />}
                    {t('woApproval.approve')}
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
