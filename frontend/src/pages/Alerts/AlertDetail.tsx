import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Bell, UserPlus, ArrowRightCircle, AlertTriangle, Clock } from 'lucide-react';
import { fetchAlert, assignAlert, convertAlertToTicket } from '../../api/maintenance';
import type { MaintenanceAlert, AlertPriority, AlertStatus } from '../../types';
import Spinner from '../../components/ui/Spinner';

const PRIORITY_BADGE: Record<AlertPriority, string> = {
  critical: 'bg-red-500/15 text-red-400 border-red-500/25',
  high:     'bg-orange-500/15 text-orange-400 border-orange-500/25',
  medium:   'bg-sky-500/15 text-sky-400 border-sky-500/25',
  low:      'bg-gray-500/15 text-gray-400 border-gray-500/25',
};

const STATUS_BADGE: Record<AlertStatus, string> = {
  new_alert:   'bg-blue-500/15 text-blue-400 border-blue-500/25',
  assigned:    'bg-amber-500/15 text-amber-400 border-amber-500/25',
  in_progress: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
  resolved:    'bg-green-500/15 text-green-400 border-green-500/25',
  cancelled:   'bg-gray-500/15 text-gray-400 border-gray-500/25',
};

function Field({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div>
      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-gray-200 text-sm">{value ?? '—'}</p>
    </div>
  );
}

export default function AlertDetail() {
  const { id }     = useParams<{ id: string }>();
  const navigate   = useNavigate();
  const { t }      = useTranslation();
  const [alert, setAlert]       = useState<MaintenanceAlert | null>(null);
  const [loading, setLoading]   = useState(true);
  const [actioning, setActioning] = useState(false);
  const [error, setError]       = useState('');

  useEffect(() => {
    if (!id) return;
    fetchAlert(id)
      .then(setAlert)
      .catch(() => setError('Alert not found.'))
      .finally(() => setLoading(false));
  }, [id]);

  const handleAssign = async () => {
    if (!alert) return;
    setActioning(true);
    try {
      const updated = await assignAlert(alert.id);
      setAlert(updated);
    } catch {
      setError('Failed to assign alert.');
    } finally {
      setActioning(false);
    }
  };

  const handleConvert = async () => {
    if (!alert) return;
    setActioning(true);
    try {
      const { ticket_id } = await convertAlertToTicket(alert.id);
      navigate(`/tickets/${ticket_id}`);
    } catch {
      setError('Failed to convert alert to ticket.');
    } finally {
      setActioning(false);
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <Spinner size="lg" />
    </div>
  );

  if (!alert) return (
    <div className="p-6 text-gray-500">{error || 'Alert not found.'}</div>
  );

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/alerts')} className="btn-secondary py-1.5 px-3">
          <ArrowLeft size={15} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Bell size={22} className="text-amber-400 flex-shrink-0" />
            <span className="font-mono text-amber-400">{alert.alert_number}</span>
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">{t(`problemType.${alert.problem_type}`, alert.problem_type)}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={`inline-flex items-center px-2.5 py-1 text-xs font-mono font-medium border rounded ${PRIORITY_BADGE[alert.priority]}`}>
            {t(`priority.${alert.priority}`)}
          </span>
          <span className={`inline-flex items-center px-2.5 py-1 text-xs font-mono font-medium border rounded ${STATUS_BADGE[alert.status]}`}>
            {t(`alertStatus.${alert.status}`, alert.status)}
          </span>
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
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          <Field label={t('alerts.machine')} value={alert.machine_name} />
          <Field label={t('alerts.department')} value={alert.department} />
          <Field label={t('alerts.problemType')} value={t(`problemType.${alert.problem_type}`, alert.problem_type)} />
          <Field label={t('alerts.operatorName')} value={alert.created_by} />
          <Field label={t('alerts.shift')} value={alert.shift ? t(`shift.${alert.shift}`, alert.shift) : undefined} />
          <Field label={t('alerts.assignedTo')} value={alert.assigned_to_name} />
          <Field
            label={t('alerts.createdAt')}
            value={alert.created_at ? new Date(alert.created_at).toLocaleString() : undefined}
          />
          {alert.escalation_level > 0 && (
            <Field label={t('alerts.escalation')} value={`L${alert.escalation_level}`} />
          )}
          {alert.ticket_id && (
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{t('alerts.linkedTicket')}</p>
              <Link to={`/tickets/${alert.ticket_id}`} className="text-blue-400 hover:text-blue-300 text-sm underline-offset-2 hover:underline">
                {t('alerts.viewTicket')}
              </Link>
            </div>
          )}
        </div>

        {alert.description && (
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{t('common.description')}</p>
            <p className="text-gray-300 text-sm whitespace-pre-wrap">{alert.description}</p>
          </div>
        )}

        {alert.is_overdue && (
          <div className="flex items-center gap-2 p-3 bg-amber-500/10 border border-amber-500/25 rounded-lg">
            <Clock size={14} className="text-amber-400 flex-shrink-0" />
            <p className="text-amber-400 text-sm">{t('alerts.overdueOnly')}</p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-3">
        {alert.status === 'new_alert' && (
          <button
            onClick={handleAssign}
            disabled={actioning}
            className="btn-secondary gap-2"
          >
            <UserPlus size={15} />
            {t('alerts.assignToMe')}
          </button>
        )}
        {!alert.ticket_id && alert.status !== 'cancelled' && alert.status !== 'resolved' && (
          <button
            onClick={handleConvert}
            disabled={actioning}
            className="btn-warning gap-2"
          >
            <ArrowRightCircle size={15} />
            {t('alerts.convertToTicket')}
          </button>
        )}
      </div>
    </div>
  );
}
