import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, UserPlus, AlertCircle } from 'lucide-react';
import { createTechnician, fetchUsers } from '../../api/workOrders';
import type { User } from '../../types';
import Spinner from '../../components/ui/Spinner';

const SPECIALTIES = [
  'electromechanical',
  'mechanical',
  'electrical',
  'instrumentation',
  'welding',
  'hydraulics',
];

const SHIFTS = ['day', 'evening', 'night', 'rotating'];

const NewTechnician = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [users, setUsers] = useState<User[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [form, setForm] = useState({
    user_id: '',
    employee_number: '',
    specialty: '',
    shift: '',
    hourly_rate: '',
    certifications: '',
  });

  useEffect(() => {
    fetchUsers().catch(() => []).then(setUsers);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!form.user_id) {
      setFormError(t('technicians.requiredFields'));
      return;
    }

    setIsSubmitting(true);
    try {
      await createTechnician({
        user_id: form.user_id,
        employee_number: form.employee_number || undefined,
        specialty: form.specialty || undefined,
        shift: form.shift || undefined,
        hourly_rate: form.hourly_rate ? Number(form.hourly_rate) : undefined,
        certifications: form.certifications
          ? form.certifications.split(',').map((c) => c.trim()).filter(Boolean)
          : [],
      });
      navigate('/technicians');
    } catch {
      setFormError(t('common.error'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-5 animate-fade-in max-w-xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate('/technicians')}
          className="text-gray-500 hover:text-gray-300 transition-colors"
        >
          <ArrowLeft size={20} />
        </button>
        <div>
          <h1 className="text-xl font-bold text-white">{t('technicians.newTech')}</h1>
          <p className="text-gray-500 text-sm">{t('technicians.subtitle')}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="glass-card p-6 space-y-5">
        {/* User picker */}
        <div>
          <label className="label">{t('technicians.userLabel')}</label>
          <select
            className="input-field"
            value={form.user_id}
            onChange={(e) => setForm({ ...form, user_id: e.target.value })}
            required
          >
            <option value="">{t('technicians.selectUser')}</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
        </div>

        {/* Employee number */}
        <div>
          <label className="label">{t('technicians.employeeNumber')}</label>
          <input
            type="text"
            className="input-field font-mono"
            placeholder="EMP-001"
            value={form.employee_number}
            onChange={(e) => setForm({ ...form, employee_number: e.target.value })}
          />
        </div>

        {/* Specialty */}
        <div>
          <label className="label">{t('technicians.specialty')}</label>
          <select
            className="input-field"
            value={form.specialty}
            onChange={(e) => setForm({ ...form, specialty: e.target.value })}
          >
            <option value="">{t('technicians.selectSpecialty')}</option>
            {SPECIALTIES.map((s) => (
              <option key={s} value={s}>{t(`specialty.${s}`)}</option>
            ))}
          </select>
        </div>

        {/* Shift */}
        <div>
          <label className="label">{t('technicians.shift')}</label>
          <select
            className="input-field"
            value={form.shift}
            onChange={(e) => setForm({ ...form, shift: e.target.value })}
          >
            <option value="">{t('technicians.selectShift')}</option>
            {SHIFTS.map((s) => (
              <option key={s} value={s}>{t(`shift.${s}`)}</option>
            ))}
          </select>
        </div>

        {/* Hourly rate */}
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
          />
        </div>

        {/* Certifications */}
        <div>
          <label className="label">{t('technicians.certifications', 'Certifications')}</label>
          <input
            type="text"
            className="input-field"
            placeholder="NR-10, NR-12, CREA"
            value={form.certifications}
            onChange={(e) => setForm({ ...form, certifications: e.target.value })}
          />
          <p className="text-xs text-gray-600 mt-1">Comma-separated</p>
        </div>

        {formError && (
          <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
            <AlertCircle size={14} className="text-red-400 flex-shrink-0" />
            <p className="text-red-400 text-sm">{formError}</p>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={() => navigate('/technicians')}
            className="btn-secondary"
            disabled={isSubmitting}
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="btn-primary flex-1"
            disabled={isSubmitting}
          >
            {isSubmitting ? <Spinner size="xs" /> : <UserPlus size={16} />}
            {isSubmitting ? t('technicians.creating') : t('technicians.createTech')}
          </button>
        </div>
      </form>
    </div>
  );
};

export default NewTechnician;
