import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Plus, AlertCircle, ChevronDown } from 'lucide-react';
import {
  createWorkOrder,
  fetchEquipment,
  fetchTechnicians,
} from '../../api/workOrders';
import type { WorkOrderType, Priority, Equipment, Technician } from '../../types';
import Spinner from '../../components/ui/Spinner';

interface FormState {
  title: string;
  description: string;
  type: string;
  priority: string;
  equipment_id: string;
  assigned_to_id: string;
  due_date: string;
  estimated_hours: string;
  notes: string;
}

const TYPES: WorkOrderType[] = ['corrective', 'preventive', 'predictive', 'inspection', 'improvement'];
const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'critical'];

const SelectWrapper = ({ children }: { children: React.ReactNode }) => (
  <div className="relative">
    {children}
    <ChevronDown
      size={14}
      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none"
    />
  </div>
);

const NewWorkOrder = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(true);

  const [form, setForm] = useState<FormState>({
    title: '',
    description: '',
    type: '',
    priority: '',
    equipment_id: '',
    assigned_to_id: '',
    due_date: '',
    estimated_hours: '',
    notes: '',
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [eq, tech] = await Promise.all([fetchEquipment(), fetchTechnicians()]);
        setEquipment(eq);
        setTechnicians(tech);
      } catch {
        // options not critical
      } finally {
        setLoadingOptions(false);
      }
    };
    load();
  }, []);

  const set = (field: keyof FormState, value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!form.title || !form.description || !form.type || !form.priority || !form.equipment_id) {
      setError(t('form.requiredFields'));
      return;
    }

    setIsSubmitting(true);
    try {
      const wo = await createWorkOrder({
        equipment_id: form.equipment_id,
        type: form.type as WorkOrderType,
        priority: form.priority as Priority,
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        due_date: form.due_date || undefined,
        assigned_to_id: form.assigned_to_id || undefined,
        estimated_hours: form.estimated_hours ? Number(form.estimated_hours) : undefined,
        notes: form.notes.trim() || undefined,
      });
      navigate(`/work-orders/${wo.id}`);
    } catch {
      setError(t('common.error'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-5 animate-fade-in max-w-3xl">
      {/* Header */}
      <div>
        <button
          onClick={() => navigate('/work-orders')}
          className="flex items-center gap-1.5 text-gray-500 hover:text-gray-300 transition-colors text-sm mb-4"
        >
          <ArrowLeft size={15} />
          {t('workOrders.title')}
        </button>
        <h1 className="text-2xl font-bold text-white">{t('form.newWorkOrderTitle')}</h1>
        <p className="text-gray-500 text-sm mt-1">{t('form.newWorkOrderSubtitle')}</p>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
          <AlertCircle size={15} className="text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Title */}
        <div className="glass-card p-5 space-y-4">
          <h2 className="text-white font-medium text-sm border-b border-white/[0.06] pb-3 -mt-1">
            General Information
          </h2>

          <div>
            <label className="label">{t('form.titleLabel')}</label>
            <input
              type="text"
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder={t('form.titlePlaceholder')}
              className="input-field"
              maxLength={200}
              required
              disabled={isSubmitting}
            />
          </div>

          <div>
            <label className="label">{t('form.descriptionLabel')}</label>
            <textarea
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder={t('form.descriptionPlaceholder')}
              className="input-field resize-none"
              rows={4}
              required
              disabled={isSubmitting}
            />
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">{t('form.typeLabel')}</label>
              <SelectWrapper>
                <select
                  value={form.type}
                  onChange={(e) => set('type', e.target.value)}
                  className="select-field pr-8"
                  required
                  disabled={isSubmitting}
                >
                  <option value="">{t('form.selectType')}</option>
                  {TYPES.map((tp) => (
                    <option key={tp} value={tp}>{t(`type.${tp}`)}</option>
                  ))}
                </select>
              </SelectWrapper>
            </div>
            <div>
              <label className="label">{t('form.priorityLabel')}</label>
              <SelectWrapper>
                <select
                  value={form.priority}
                  onChange={(e) => set('priority', e.target.value)}
                  className="select-field pr-8"
                  required
                  disabled={isSubmitting}
                >
                  <option value="">{t('form.selectPriority')}</option>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>{t(`priority.${p}`)}</option>
                  ))}
                </select>
              </SelectWrapper>
            </div>
          </div>
        </div>

        {/* Equipment + Assignment */}
        <div className="glass-card p-5 space-y-4">
          <h2 className="text-white font-medium text-sm border-b border-white/[0.06] pb-3 -mt-1">
            Equipment &amp; Assignment
          </h2>

          <div>
            <label className="label">{t('form.equipmentLabel')}</label>
            <SelectWrapper>
              <select
                value={form.equipment_id}
                onChange={(e) => set('equipment_id', e.target.value)}
                className="select-field pr-8"
                required
                disabled={isSubmitting || loadingOptions}
              >
                <option value="">{loadingOptions ? t('common.loading') : t('form.selectEquipment')}</option>
                {equipment.map((eq) => (
                  <option key={String(eq.id)} value={String(eq.id)}>
                    {eq.name} {eq.code ? `(${eq.code})` : ''}{eq.location ? ` — ${eq.location}` : ''}
                  </option>
                ))}
              </select>
            </SelectWrapper>
          </div>

          <div>
            <label className="label">{t('form.assignedToLabel')}</label>
            <SelectWrapper>
              <select
                value={form.assigned_to_id}
                onChange={(e) => set('assigned_to_id', e.target.value)}
                className="select-field pr-8"
                disabled={isSubmitting || loadingOptions}
              >
                <option value="">{loadingOptions ? t('common.loading') : t('form.selectTechnician')}</option>
                {technicians.map((tech) => (
                  <option key={tech.id} value={tech.id}>
                    {tech.full_name}{tech.specialty ? ` — ${tech.specialty}` : ''}
                  </option>
                ))}
              </select>
            </SelectWrapper>
          </div>
        </div>

        {/* Schedule */}
        <div className="glass-card p-5 space-y-4">
          <h2 className="text-white font-medium text-sm border-b border-white/[0.06] pb-3 -mt-1">
            Schedule &amp; Estimates
          </h2>

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">{t('form.dueDateLabel')}</label>
              <input
                type="date"
                value={form.due_date}
                onChange={(e) => set('due_date', e.target.value)}
                className="input-field"
                disabled={isSubmitting}
                min={new Date().toISOString().split('T')[0]}
              />
            </div>
            <div>
              <label className="label">{t('form.estimatedHoursLabel')}</label>
              <input
                type="number"
                value={form.estimated_hours}
                onChange={(e) => set('estimated_hours', e.target.value)}
                placeholder="e.g. 4"
                className="input-field"
                min="0.5"
                step="0.5"
                disabled={isSubmitting}
              />
            </div>
          </div>
        </div>

        {/* Notes */}
        <div className="glass-card p-5">
          <label className="label">{t('form.notesLabel')}</label>
          <textarea
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            placeholder={t('form.notesPlaceholder')}
            className="input-field resize-none"
            rows={3}
            disabled={isSubmitting}
          />
        </div>

        {/* Submit */}
        <div className="flex items-center justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={() => navigate('/work-orders')}
            className="btn-secondary"
            disabled={isSubmitting}
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="btn-primary"
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <>
                <Spinner size="xs" />
                {t('form.creating')}
              </>
            ) : (
              <>
                <Plus size={15} />
                {t('form.createWO')}
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};

export default NewWorkOrder;
