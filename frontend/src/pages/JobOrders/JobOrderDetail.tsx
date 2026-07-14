import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Boxes, Clock, DollarSign, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchJobOrder, fetchJobOrderCost } from '../../api/jobOrders';
import type { JobOrder, JobOrderCost } from '../../types';
import { useAuthStore } from '../../store/authStore';

const STATUS_STYLE: Record<string, string> = {
  pending:     'bg-gray-800 text-gray-300 border-gray-600',
  in_progress: 'bg-blue-900/50 text-blue-300 border-blue-700',
  completed:   'bg-green-900/50 text-green-300 border-green-700',
  cancelled:   'bg-red-900/50 text-red-400 border-red-700',
};

function fmtHours(mins: number) { return `${(mins / 60).toFixed(1)} h`; }

export default function JobOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const can = useAuthStore((s) => s.can);
  const showCost = can('costs', 'view');

  const [of, setOf] = useState<JobOrder | null>(null);
  const [cost, setCost] = useState<JobOrderCost | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    Promise.all([fetchJobOrder(id), fetchJobOrderCost(id)])
      .then(([o, c]) => { setOf(o); setCost(c); })
      .finally(() => setLoading(false));
  }, [id]);

  const fmtDT = (s?: string | null) =>
    s ? new Date(s).toLocaleString(i18n.language) : '—';
  const money = (v: number) => `${cost?.currency ?? 'CAD'} $${v.toFixed(2)}`;

  if (loading) {
    return <div className="py-24 text-center text-gray-500 bg-gray-950">{t('common.loading', 'Loading…')}</div>;
  }
  if (!of) {
    return <div className="py-24 text-center text-gray-500 bg-gray-950">{t('jobOrders.notFound')}</div>;
  }

  return (
    <div className="flex flex-col bg-gray-950 text-gray-100 min-h-screen">
      {/* Header */}
      <div className="px-6 py-5 border-b border-gray-800">
        <button
          onClick={() => navigate('/job-orders')}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-300 mb-3"
        >
          <ArrowLeft size={15} /> {t('jobOrders.backToList')}
        </button>
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-xl font-semibold text-white flex items-center gap-2">
              <Boxes size={20} className="text-purple-400" />
              <span className="font-mono">{of.job_number}</span>
              <span className={`px-2.5 py-0.5 rounded border text-xs font-medium ${STATUS_STYLE[of.status] ?? STATUS_STYLE.pending}`}>
                {t(`jobOrders.status_${of.status}`)}
              </span>
            </h1>
            {of.product_name && <p className="text-sm text-gray-400 mt-1">{of.product_name}</p>}
          </div>
        </div>

        {/* Meta */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5">
          <Meta label={t('jobOrders.colDepartment')} value={of.department || '—'} />
          <Meta label={t('jobOrders.targetQuantity')} value={of.target_quantity != null ? String(of.target_quantity) : '—'} />
          <Meta label={t('jobOrders.scheduledDate')} value={of.scheduled_date || '—'} />
          <Meta label={t('jobOrders.source')} value={t(`jobOrders.source_${of.source}`)} />
        </div>
      </div>

      {/* Cost summary */}
      {cost && (
        <div className="px-6 py-5 border-b border-gray-800">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat icon={<Clock size={16} />} label={t('jobOrders.productiveTime')} value={fmtHours(cost.total_productive_minutes)} tone="sky" />
            <Stat icon={<Layers size={16} />} label={t('jobOrders.colPieces')} value={String(cost.total_pieces)} />
            <Stat icon={<Clock size={16} />} label={t('jobOrders.stopTime')} value={fmtHours(cost.total_stop_minutes)} tone="amber" />
            {showCost && <Stat icon={<DollarSign size={16} />} label={t('jobOrders.colCost')} value={money(cost.total_cost)} tone="emerald" />}
          </div>

          {/* By department */}
          {cost.by_department.length > 0 && (
            <div className="mt-5">
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">{t('jobOrders.byDepartment')}</p>
              <div className="flex flex-wrap gap-2">
                {cost.by_department.map((b) => (
                  <div key={b.key} className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">
                    <p className="text-sm text-gray-200">{b.key}</p>
                    <p className="text-xs text-gray-500 font-mono">
                      {fmtHours(b.productive_minutes)} · {b.pieces} {t('jobOrders.piecesShort')}
                      {showCost && <> · <span className="text-emerald-400">{money(b.cost)}</span></>}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Runs timeline */}
      <div className="px-6 py-5">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">{t('jobOrders.passages')}</p>
        {!cost || cost.runs.length === 0 ? (
          <p className="text-sm text-gray-600 py-8 text-center">{t('jobOrders.noPassages')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 uppercase tracking-wider">
                <th className="border-b border-gray-800 px-3 py-2 text-left">{t('jobOrders.colMachine')}</th>
                <th className="border-b border-gray-800 px-3 py-2 text-left">{t('jobOrders.colDepartment')}</th>
                <th className="border-b border-gray-800 px-3 py-2 text-left">{t('jobOrders.colStart')}</th>
                <th className="border-b border-gray-800 px-3 py-2 text-left">{t('jobOrders.colEnd')}</th>
                <th className="border-b border-gray-800 px-3 py-2 text-right">{t('jobOrders.colTime')}</th>
                <th className="border-b border-gray-800 px-3 py-2 text-right">{t('jobOrders.colPieces')}</th>
                {showCost && <th className="border-b border-gray-800 px-3 py-2 text-right">{t('jobOrders.colCost')}</th>}
              </tr>
            </thead>
            <tbody>
              {cost.runs.map((r) => (
                <tr key={r.run_id} className="border-b border-gray-800/60">
                  <td className="px-3 py-2 text-gray-200">{r.machine_name || '—'}</td>
                  <td className="px-3 py-2 text-gray-400">{r.department || '—'}</td>
                  <td className="px-3 py-2 text-gray-400 text-xs">{fmtDT(r.started_at)}</td>
                  <td className="px-3 py-2 text-gray-400 text-xs">
                    {r.open
                      ? <span className="text-blue-400">{t('jobOrders.ongoing')}</span>
                      : fmtDT(r.ended_at)}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-300 font-mono text-xs">{fmtHours(r.productive_minutes)}</td>
                  <td className="px-3 py-2 text-right text-gray-300 font-mono text-xs">{r.pieces}</td>
                  {showCost && <td className="px-3 py-2 text-right text-emerald-300 font-mono text-xs">{money(r.cost)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-gray-600 uppercase tracking-wider">{label}</p>
      <p className="text-sm text-gray-200 mt-0.5">{value}</p>
    </div>
  );
}

function Stat({ icon, label, value, tone = 'gray' }: {
  icon: React.ReactNode; label: string; value: string; tone?: 'gray' | 'emerald' | 'amber' | 'sky';
}) {
  const color = tone === 'emerald' ? 'text-emerald-400' : tone === 'amber' ? 'text-amber-400'
    : tone === 'sky' ? 'text-sky-300' : 'text-gray-200';
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
      <p className="text-[11px] text-gray-500 uppercase tracking-wider flex items-center gap-1.5">{icon} {label}</p>
      <p className={`text-lg font-bold font-mono mt-1 ${color}`}>{value}</p>
    </div>
  );
}
