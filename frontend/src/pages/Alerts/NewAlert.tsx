import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Bell, AlertTriangle } from 'lucide-react';
import { fetchMachines, createAlert } from '../../api/maintenance';
import type { Machine, AlertProblemType, AlertPriority, AlertShift } from '../../types';
import Spinner from '../../components/ui/Spinner';
import { useAuthStore } from '../../store/authStore';

const PROBLEM_TYPES: AlertProblemType[] = [
  'mechanical', 'electrical', 'pneumatic', 'sensor',
  'safety_risk', 'quality_impact', 'machine_stop', 'preventive_request', 'other',
];

const PRIORITIES: { value: AlertPriority; color: string }[] = [
  { value: 'low',      color: 'text-gray-400 border-gray-500/40' },
  { value: 'medium',   color: 'text-sky-400 border-sky-500/40' },
  { value: 'high',     color: 'text-amber-400 border-amber-500/40' },
  { value: 'critical', color: 'text-red-400 border-red-500/40' },
];

const SHIFTS: AlertShift[] = ['morning', 'afternoon', 'night'];

export default function NewAlert() {
  const { t }          = useTranslation();
  const navigate       = useNavigate();
  const [params]       = useSearchParams();
  const user           = useAuthStore((s) => s.user);

  const [machines, setMachines]       = useState<Machine[]>([]);
  const [loading, setLoading]         = useState(true);
  const [submitting, setSubmitting]   = useState(false);
  const [error, setError]             = useState('');

  const [machineId, setMachineId]     = useState(params.get('machineId') ?? '');
  const [department, setDepartment]   = useState('');
  const [problemType, setProblemType] = useState<AlertProblemType>('mechanical');
  const [priority, setPriority]       = useState<AlertPriority>('medium');
  const [description, setDescription] = useState('');
  const [createdBy, setCreatedBy]     = useState(user?.name ?? '');
  const [shift, setShift]             = useState<AlertShift>('morning');

  useEffect(() => {
    fetchMachines()
      .then((list) => {
        setMachines(list);
        if (params.get('machineId')) {
          const m = list.find((x) => x.id === params.get('machineId'));
          if (m?.department) setDepartment(m.department);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const handleMachineChange = (id: string) => {
    setMachineId(id);
    const m = machines.find((x) => x.id === id);
    if (m?.department) setDepartment(m.department);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!machineId || !problemType || !createdBy) {
      setError(t('alerts.requiredFields'));
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      await createAlert({ machine_id: machineId, department, problem_type: problemType, priority, description, created_by: createdBy, shift });
      navigate('/alerts');
    } catch {
      setError(t('alerts.createError'));
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
    <div className="max-w-2xl mx-auto p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/alerts')} className="btn-secondary py-1.5 px-3">
          <ArrowLeft size={15} />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Bell size={22} className="text-amber-400" />
            {t('alerts.newAlert')}
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">{t('alerts.newAlertSubtitle')}</p>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
          <AlertTriangle size={15} className="text-red-400 flex-shrink-0" />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="glass-card p-6 space-y-5">
        {/* Machine + Department */}
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="label">{t('alerts.machine')} *</label>
            <select
              value={machineId}
              onChange={(e) => handleMachineChange(e.target.value)}
              className="select-field"
              required
            >
              <option value="">{t('alerts.selectMachine')}</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">{t('alerts.department')}</label>
            <input
              type="text"
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              className="input-field"
              placeholder={t('alerts.departmentPlaceholder')}
            />
          </div>
        </div>

        {/* Problem type */}
        <div>
          <label className="label">{t('alerts.problemType')} *</label>
          <select
            value={problemType}
            onChange={(e) => setProblemType(e.target.value as AlertProblemType)}
            className="select-field"
            required
          >
            {PROBLEM_TYPES.map((pt) => (
              <option key={pt} value={pt}>{t(`problemType.${pt}`, pt)}</option>
            ))}
          </select>
        </div>

        {/* Priority */}
        <div>
          <label className="label">{t('common.priority')} *</label>
          <div className="flex flex-wrap gap-2">
            {PRIORITIES.map(({ value, color }) => (
              <button
                key={value}
                type="button"
                onClick={() => setPriority(value)}
                className={`px-4 py-1.5 rounded-lg border text-sm font-medium transition-all ${
                  priority === value
                    ? `${color} bg-white/[0.08]`
                    : 'border-white/10 text-gray-500 hover:border-white/20'
                }`}
              >
                {t(`priority.${value}`, value)}
              </button>
            ))}
          </div>
        </div>

        {/* Description */}
        <div>
          <label className="label">{t('common.description')}</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="input-field resize-none"
            placeholder={t('alerts.descriptionPlaceholder')}
          />
        </div>

        {/* Operator + Shift */}
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="label">{t('alerts.operatorName')} *</label>
            <input
              type="text"
              value={createdBy}
              onChange={(e) => setCreatedBy(e.target.value)}
              className="input-field"
              placeholder={t('alerts.operatorPlaceholder')}
              required
            />
          </div>
          <div>
            <label className="label">{t('alerts.shift')}</label>
            <select
              value={shift}
              onChange={(e) => setShift(e.target.value as AlertShift)}
              className="select-field"
            >
              {SHIFTS.map((s) => (
                <option key={s} value={s}>{t(`shift.${s}`, s)}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Created at (read-only) */}
        <div>
          <label className="label">{t('alerts.createdAt')}</label>
          <input
            type="text"
            value={new Date().toLocaleString()}
            className="input-field opacity-50"
            readOnly
          />
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-2 border-t border-white/[0.06]">
          <button type="button" onClick={() => navigate('/alerts')} className="btn-secondary">
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? (
              <>
                <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                {t('alerts.creating')}
              </>
            ) : (
              t('alerts.createAlert')
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
