import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, Search, Filter, ChevronRight, RefreshCw, ClipboardList } from 'lucide-react';
import { fetchWorkOrders } from '../../api/workOrders';
import type { WorkOrder, WorkOrderStatus, WorkOrderType, Priority } from '../../types';
import Badge from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';

const ALL = '';

const WorkOrderList = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<WorkOrderStatus | ''>(ALL);
  const [typeFilter, setTypeFilter] = useState<WorkOrderType | ''>(ALL);
  const [priorityFilter, setPriorityFilter] = useState<Priority | ''>(ALL);

  const load = async () => {
    setIsLoading(true);
    try {
      const data = await fetchWorkOrders();
      setWorkOrders(data);
    } catch {
      // keep empty list — show CTA instead of error
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return workOrders.filter((wo) => {
      if (statusFilter && wo.status !== statusFilter) return false;
      if (typeFilter && wo.type !== typeFilter) return false;
      if (priorityFilter && wo.priority !== priorityFilter) return false;
      if (q) {
        return (
          wo.wo_number.toLowerCase().includes(q) ||
          wo.title.toLowerCase().includes(q) ||
          (wo.equipment_name ?? '').toLowerCase().includes(q) ||
          (wo.assigned_to_name ?? '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [workOrders, search, statusFilter, typeFilter, priorityFilter]);

  const statuses: WorkOrderStatus[] = ['open', 'in_progress', 'completed', 'cancelled', 'on_hold'];
  const types: WorkOrderType[] = ['corrective', 'preventive', 'predictive', 'inspection', 'improvement'];
  const priorities: Priority[] = ['low', 'medium', 'high', 'critical'];

  const formatDate = (d?: string) => {
    if (!d) return '—';
    return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <div className="space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('workOrders.title')}</h1>
          <p className="text-gray-500 text-sm mt-1">{t('workOrders.subtitle')}</p>
        </div>
        <button onClick={() => navigate('/work-orders/new')} className="btn-primary flex-shrink-0">
          <Plus size={16} />
          {t('workOrders.newWO')}
        </button>
      </div>

      {/* Filters */}
      <div className="glass-card p-3 md:p-4">
        <div className="flex flex-wrap gap-2.5 items-center">
          {/* Search */}
          <div className="relative flex-1 min-w-[180px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('common.search')}
              className="input-field pl-8 py-1.5"
            />
          </div>

          <div className="flex items-center gap-1.5 text-gray-600">
            <Filter size={13} />
          </div>

          {/* Status filter */}
          <div className="relative">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as WorkOrderStatus | '')}
              className="select-field py-1.5 pr-8 text-xs min-w-[120px]"
            >
              <option value={ALL}>{t('common.status')}: {t('common.all')}</option>
              {statuses.map((s) => (
                <option key={s} value={s}>{t(`status.${s}`)}</option>
              ))}
            </select>
          </div>

          {/* Type filter */}
          <div className="relative">
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as WorkOrderType | '')}
              className="select-field py-1.5 pr-8 text-xs min-w-[120px]"
            >
              <option value={ALL}>{t('common.type')}: {t('common.all')}</option>
              {types.map((tp) => (
                <option key={tp} value={tp}>{t(`type.${tp}`)}</option>
              ))}
            </select>
          </div>

          {/* Priority filter */}
          <div className="relative">
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value as Priority | '')}
              className="select-field py-1.5 pr-8 text-xs min-w-[120px]"
            >
              <option value={ALL}>{t('common.priority')}: {t('common.all')}</option>
              {priorities.map((p) => (
                <option key={p} value={p}>{t(`priority.${p}`)}</option>
              ))}
            </select>
          </div>

          <button onClick={load} className="btn-secondary py-1.5 px-2.5 ml-auto">
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="glass-card overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Spinner />
          </div>
        ) : workOrders.length === 0 ? (
          <div className="flex flex-col items-center py-16 gap-3">
            <ClipboardList size={40} className="text-gray-700" />
            <p className="text-gray-400 text-sm">{t('workOrders.noResults')}</p>
            <button onClick={() => navigate('/work-orders/new')} className="btn-primary gap-1.5 py-2 px-4 text-sm">
              <Plus size={15} />
              {t('workOrders.createFirst')}
            </button>
          </div>
        ) : (
          <>
            {/* Result count */}
            <div className="px-4 py-2.5 border-b border-white/[0.04]">
              <p className="text-gray-600 text-xs font-mono">
                {filtered.length} / {workOrders.length} orders
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/[0.04]">
                    <th className="table-header-cell">{t('workOrders.woNumber')}</th>
                    <th className="table-header-cell">{t('workOrders.titleField')}</th>
                    <th className="table-header-cell hidden md:table-cell">{t('workOrders.equipment')}</th>
                    <th className="table-header-cell hidden lg:table-cell">{t('common.type')}</th>
                    <th className="table-header-cell">{t('common.priority')}</th>
                    <th className="table-header-cell">{t('common.status')}</th>
                    <th className="table-header-cell hidden xl:table-cell">{t('workOrders.dueDate')}</th>
                    <th className="table-header-cell hidden xl:table-cell">{t('workOrders.assignedTo')}</th>
                    <th className="table-header-cell w-8" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="text-center py-14">
                        <p className="text-gray-500 text-sm">{t('workOrders.noResults')}</p>
                        <p className="text-gray-700 text-xs mt-1.5">{t('workOrders.noResultsHint')}</p>
                      </td>
                    </tr>
                  ) : (
                    filtered.map((wo) => (
                      <tr
                        key={wo.id}
                        className="table-row cursor-pointer"
                        onClick={() => navigate(`/work-orders/${wo.id}`)}
                      >
                        <td className="table-cell">
                          <span className="font-mono text-xs text-blue-400">{wo.wo_number}</span>
                        </td>
                        <td className="table-cell max-w-[220px]">
                          <p className="text-gray-200 truncate text-sm">{wo.title}</p>
                        </td>
                        <td className="table-cell hidden md:table-cell">
                          <p className="text-gray-300 text-sm truncate">{wo.equipment_name ?? '—'}</p>
                          {wo.equipment_location && (
                            <p className="text-gray-600 text-xs truncate">{wo.equipment_location}</p>
                          )}
                        </td>
                        <td className="table-cell hidden lg:table-cell">
                          <Badge value={wo.type} variant="type" />
                        </td>
                        <td className="table-cell">
                          <Badge value={wo.priority} variant="priority" />
                        </td>
                        <td className="table-cell">
                          <Badge value={wo.status} variant="status" />
                        </td>
                        <td className="table-cell hidden xl:table-cell text-gray-400 text-xs font-mono">
                          {formatDate(wo.due_date)}
                        </td>
                        <td className="table-cell hidden xl:table-cell">
                          <span className="text-gray-600 italic text-xs">{t('workOrders.unassigned')}</span>
                        </td>
                        <td className="table-cell text-gray-600">
                          <ChevronRight size={14} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default WorkOrderList;
