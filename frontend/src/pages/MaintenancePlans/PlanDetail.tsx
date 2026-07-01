import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, CalendarClock, AlertTriangle, Pencil, Check, X, Trash2,
  Power, PlayCircle, Ban, ExternalLink, Package, ListChecks, Plus,
} from 'lucide-react';
import {
  fetchMaintenancePlan, updateMaintenancePlan, deleteMaintenancePlan,
  fetchPlanOccurrences, overrideOccurrence, cancelOccurrence, generateOccurrenceWO,
} from '../../api/maintenancePlans';
import { fetchPmTemplate, fetchPmTemplates, createPmTemplate } from '../../api/pmTemplates';
import { fetchTechniciansFull } from '../../api/workOrders';
import type { MaintenancePlan, PlanOccurrence, TechnicianFull, OccurrenceStatus, OccurrenceCompliance, PmTemplate } from '../../types';
import Spinner from '../../components/ui/Spinner';
import PmStepsEditor from '../../components/pm/PmStepsEditor';
import { useRole } from '../../hooks/usePermission';

const STATUS_BADGE: Record<OccurrenceStatus, string> = {
  scheduled:   'bg-sky-500/15 text-sky-400 border-sky-500/25',
  in_progress: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
  completed:   'bg-green-500/15 text-green-400 border-green-500/25',
  skipped:     'bg-gray-500/15 text-gray-400 border-gray-500/25',
  cancelled:   'bg-gray-500/15 text-gray-400 border-gray-500/25',
};

const COMPLIANCE_BADGE: Record<OccurrenceCompliance, string> = {
  on_time: 'bg-green-500/15 text-green-400 border-green-500/25',
  early:   'bg-sky-500/15 text-sky-400 border-sky-500/25',
  late:    'bg-red-500/15 text-red-400 border-red-500/25',
};

const PRIORITIES = ['low', 'medium', 'high', 'critical'];

function Field({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div>
      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-gray-200 text-sm">{value ?? '—'}</p>
    </div>
  );
}

function formatFrequency(plan: MaintenancePlan, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!plan.frequency_type) return '—';
  const value = plan.frequency_value ?? 1;
  if (value <= 1) return t(`pmFrequency.${plan.frequency_type}`);
  return `${t('pm.every')} ${value} ${t(`pmFrequency.unit.${plan.frequency_type}`)}`;
}

function formatRecurrenceEnd(plan: MaintenancePlan, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!plan.recurrence_end_type || plan.recurrence_end_type === 'never') return t('pm.recurrenceEndType.never');
  if (plan.recurrence_end_type === 'after_occurrences') {
    return t('pm.recurrenceEndAfter', { count: plan.recurrence_end_value ?? 0 });
  }
  return t('pm.recurrenceEndOn', { date: plan.recurrence_end_date });
}

