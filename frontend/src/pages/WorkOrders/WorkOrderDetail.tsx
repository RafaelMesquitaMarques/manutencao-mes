import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Play,
  CheckCircle2,
  XCircle,
  PauseCircle,
  RotateCcw,
  Wrench,
  User,
  Calendar,
  Clock,
  Package,
  FileText,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import { fetchWorkOrder, updateWorkOrderStatus } from '../../api/workOrders';
import type { WorkOrder } from '../../types';
import Badge from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';

const WorkOrderDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [wo, setWo] = useState<WorkOrder | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isActioning, setIsActioning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Complete modal state
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [actualHours, setActualHours] = useState('');

  const load = async () => {
    if (!id) return;
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchWorkOrder(Number(id));
      setWo(data);
    } catch {
      setError(t('common.error'));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  const handleAction = async (status: string, hours?: number) => {
    if (!wo) return;
    setIsActioning(true);
    setActionError(null);
    try {
      const updated = await updateWorkOrderStatus(wo.id, status, hours);
      setWo(updated);
    } catch {
      setActionError(t('common.error'));
    } finally {
      setIsActioning(false);
      setShowCompleteModal(false);
      setActualHours('');
    }
  };

  const formatDate = (d?: string) => {
    if (!d) return '—';
    return new Date(d).toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  };

  const formatDateShort = (d?: string) => {
    if (!d) return '—';
    return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error || !wo) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p className="text-red-400 text-sm">{error ?? t('common.error')}</p>
        <button onClick={load} className="btn-secondary">
          <RefreshCw size={14} /> Retry
        </button>
      </div>
    );
  }

  const isTerminal = wo.status === 'completed' || wo.status === 'cancelled';

  return (
    <div className="space-y-5 animate-fade-in">
      {/* Breadcrumb + back */}
      <div className="flex items-center gap-2 text-sm">
        <button
          onClick={() => navigate('/work-orders')}
          className="flex items-center gap-1.5 text-gray-500 hover:text-gray-300 transition-colors"
        >
          <ArrowLeft size={15} />
          {t('workOrders.title')}
        </button>
        <span className="text-gray-700">/</span>
        <span className="text-gray-400 font-mono text-xs">{wo.wo_number}</span>
      </div>

      {/* Header + Actions */}
      <div className="flex flex-col md:flex-row md:items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="font-mono text-blue-400 text-sm">{wo.wo_number}</span>
            <Badge value={wo.status} variant="status" size="md" />
            <Badge value={wo.priority} variant="priority" size="md" />
            <Badge value={wo.type} variant="type" size="md" />
          </div>
          <h1 className="text-xl font-bold text-white leading-tight">{wo.title}</h1>
        </div>

        {/* Action buttons */}
        {!isTerminal && (
          <div className="flex flex-wrap gap-2 flex-shrink-0">
            {wo.status === 'open' && (
              <button
                onClick={() => handleAction('in_progress')}
                disabled={isActioning}
                className="btn-success"
              >
                {isActioning ? <Spinner size="xs" /> : <Play size={14} />}
                {t('workOrders.startWO')}
              </button>
            )}
            {wo.status === 'on_hold' && (
              <button
                onClick={() => handleAction('in_progress')}
                disabled={isActioning}
                className="btn-success"
              >
                {isActioning ? <Spinner size="xs" /> : <RotateCcw size={14} />}
                {t('workOrders.resumeWO')}
              </button>
            )}
            {wo.status === 'in_progress' && (
              <>
                <button
                  onClick={() => setShowCompleteModal(true)}
                  disabled={isActioning}
                  className="btn-success"
                >
                  <CheckCircle2 size={14} />
                  {t('workOrders.completeWO')}
                </button>
                <button
                  onClick={() => handleAction('on_hold')}
                  disabled={isActioning}
                  className="btn-warning"
                >
                  <PauseCircle size={14} />
                  {t('workOrders.holdWO')}
                </button>
              </>
            )}
            {(wo.status === 'open' || wo.status === 'in_progress' || wo.status === 'on_hold') && (
              <button
                onClick={() => handleAction('cancelled')}
                disabled={isActioning}
                className="btn-danger"
              >
                <XCircle size={14} />
                {t('workOrders.cancelWO')}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Action error */}
      {actionError && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
          <AlertCircle size={14} className="text-red-400" />
          <p className="text-red-400 text-sm">{actionError}</p>
        </div>
      )}

      {/* Body */}
      <div className="grid lg:grid-cols-3 gap-4">
        {/* Left column — 2/3 */}
        <div className="lg:col-span-2 space-y-4">
          {/* Description */}
          <div className="glass-card p-5">
            <div className="flex items-center gap-2 mb-3">
              <FileText size={15} className="text-gray-500" />
              <h2 className="text-white font-semibold text-sm">{t('common.description')}</h2>
            </div>
            <p className="text-gray-300 text-sm leading-relaxed whitespace-pre-wrap">{wo.description}</p>
          </div>

          {/* Notes */}
          {wo.notes && (
            <div className="glass-card p-5">
              <div className="flex items-center gap-2 mb-3">
                <FileText size={15} className="text-gray-500" />
                <h2 className="text-white font-semibold text-sm">{t('common.notes')}</h2>
              </div>
              <p className="text-gray-300 text-sm leading-relaxed whitespace-pre-wrap">{wo.notes}</p>
            </div>
          )}

          {/* Parts used */}
          <div className="glass-card overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-4 border-b border-white/[0.06]">
              <Package size={15} className="text-gray-500" />
              <h2 className="text-white font-semibold text-sm">{t('workOrders.partsUsed')}</h2>
            </div>
            {wo.parts_used && wo.parts_used.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-white/[0.04]">
                      <th className="table-header-cell">{t('workOrders.partName')}</th>
                      <th className="table-header-cell">{t('workOrders.partNumber')}</th>
                      <th className="table-header-cell text-right">{t('workOrders.quantity')}</th>
                      <th className="table-header-cell text-right">{t('workOrders.unitCost')}</th>
                      <th className="table-header-cell text-right">{t('workOrders.totalCost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wo.parts_used.map((part, i) => (
                      <tr key={i} className="table-row">
                        <td className="table-cell text-gray-200">{part.part_name}</td>
                        <td className="table-cell font-mono text-gray-400 text-xs">{part.part_number}</td>
                        <td className="table-cell text-right font-mono">{part.quantity_used}</td>
                        <td className="table-cell text-right font-mono text-gray-400">
                          ${part.unit_cost.toFixed(2)}
                        </td>
                        <td className="table-cell text-right font-mono text-blue-400">
                          ${(part.quantity_used * part.unit_cost).toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-gray-600 text-sm text-center py-8">{t('workOrders.noParts')}</p>
            )}
          </div>
        </div>

        {/* Right column — 1/3 */}
        <div className="space-y-4">
          {/* Equipment */}
          <div className="glass-card p-5">
            <div className="flex items-center gap-2 mb-4">
              <Wrench size={15} className="text-gray-500" />
              <h2 className="text-white font-semibold text-sm">{t('workOrders.equipment')}</h2>
            </div>
            <div className="space-y-2">
              <p className="text-gray-200 text-sm font-medium">{wo.equipment_name ?? '—'}</p>
              {wo.equipment_code && (
                <p className="text-gray-500 font-mono text-xs">{wo.equipment_code}</p>
              )}
            </div>
          </div>

          {/* Assignment */}
          <div className="glass-card p-5">
            <div className="flex items-center gap-2 mb-4">
              <User size={15} className="text-gray-500" />
              <h2 className="text-white font-semibold text-sm">{t('workOrders.assignedTo')}</h2>
            </div>
            <div className="space-y-3">
              <div>
                <p className="text-gray-600 text-[11px] uppercase tracking-wide mb-0.5">{t('workOrders.assignedTo')}</p>
                <p className="text-gray-200 text-sm">
                  {wo.assigned_to_name ?? (
                    <span className="text-gray-600 italic">{t('workOrders.unassigned')}</span>
                  )}
                </p>
              </div>
              <div>
                <p className="text-gray-600 text-[11px] uppercase tracking-wide mb-0.5">{t('workOrders.createdBy')}</p>
                <p className="text-gray-400 text-sm">{wo.created_by_name ?? '—'}</p>
              </div>
            </div>
          </div>

          {/* Dates */}
          <div className="glass-card p-5">
            <div className="flex items-center gap-2 mb-4">
              <Calendar size={15} className="text-gray-500" />
              <h2 className="text-white font-semibold text-sm">{t('common.date')}</h2>
            </div>
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-gray-600 text-[11px] uppercase tracking-wide mb-0.5">{t('workOrders.createdAt')}</p>
                <p className="text-gray-300 font-mono text-xs">{formatDate(wo.created_at)}</p>
              </div>
              {wo.due_date && (
                <div>
                  <p className="text-gray-600 text-[11px] uppercase tracking-wide mb-0.5">{t('workOrders.dueDate')}</p>
                  <p className="text-amber-400 font-mono text-xs">{formatDateShort(wo.due_date)}</p>
                </div>
              )}
              {wo.started_at && (
                <div>
                  <p className="text-gray-600 text-[11px] uppercase tracking-wide mb-0.5">{t('workOrders.startedAt')}</p>
                  <p className="text-gray-300 font-mono text-xs">{formatDate(wo.started_at)}</p>
                </div>
              )}
              {wo.completed_at && (
                <div>
                  <p className="text-gray-600 text-[11px] uppercase tracking-wide mb-0.5">{t('workOrders.completedAt')}</p>
                  <p className="text-green-400 font-mono text-xs">{formatDate(wo.completed_at)}</p>
                </div>
              )}
            </div>
          </div>

          {/* Hours */}
          {(wo.estimated_hours || wo.actual_hours) && (
            <div className="glass-card p-5">
              <div className="flex items-center gap-2 mb-4">
                <Clock size={15} className="text-gray-500" />
                <h2 className="text-white font-semibold text-sm">{t('workOrders.hoursWorked')}</h2>
              </div>
              <div className="flex gap-4">
                {wo.estimated_hours !== undefined && (
                  <div>
                    <p className="text-gray-600 text-[11px] uppercase tracking-wide mb-0.5">{t('workOrders.estimatedHours')}</p>
                    <p className="text-gray-300 font-mono text-lg font-semibold">
                      {wo.estimated_hours}<span className="text-xs text-gray-600 ml-1">{t('common.hours')}</span>
                    </p>
                  </div>
                )}
                {wo.actual_hours !== undefined && (
                  <div>
                    <p className="text-gray-600 text-[11px] uppercase tracking-wide mb-0.5">{t('workOrders.actualHours')}</p>
                    <p className="text-blue-400 font-mono text-lg font-semibold">
                      {wo.actual_hours}<span className="text-xs text-blue-600 ml-1">{t('common.hours')}</span>
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Complete modal */}
      {showCompleteModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#111827] border border-white/10 rounded-2xl p-6 w-full max-w-sm shadow-2xl animate-slide-in">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-green-500/15 flex items-center justify-center">
                <CheckCircle2 size={20} className="text-green-400" />
              </div>
              <div>
                <h3 className="text-white font-semibold">{t('workOrders.confirmComplete')}</h3>
              </div>
            </div>
            <div className="mb-5">
              <label className="label">{t('workOrders.enterHours')}</label>
              <input
                type="number"
                min="0"
                step="0.5"
                value={actualHours}
                onChange={(e) => setActualHours(e.target.value)}
                placeholder={t('workOrders.hoursPlaceholder')}
                className="input-field"
                autoFocus
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setShowCompleteModal(false); setActualHours(''); }}
                className="btn-secondary"
                disabled={isActioning}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => handleAction('completed', actualHours ? Number(actualHours) : undefined)}
                className="btn-success"
                disabled={isActioning}
              >
                {isActioning ? <Spinner size="xs" /> : <CheckCircle2 size={14} />}
                {t('workOrders.completeWO')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WorkOrderDetail;
