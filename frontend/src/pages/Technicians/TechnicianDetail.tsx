import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, User, AlertCircle, CheckCircle, Trash2 } from 'lucide-react';
import api from '../../api/axios';
import type { TechnicianFull } from '../../types';
import Spinner from '../../components/ui/Spinner';
import { usePermission } from '../../hooks/usePermission';

const SPECIALTIES = [
  'electromechanical', 'mechanical', 'electrical',
  'instrumentation', 'welding', 'hydraulics',
];

const SHIFTS = ['day', 'evening', 'night', 'rotating'];

export default function TechnicianDetail() {
  const { id }     = useParams<{ id: string }>();
  const navigate   = useNavigate();
  const { t }      = useTranslation();
  const canUpdate  = usePermission('technicians', 'update');
  const canDelete  = usePermission('technicians', 'delete');
  // Hourly rates are cost data — only visible to users with access to the Costs page.
  const canSeeCosts = usePermission('costs', 'view');
  const [tech, setTech]         = useState<TechnicianFull | null>(null);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [success, setSuccess]   = useState(false);
  const [error, setError]       = useState('');

  const [form, setForm] = useState({
    employee_number: '',
    specialty: '',
    shift: '',
    hourly_rate: '',
    certifications: '',
  });

  useEffect(() => {
    if (!id) return;
    api.get<TechnicianFull>(`/api/technicians/${id}`)
      .then(({ data }) => {
        setTech(data);
        setForm({
          employee_number: data.employee_number ?? '',
          specialty:       data.specialty ?? '',
          shift:           data.shift ?? '',
          hourly_rate:     data.hourly_rate != null ? String(data.hourly_rate) : '',
          certifications:  (data.certifications ?? []).join(', '),
        });
      })
      .catch(() => setError(t('technicians.notFound')))
      .finally(() => setLoading(false));
  }, [id, t]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !canUpdate) return;
    setError('');
    setSuccess(false);
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};
      if (form.employee_number) payload.employee_number = form.employee_number;
      if (form.specialty)       payload.specialty       = form.specialty;
      if (form.shift)           payload.shift           = form.shift;
      if (canSeeCosts && form.hourly_rate) payload.hourly_rate = Number(form.hourly_rate);
      payload.certifications = form.certifications
        ? form.certifications.split(',').map((c) => c.trim()).filter(Boolean)
        : [];
      const { data } = await api.patch<TechnicianFull>(`/api/technicians/${id}`, payload);
      setTech(data);
      setSuccess(true);
    } catch {
      setError(t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!id || !canDelete || !window.confirm(t('technicians.deactivateConfirm'))) return;
    try {
      await api.delete(`/api/technicians/${id}`);
      navigate('/technicians');
    } catch {
      setError(t('technicians.deactivateFailed'));
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <Spinner size="lg" />
    </div>
  );

  if (!tech && error) return (
    <div className="p-6 text-gray-500">{error}</div>
  );

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/technicians')} className="btn-secondary py-1.5 px-3">
          <ArrowLeft size={15} />
        </button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <User size={22} className="text-blue-400" />
            {tech?.full_name ?? t('technicians.title')}
          </h1>
          {tech?.email && <p className="text-gray-500 text-sm mt-0.5">{tech.email}</p>}
        </div>
        {canDelete && (
          <button onClick={handleDelete} className="btn-danger py-1.5 px-3" title={t('technicians.deactivate')}>
            <Trash2 size={15} />
          </button>
        )}
      </div>

      {!canUpdate && (
        <div className="flex items-center gap-2.5 p-3 bg-blue-500/10 border border-blue-500/25 rounded-lg">
          <AlertCircle size={14} className="text-blue-400 flex-shrink-0" />
          <p className="text-blue-400 text-sm">{t('technicians.viewOnly')}</p>
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2.5 p-3 bg-green-500/10 border border-green-500/25 rounded-lg">
          <CheckCircle size={14} className="text-green-400" />
          <p className="text-green-400 text-sm">{t('technicians.changesSaved')}</p>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
          <AlertCircle size={14} className="text-red-400 flex-shrink-0" />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      <form onSubmit={handleSave} className="glass-card p-6 space-y-5">
        <div>
          <label className="label">{t('technicians.employeeNumber')}</label>
          <input
            type="text"
            className="input-field font-mono"
            placeholder="EMP-001"
            value={form.employee_number}
            onChange={(e) => setForm({ ...form, employee_number: e.target.value })}
            disabled={!canUpdate}
          />
        </div>

        <div>
          <label className="label">{t('technicians.specialty')}</label>
          <select
            className="input-field"
            value={form.specialty}
            onChange={(e) => setForm({ ...form, specialty: e.target.value })}
            disabled={!canUpdate}
          >
            <option value="">{t('technicians.selectSpecialty')}</option>
            {SPECIALTIES.map((s) => (
              <option key={s} value={s}>{t(`specialty.${s}`, s)}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="label">{t('technicians.shift')}</label>
          <select
            className="input-field"
            value={form.shift}
            onChange={(e) => setForm({ ...form, shift: e.target.value })}
            disabled={!canUpdate}
          >
            <option value="">{t('technicians.selectShift')}</option>
            {SHIFTS.map((s) => (
              <option key={s} value={s}>{t(`shift.${s}`, s)}</option>
            ))}
          </select>
        </div>

        {canSeeCosts && (
          <div>
            <label className="label">{t('technicians.hourlyRate')}</label>
            <input
              type="number"
              min="0"
              step="0.01"
              className="input-field"
              placeholder="45.00"
              value={form.hourly_rate}
              onChange={(e) => setForm({ ...form, hourly_rate: e.target.value })}
              disabled={!canUpdate}
            />
          </div>
        )}

        <div>
          <label className="label">{t('technicians.certifications')}</label>
          <input
            type="text"
            className="input-field"
            placeholder="NR-10, NR-12, CREA"
            value={form.certifications}
            onChange={(e) => setForm({ ...form, certifications: e.target.value })}
            disabled={!canUpdate}
          />
          <p className="text-xs text-gray-600 mt-1">{t('technicians.commaSeparated')}</p>
        </div>

        {canUpdate && (
          <div className="flex justify-end pt-2 border-t border-white/[0.06]">
            <button type="submit" disabled={saving} className="btn-primary">
              {saving ? (
                <><span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" /> {t('technicians.saving')}</>
              ) : t('technicians.saveChanges')}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