export default function PlanDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  // Managing a plan (activate/deactivate/delete, occurrences) is a supervisor+ task;
  // technicians may view it but not change it.
  const canManagePlan = useRole('supervisor', 'maintenance_director', 'plant_manager', 'director', 'admin');

  const [plan, setPlan] = useState<MaintenancePlan | null>(null);
  const [occurrences, setOccurrences] = useState<PlanOccurrence[]>([]);
  const [technicians, setTechnicians] = useState<TechnicianFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actioning, setActioning] = useState(false);

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editPriority, setEditPriority] = useState('medium');
  const [editTechnicianId, setEditTechnicianId] = useState('');
  const [editEstimatedHours, setEditEstimatedHours] = useState(1);
  const [editLeadTimeDays, setEditLeadTimeDays] = useState(3);
  const [editTemplateId, setEditTemplateId] = useState('');
  const [templates, setTemplates] = useState<PmTemplate[]>([]);

  const [editingOccurrenceId, setEditingOccurrenceId] = useState<string | null>(null);
  const [overrideDate, setOverrideDate] = useState('');
  const [overrideNote, setOverrideNote] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [p, occ] = await Promise.all([fetchMaintenancePlan(id), fetchPlanOccurrences(id)]);
      setPlan(p);
      setOccurrences(occ);
      setEditName(p.name);
      setEditDescription(p.description ?? '');
      setEditPriority(p.priority ?? 'medium');
      setEditTechnicianId(p.assigned_technician_id ?? '');
      setEditEstimatedHours(p.estimated_hours ?? 1);
      setEditLeadTimeDays(p.lead_time_days ?? 3);
      setEditTemplateId(p.pm_template_id ?? '');
    } catch {
      setError(t('pm.planNotFound'));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetchTechniciansFull().then(setTechnicians).catch(() => {});
  }, []);

  useEffect(() => {
    if (!plan?.equipment_id) return;
    fetchPmTemplates({ equipment_id: plan.equipment_id, is_active: true }).then(setTemplates).catch(() => {});
  }, [plan?.equipment_id]);

  const handleSaveEdit = async () => {
    if (!plan) return;
    setActioning(true);
    try {
      const updated = await updateMaintenancePlan(plan.id, {
        name: editName,
        description: editDescription || undefined,
        priority: editPriority,
        assigned_technician_id: editTechnicianId || undefined,
        estimated_hours: editEstimatedHours,
        lead_time_days: editLeadTimeDays,
        pm_template_id: editTemplateId || null,
      });
      setPlan(updated);
      setEditing(false);
    } catch {
      setError(t('pm.updateError'));
    } finally {
      setActioning(false);
    }
  };

  const handleToggleActive = async () => {
    if (!plan) return;
    setActioning(true);
    try {
      const updated = await updateMaintenancePlan(plan.id, { is_active: !plan.is_active });
      setPlan(updated);
    } catch {
      setError(t('pm.updateError'));
    } finally {
      setActioning(false);
    }
  };

  const handleDelete = async () => {
    if (!plan) return;
    if (!confirm(t('pm.confirmDeletePlan'))) return;
    setActioning(true);
    try {
      await deleteMaintenancePlan(plan.id);
      navigate('/maintenance/plans');
    } catch {
      setError(t('pm.deleteError'));
      setActioning(false);
    }
  };

  const startOverride = (occ: PlanOccurrence) => {
    setEditingOccurrenceId(occ.id);
    setOverrideDate(occ.override_date ?? occ.scheduled_date);
    setOverrideNote(occ.override_note ?? '');
  };

  const handleSaveOverride = async (occId: string) => {
    setActioning(true);
    try {
      const updated = await overrideOccurrence(occId, { override_date: overrideDate, override_note: overrideNote || undefined });
      setOccurrences((prev) => prev.map((o) => o.id === occId ? updated : o));
      setEditingOccurrenceId(null);
    } catch {
      setError(t('pm.updateError'));
    } finally {
      setActioning(false);
    }
  };

  const handleCancelOccurrence = async (occ: PlanOccurrence) => {
    if (!confirm(t('pm.confirmCancelOccurrence'))) return;
    const reason = window.prompt(t('pm.cancelReasonPrompt')) ?? undefined;
    setActioning(true);
    try {
      const updated = await cancelOccurrence(occ.id, { cancel_reason: reason });
      setOccurrences((prev) => prev.map((o) => o.id === occ.id ? updated : o));
    } catch {
      setError(t('pm.updateError'));
    } finally {
      setActioning(false);
    }
  };

  const handleGenerateWO = async (occ: PlanOccurrence) => {
    setActioning(true);
    try {
      const updated = await generateOccurrenceWO(occ.id);
      setOccurrences((prev) => prev.map((o) => o.id === occ.id ? updated : o));
    } catch {
      setError(t('pm.updateError'));
    } finally {
      setActioning(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!plan) {
    return <div className="p-6 text-gray-500">{error || t('pm.planNotFound')}</div>;
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/maintenance/plans')} className="btn-secondary py-1.5 px-3">
          <ArrowLeft size={15} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <CalendarClock size={22} className="text-blue-400 flex-shrink-0" />
            {plan.name}
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {plan.equipment_name && (
              <Link to={`/equipment/${plan.equipment_id}`} className="text-blue-400 hover:text-blue-300">
                {plan.equipment_name}
              </Link>
            )}
            {plan.pm_template_name && <span> · {plan.pm_template_name}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {plan.is_active ? (
            <span className="inline-flex items-center px-2.5 py-1 text-xs font-mono font-medium border rounded bg-green-500/15 text-green-400 border-green-500/25">
              {t('pm.active')}
            </span>
          ) : (
            <span className="inline-flex items-center px-2.5 py-1 text-xs font-mono font-medium border rounded bg-gray-500/15 text-gray-400 border-gray-500/25">
              {t('pm.inactive')}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
          <AlertTriangle size={15} className="text-red-400 flex-shrink-0" />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {/* Detail card */}
      <div className="glass-card p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">{t('pm.planDetails')}</h2>
          {!editing ? (
            <button onClick={() => setEditing(true)} className="btn-secondary py-1 px-2.5 text-xs gap-1">
              <Pencil size={13} />
              {t('common.edit')}
            </button>
          ) : (
            <div className="flex gap-2">
              <button onClick={handleSaveEdit} disabled={actioning} className="btn-primary py-1 px-2.5 text-xs gap-1">
                <Check size={13} />
                {t('common.save')}
              </button>
              <button onClick={() => setEditing(false)} className="btn-secondary py-1 px-2.5 text-xs gap-1">
                <X size={13} />
                {t('common.cancel')}
              </button>
            </div>
          )}
        </div>

        {!editing ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            <Field label={t('pm.equipment')} value={plan.equipment_name} />
            <Field label={t('pm.frequency')} value={formatFrequency(plan, t)} />
            <Field label={t('pm.nextDue')} value={plan.next_due_date} />
            {plan.next_due_hours != null && <Field label={t('pm.nextDueHours')} value={plan.next_due_hours} />}
            <Field label={t('pm.recurrenceEnd')} value={formatRecurrenceEnd(plan, t)} />
            <Field label={t('pm.totalOccurrences')} value={plan.total_occurrences ?? 0} />
            <Field label={t('pm.leadTimeDays')} value={plan.lead_time_days} />
            <Field label={t('pm.assignedTechnician')} value={plan.assigned_technician_name ?? t('pm.unassigned')} />
            <Field label={t('common.priority')} value={t(`priority.${plan.priority}`, plan.priority ?? '')} />
            <Field label={t('pm.estimatedHours')} value={plan.estimated_hours} />
            <Field label={t('pm.startDate')} value={plan.start_date} />
            <Field label={t('pm.planType')} value={t(`pm.planTypeOption.${plan.plan_type}`, plan.plan_type ?? '')} />
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="label">{t('pm.name')}</label>
              <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} className="input-field" />
            </div>
            <div className="sm:col-span-2">
              <label className="label">{t('common.description')}</label>
              <textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={2} className="input-field resize-none" />
            </div>
            <div className="sm:col-span-2">
              <label className="label">{t('pm.template', 'Procédure (modèle PM)')}</label>
              <select value={editTemplateId} onChange={(e) => setEditTemplateId(e.target.value)} className="select-field">
                <option value="">{t('pm.noTemplate', 'Aucun')}</option>
                {templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>{tpl.name} ({t(`pmFrequency.${tpl.frequency_type}`)})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">{t('common.priority')}</label>
              <select value={editPriority} onChange={(e) => setEditPriority(e.target.value)} className="select-field">
                {PRIORITIES.map((p) => <option key={p} value={p}>{t(`priority.${p}`, p)}</option>)}
              </select>
            </div>
            <div>
              <label className="label">{t('pm.assignedTechnician')}</label>
              <select value={editTechnicianId} onChange={(e) => setEditTechnicianId(e.target.value)} className="select-field">
                <option value="">{t('pm.unassigned')}</option>
                {technicians.map((tech) => <option key={tech.id} value={tech.id}>{tech.full_name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">{t('pm.estimatedHours')}</label>
              <input type="number" min={0} step="0.5" value={editEstimatedHours} onChange={(e) => setEditEstimatedHours(Number(e.target.value))} className="input-field" />
            </div>
            <div>
              <label className="label">{t('pm.leadTimeDays')}</label>
              <input type="number" min={0} value={editLeadTimeDays} onChange={(e) => setEditLeadTimeDays(Number(e.target.value))} className="input-field" />
            </div>
          </div>
        )}

        {plan.description && !editing && (
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{t('common.description')}</p>
            <p className="text-gray-300 text-sm whitespace-pre-wrap">{plan.description}</p>
          </div>
        )}

        {/* Recommended parts */}
        {plan.recommended_parts.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Package size={12} />
              {t('pm.recommendedParts')}
            </p>
            <div className="space-y-1">
              {plan.recommended_parts.map((part) => (
                <div key={part.id} className="flex items-center justify-between text-sm bg-white/[0.02] rounded px-3 py-1.5">
                  <span className="text-gray-300">
                    {part.item_code && <span className="font-mono text-gray-500 mr-2">{part.item_code}</span>}
                    {part.item_description}
                  </span>
                  <span className="text-gray-500">{part.quantity_recommended} {part.unit}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Procedure (SOP) — illustrated step-by-step */}
      <PlanProcedure plan={plan} onLinked={load} />

      {/* Plan actions — supervisor+ only */}
      {canManagePlan && (
        <div className="flex flex-wrap gap-3">
          <button onClick={handleToggleActive} disabled={actioning} className="btn-secondary gap-2">
            <Power size={15} />
            {plan.is_active ? t('pm.deactivate') : t('pm.activate')}
          </button>
          <button onClick={handleDelete} disabled={actioning} className="btn-secondary gap-2 text-red-400 hover:text-red-300">
            <Trash2 size={15} />
            {t('common.delete')}
          </button>
        </div>
      )}

      {/* Occurrences */}
      <div className="glass-card p-6 space-y-4">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">{t('pm.occurrences')}</h2>
        {occurrences.length === 0 ? (
          <p className="text-gray-600 text-sm">{t('pm.noOccurrences')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  <th className="text-left text-xs text-gray-600 font-medium px-3 py-2">{t('pm.scheduledDate')}</th>
                  <th className="text-left text-xs text-gray-600 font-medium px-3 py-2">{t('pm.status')}</th>
                  <th className="text-left text-xs text-gray-600 font-medium px-3 py-2">{t('pm.compliance')}</th>
                  <th className="text-left text-xs text-gray-600 font-medium px-3 py-2">{t('pm.workOrder')}</th>
                  <th className="text-right text-xs text-gray-600 font-medium px-3 py-2">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {occurrences.map((occ) => {
                  const overdue = !occ.is_cancelled && occ.status === 'scheduled' && occ.scheduled_date < today;
                  const isEditing = editingOccurrenceId === occ.id;
                  return (
                    <tr key={occ.id} className="border-b border-white/[0.03]">
                      <td className="px-3 py-2">
                        {isEditing ? (
                          <input type="date" value={overrideDate} onChange={(e) => setOverrideDate(e.target.value)} className="input-field py-1 text-xs" />
                        ) : (
                          <div>
                            <span className={overdue ? 'text-red-400 font-medium' : 'text-gray-300'}>{occ.scheduled_date}</span>
                            {occ.is_overridden && occ.override_date && (
                              <p className="text-amber-400 text-xs mt-0.5">{t('pm.overriddenTo', { date: occ.override_date })}</p>
                            )}
                            {occ.days_late != null && occ.days_late > 0 && occ.status !== 'completed' && (
                              <p className="text-red-400 text-xs mt-0.5">{t('pm.daysLate', { count: occ.days_late })}</p>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border rounded ${STATUS_BADGE[occ.status]}`}>
                          {t(`pm.occurrenceStatus.${occ.status}`, occ.status)}
                        </span>
                        {occ.is_cancelled && occ.cancel_reason && (
                          <p className="text-gray-500 text-xs mt-1">{occ.cancel_reason}</p>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {occ.compliance ? (
                          <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border rounded ${COMPLIANCE_BADGE[occ.compliance]}`}>
                            {t(`pm.complianceStatus.${occ.compliance}`, occ.compliance)}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-3 py-2">
                        {occ.work_order_id ? (
                          <Link to={`/work-orders/${occ.work_order_id}`} className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1">
                            {occ.work_order_number ?? t('pm.viewWO')}
                            <ExternalLink size={12} />
                          </Link>
                        ) : '—'}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1.5">
                          {canManagePlan && (isEditing ? (
                            <>
                              <input
                                type="text"
                                value={overrideNote}
                                onChange={(e) => setOverrideNote(e.target.value)}
                                placeholder={t('pm.overrideNotePlaceholder')}
                                className="input-field py-1 text-xs w-32"
                              />
                              <button onClick={() => handleSaveOverride(occ.id)} disabled={actioning} className="btn-secondary py-1 px-2 text-xs">
                                <Check size={12} />
                              </button>
                              <button onClick={() => setEditingOccurrenceId(null)} className="btn-secondary py-1 px-2 text-xs">
                                <X size={12} />
                              </button>
                            </>
                          ) : (
                            <>
                              {occ.status === 'scheduled' && !occ.is_cancelled && (
                                <>
                                  <button onClick={() => startOverride(occ)} disabled={actioning} title={t('pm.override')} className="btn-secondary py-1 px-2 text-xs">
                                    <Pencil size={12} />
                                  </button>
                                  <button onClick={() => handleCancelOccurrence(occ)} disabled={actioning} title={t('pm.cancelOccurrence')} className="btn-secondary py-1 px-2 text-xs text-red-400 hover:text-red-300">
                                    <Ban size={12} />
                                  </button>
                                  {!occ.work_order_id && (
                                    <button onClick={() => handleGenerateWO(occ)} disabled={actioning} title={t('pm.generateWO')} className="btn-secondary py-1 px-2 text-xs text-green-400 hover:text-green-300">
                                      <PlayCircle size={12} />
                                    </button>
                                  )}
                                </>
                              )}
                            </>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Procedure (SOP) section — illustrated steps from the linked PM template ──────────

function PlanProcedure({ plan, onLinked }: { plan: MaintenancePlan; onLinked: () => void }) {
  const { t } = useTranslation();
  const [tpl, setTpl] = useState<PmTemplate | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [allTemplates, setAllTemplates] = useState<PmTemplate[]>([]);

  const loadTpl = useCallback(async () => {
    if (!plan.pm_template_id) { setTpl(null); return; }
    setLoading(true);
    try { setTpl(await fetchPmTemplate(plan.pm_template_id)); }
    catch { setTpl(null); }
    finally { setLoading(false); }
  }, [plan.pm_template_id]);

  useEffect(() => { loadTpl(); }, [loadTpl]);

  const createProcedure = async () => {
    if (!plan.frequency_type) return;
    setCreating(true);
    try {
      const created = await createPmTemplate({
        equipment_id: plan.equipment_id,
        frequency_type: plan.frequency_type,
        name: plan.name,
        estimated_hours: plan.estimated_hours ?? 1,
      });
      await updateMaintenancePlan(plan.id, { pm_template_id: created.id });
      onLinked();
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    if (!plan.equipment_id) return;
    fetchPmTemplates({ equipment_id: plan.equipment_id, is_active: true }).then(setAllTemplates).catch(() => {});
  }, [plan.equipment_id]);

  const linkExisting = async (id: string) => {
    if (!id) return;
    await updateMaintenancePlan(plan.id, { pm_template_id: id });
    onLinked();
  };

  return (
    <div className="glass-card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide flex items-center gap-2">
          <ListChecks size={15} className="text-blue-400" />
          {t('pm.procedure', 'Procedure')}
        </h2>
        {tpl && (
          <Link to={`/equipment/${plan.equipment_id}`} className="text-xs text-gray-500 hover:text-gray-300 inline-flex items-center gap-1">
            {t('pm.manageOnEquipment', 'Manage on equipment')}
            <ExternalLink size={11} />
          </Link>
        )}
      </div>

      {tpl && (
        <p className="text-xs text-gray-600 -mt-2">
          {t('pm.procedureShared', 'Standard procedure for this equipment + frequency — reused by every plan that uses it.')}
        </p>
      )}

      {loading ? (
        <div className="py-6 flex justify-center"><Spinner size="md" /></div>
      ) : tpl ? (
        <PmStepsEditor template={tpl} onChange={loadTpl} />
      ) : (
        <div className="text-center py-6 space-y-3">
          <p className="text-gray-500 text-sm">{t('pm.noProcedureYet', 'No step-by-step procedure yet for this plan.')}</p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {allTemplates.length > 0 && (
              <select
                defaultValue=""
                onChange={(e) => linkExisting(e.target.value)}
                className="select-field max-w-xs"
              >
                <option value="" disabled>{t('pm.linkExistingTemplate', 'Lier un modèle existant…')}</option>
                {allTemplates.map((x) => (
                  <option key={x.id} value={x.id}>{x.name} ({t(`pmFrequency.${x.frequency_type}`)})</option>
                ))}
              </select>
            )}
            <button onClick={createProcedure} disabled={creating} className="btn-primary gap-2">
              {creating ? <Spinner size="sm" /> : <Plus size={15} />}
              {t('pm.createProcedure', 'Create procedure')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
