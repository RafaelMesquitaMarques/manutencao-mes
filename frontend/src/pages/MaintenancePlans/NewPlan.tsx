import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, CalendarClock, AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { fetchEquipment, fetchTechniciansFull } from '../../api/workOrders';
import { fetchPmTemplates } from '../../api/pmTemplates';
import { createMaintenancePlan, type RecommendedPartInput } from '../../api/maintenancePlans';
import type { Equipment, TechnicianFull, PmTemplate, PmFrequency, RecurrenceEndType } from '../../types';
import Spinner from '../../components/ui/Spinner';

const FREQUENCIES: PmFrequency[] = ['daily', 'weekly', 'monthly', 'quarterly', 'semiannual', 'annual'];
const PLAN_TYPES = ['preventive', 'predictive', 'inspection', 'calibration', 'lubrication'];

const PRIORITIES: { value: string; color: string }[] = [
  { value: 'low',      color: 'text-gray-400 border-gray-500/40' },
  { value: 'medium',   color: 'text-sky-400 border-sky-500/40' },
  { value: 'high',     color: 'text-amber-400 border-amber-500/40' },
  { value: 'critical', color: 'text-red-400 border-red-500/40' },
];

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]; // Monday=0 ... Sunday=6 (matches Python date.weekday())

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function NewPlan() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [equipmentList, setEquipmentList] = useState<Equipment[]>([]);
  const [technicians, setTechnicians] = useState<TechnicianFull[]>([]);
  const [templates, setTemplates] = useState<PmTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [equipmentId, setEquipmentId] = useState(params.get('equipmentId') ?? '');
  const [pmTemplateId, setPmTemplateId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [planType, setPlanType] = useState('preventive');

  const [frequencyType, setFrequencyType] = useState<PmFrequency>('monthly');
  const [frequencyValue, setFrequencyValue] = useState(1);
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [frequencyDays, setFrequencyDays] = useState('');
  const [frequencyHours, setFrequencyHours] = useState('');
  const [startDate, setStartDate] = useState(todayISO());

  const [recurrenceEndType, setRecurrenceEndType] = useState<RecurrenceEndType>('never');
  const [recurrenceEndValue, setRecurrenceEndValue] = useState('');
  const [recurrenceEndDate, setRecurrenceEndDate] = useState('');

  const [leadTimeDays, setLeadTimeDays] = useState(3);
  const [assignedTechnicianId, setAssignedTechnicianId] = useState('');
  const [priority, setPriority] = useState('medium');
  const [estimatedHours, setEstimatedHours] = useState(1);

  const [recommendedParts, setRecommendedParts] = useState<RecommendedPartInput[]>([]);

  useEffect(() => {
    Promise.all([fetchEquipment(), fetchTechniciansFull()])
      .then(([eq, techs]) => {
        setEquipmentList(eq);
        setTechnicians(techs);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!equipmentId) {
      setTemplates([]);
      setPmTemplateId('');
      return;
    }
    fetchPmTemplates({ equipment_id: equipmentId, is_active: true })
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, [equipmentId]);

  const handleTemplateChange = useCallback((id: string) => {
    setPmTemplateId(id);
    const tpl = templates.find((x) => x.id === id);
    if (tpl) {
      if (!name) setName(tpl.name);
      setFrequencyType(tpl.frequency_type);
      setEstimatedHours(tpl.estimated_hours);
    }
  }, [templates, name]);

  const toggleWeekday = (d: number) => {
    setWeekdays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort());
  };

  const addPart = () => {
    setRecommendedParts((prev) => [...prev, { item_code: '', item_description: '', quantity_recommended: 1, unit: '' }]);
  };

  const updatePart = (index: number, field: keyof RecommendedPartInput, value: string | number) => {
    setRecommendedParts((prev) => prev.map((p, i) => i === index ? { ...p, [field]: value } : p));
  };

  const removePart = (index: number) => {
    setRecommendedParts((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!equipmentId || !name || !frequencyType || !startDate) {
      setError(t('pm.requiredFields'));
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      await createMaintenancePlan({
        equipment_id: equipmentId,
        name,
        description: description || undefined,
        pm_template_id: pmTemplateId || undefined,
        plan_type: planType,
        frequency_type: frequencyType,
        frequency_value: frequencyValue || 1,
        frequency_days: frequencyDays ? Number(frequencyDays) : undefined,
        frequency_hours: frequencyHours ? Number(frequencyHours) : undefined,
        weekdays: frequencyType === 'weekly' && weekdays.length > 0 ? weekdays.join(',') : undefined,
        start_date: startDate,
        recurrence_end_type: recurrenceEndType,
        recurrence_end_value: recurrenceEndType === 'after_occurrences' && recurrenceEndValue ? Number(recurrenceEndValue) : undefined,
        recurrence_end_date: recurrenceEndType === 'on_date' && recurrenceEndDate ? recurrenceEndDate : undefined,
        lead_time_days: leadTimeDays,
        assigned_technician_id: assignedTechnicianId || undefined,
        priority,
        estimated_hours: estimatedHours,
        recommended_parts: recommendedParts.filter((p) => p.item_code || p.item_description),
      });
      navigate('/maintenance/plans');
    } catch {
      setError(t('pm.createError'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/maintenance/plans')} className="btn-secondary py-1.5 px-3">
          <ArrowLeft size={15} />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <CalendarClock size={22} className="text-blue-400" />
            {t('pm.newPlan')}
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">{t('pm.newPlanSubtitle')}</p>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
          <AlertTriangle size={15} className="text-red-400 flex-shrink-0" />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Basic info */}
        <div className="glass-card p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">{t('pm.basicInfo')}</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">{t('pm.equipment')} *</label>
              <select value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)} className="select-field" required>
                <option value="">{t('pm.selectEquipment')}</option>
                {equipmentList.map((eq) => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">{t('pm.template')}</label>
              <select value={pmTemplateId} onChange={(e) => handleTemplateChange(e.target.value)} className="select-field" disabled={!equipmentId}>
                <option value="">{t('pm.noTemplate')}</option>
                {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name} ({t(`pmFrequency.${tpl.frequency_type}`)})</option>)}
              </select>
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">{t('pm.name')} *</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="input-field" placeholder={t('pm.namePlaceholder')} required />
            </div>
            <div>
              <label className="label">{t('pm.planType')}</label>
              <select value={planType} onChange={(e) => setPlanType(e.target.value)} className="select-field">
                {PLAN_TYPES.map((pt) => <option key={pt} value={pt}>{t(`pm.planTypeOption.${pt}`, pt)}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="label">{t('common.description')}</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="input-field resize-none" placeholder={t('pm.descriptionPlaceholder')} />
          </div>
        </div>

        {/* Recurrence */}
        <div className="glass-card p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">{t('pm.recurrence')}</h2>
          <div className="grid sm:grid-cols-3 gap-4">
            <div>
              <label className="label">{t('pm.frequencyType')} *</label>
              <select value={frequencyType} onChange={(e) => setFrequencyType(e.target.value as PmFrequency)} className="select-field" required>
                {FREQUENCIES.map((f) => <option key={f} value={f}>{t(`pmFrequency.${f}`)}</option>)}
              </select>
            </div>
            <div>
              <label className="label">{t('pm.frequencyValue')}</label>
              <input type="number" min={1} value={frequencyValue} onChange={(e) => setFrequencyValue(Number(e.target.value))} className="input-field" />
              <p className="text-xs text-gray-600 mt-1">{t('pm.frequencyValueHint', { unit: t(`pmFrequency.unit.${frequencyType}`) })}</p>
            </div>
            <div>
              <label className="label">{t('pm.startDate')} *</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="input-field" required />
            </div>
          </div>

          {frequencyType === 'weekly' && (
            <div>
              <label className="label">{t('pm.weekdays')}</label>
              <div className="flex flex-wrap gap-2">
                {WEEKDAYS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleWeekday(d)}
                    className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-all ${
                      weekdays.includes(d)
                        ? 'text-blue-400 border-blue-500/40 bg-white/[0.08]'
                        : 'border-white/10 text-gray-500 hover:border-white/20'
                    }`}
                  >
                    {t(`pm.weekday.${d}`)}
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-600 mt-1">{t('pm.weekdaysHint')}</p>
            </div>
          )}

          <div className="grid sm:grid-cols-2 gap-4 pt-2 border-t border-white/[0.06]">
            <div>
              <label className="label">{t('pm.frequencyDays')}</label>
              <input type="number" min={1} value={frequencyDays} onChange={(e) => setFrequencyDays(e.target.value)} className="input-field" placeholder={t('pm.frequencyDaysPlaceholder')} />
              <p className="text-xs text-gray-600 mt-1">{t('pm.frequencyDaysHint')}</p>
            </div>
            <div>
              <label className="label">{t('pm.frequencyHours')}</label>
              <input type="number" min={0} step="0.5" value={frequencyHours} onChange={(e) => setFrequencyHours(e.target.value)} className="input-field" placeholder={t('pm.frequencyHoursPlaceholder')} />
              <p className="text-xs text-gray-600 mt-1">{t('pm.frequencyHoursHint')}</p>
            </div>
          </div>
        </div>

        {/* Recurrence end */}
        <div className="glass-card p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">{t('pm.recurrenceEnd')}</h2>
          <div className="flex flex-wrap gap-2">
            {(['never', 'after_occurrences', 'on_date'] as RecurrenceEndType[]).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setRecurrenceEndType(opt)}
                className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-all ${
                  recurrenceEndType === opt
                    ? 'text-blue-400 border-blue-500/40 bg-white/[0.08]'
                    : 'border-white/10 text-gray-500 hover:border-white/20'
                }`}
              >
                {t(`pm.recurrenceEndType.${opt}`)}
              </button>
            ))}
          </div>
          {recurrenceEndType === 'after_occurrences' && (
            <div className="max-w-xs">
              <label className="label">{t('pm.recurrenceEndValue')}</label>
              <input type="number" min={1} value={recurrenceEndValue} onChange={(e) => setRecurrenceEndValue(e.target.value)} className="input-field" />
            </div>
          )}
          {recurrenceEndType === 'on_date' && (
            <div className="max-w-xs">
              <label className="label">{t('pm.recurrenceEndDate')}</label>
              <input type="date" value={recurrenceEndDate} onChange={(e) => setRecurrenceEndDate(e.target.value)} className="input-field" />
            </div>
          )}
        </div>

        {/* Scheduling & assignment */}
        <div className="glass-card p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">{t('pm.schedulingAssignment')}</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">{t('pm.leadTimeDays')}</label>
              <input type="number" min={0} value={leadTimeDays} onChange={(e) => setLeadTimeDays(Number(e.target.value))} className="input-field" />
              <p className="text-xs text-gray-600 mt-1">{t('pm.leadTimeDaysHint')}</p>
            </div>
            <div>
              <label className="label">{t('pm.estimatedHours')}</label>
              <input type="number" min={0} step="0.5" value={estimatedHours} onChange={(e) => setEstimatedHours(Number(e.target.value))} className="input-field" />
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">{t('pm.assignedTechnician')}</label>
              <select value={assignedTechnicianId} onChange={(e) => setAssignedTechnicianId(e.target.value)} className="select-field">
                <option value="">{t('pm.unassigned')}</option>
                {technicians.map((tech) => <option key={tech.id} value={tech.id}>{tech.full_name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">{t('common.priority')}</label>
              <div className="flex flex-wrap gap-2">
                {PRIORITIES.map(({ value, color }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setPriority(value)}
                    className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-all ${
                      priority === value ? `${color} bg-white/[0.08]` : 'border-white/10 text-gray-500 hover:border-white/20'
                    }`}
                  >
                    {t(`priority.${value}`, value)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Recommended parts */}
        <div className="glass-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">{t('pm.recommendedParts')}</h2>
            <button type="button" onClick={addPart} className="btn-secondary py-1 px-2.5 text-xs gap-1">
              <Plus size={13} />
              {t('pm.addPart')}
            </button>
          </div>
          {recommendedParts.length === 0 ? (
            <p className="text-gray-600 text-sm">{t('pm.noRecommendedParts')}</p>
          ) : (
            <div className="space-y-2">
              {recommendedParts.map((part, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                  <input
                    type="text"
                    value={part.item_code ?? ''}
                    onChange={(e) => updatePart(idx, 'item_code', e.target.value)}
                    placeholder={t('pm.partCode')}
                    className="input-field col-span-3 py-1.5 text-sm"
                  />
                  <input
                    type="text"
                    value={part.item_description ?? ''}
                    onChange={(e) => updatePart(idx, 'item_description', e.target.value)}
                    placeholder={t('pm.partDescription')}
                    className="input-field col-span-5 py-1.5 text-sm"
                  />
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={part.quantity_recommended ?? 1}
                    onChange={(e) => updatePart(idx, 'quantity_recommended', Number(e.target.value))}
                    placeholder={t('pm.partQuantity')}
                    className="input-field col-span-2 py-1.5 text-sm"
                  />
                  <input
                    type="text"
                    value={part.unit ?? ''}
                    onChange={(e) => updatePart(idx, 'unit', e.target.value)}
                    placeholder={t('pm.partUnit')}
                    className="input-field col-span-1 py-1.5 text-sm"
                  />
                  <button type="button" onClick={() => removePart(idx)} className="col-span-1 text-gray-500 hover:text-red-400 flex justify-center">
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={() => navigate('/maintenance/plans')} className="btn-secondary">
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? (
              <>
                <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                {t('pm.creating')}
              </>
            ) : (
              t('pm.createPlan')
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
