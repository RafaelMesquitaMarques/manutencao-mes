import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, Brain, CheckCircle2, RefreshCw,
  Search, Settings as SettingsIcon, ShieldQuestion, Ticket as TicketIcon, WifiOff,
} from 'lucide-react';
import {
  PredictiveAlertItem, PredictiveAlertStatus, PredictiveOverview, PredictiveReason,
  createAlertTicket, fetchPredictiveAlerts, fetchPredictiveOverview, updateAlertStatus,
} from '../../api/predictive';
import { useAuthStore } from '../../store/authStore';
import { LEVEL_COLORS, scoreLevelHex } from './predictiveUi';
import FeedbackModal from './FeedbackModal';
import SettingsModal from './SettingsModal';
import BacktestPanel from './BacktestPanel';

const STATUS_FLOW: PredictiveAlertStatus[] = [
  'new', 'in_review', 'inspection_planned', 'intervention_required',
  'intervention_done', 'monitoring', 'false_positive', 'closed',
];

const PredictiveDashboard = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [overview, setOverview] = useState<PredictiveOverview | null>(null);
  const [alerts, setAlerts] = useState<PredictiveAlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState('');
  const [openOnly, setOpenOnly] = useState(true);
  const [feedbackAlert, setFeedbackAlert] = useState<PredictiveAlertItem | null>(null);
  const [busyAlert, setBusyAlert] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const load = useCallback(() => {
    Promise.allSettled([
      fetchPredictiveOverview(),
      fetchPredictiveAlerts({ open_only: openOnly, limit: 100 }),
    ]).then(([ov, al]) => {
      if (ov.status === 'fulfilled') setOverview(ov.value);
      if (al.status === 'fulfilled') setAlerts(al.value.items);
      setLoading(false);
    });
  }, [openOnly]);

  useEffect(() => { load(); }, [load]);

  const reasonText = (r: PredictiveReason) =>
    t(`predictive.reasons.${r.code}`, { ...r.params, unit: r.unit ?? '' } as Record<string, unknown>) as string;

  const machines = useMemo(() => {
    let rows = overview?.machines ?? [];
    if (levelFilter) rows = rows.filter((m) => m.level === levelFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((m) =>
        m.name.toLowerCase().includes(q)
        || (m.code ?? '').toLowerCase().includes(q)
        || (m.department ?? '').toLowerCase().includes(q));
    }
    return rows;
  }, [overview, levelFilter, search]);

  const canManage = ['supervisor', 'maintenance_director', 'plant_manager', 'director', 'admin']
    .includes(user?.role ?? '');

  const setStatus = async (a: PredictiveAlertItem, status: PredictiveAlertStatus) => {
    setBusyAlert(a.id);
    try {
      await updateAlertStatus(a.id, { status });
      load();
    } finally {
      setBusyAlert(null);
    }
  };

  const makeTicket = async (a: PredictiveAlertItem) => {
    setBusyAlert(a.id);
    try {
      const res = await createAlertTicket(a.id);
      navigate(`/tickets/${res.ticket_id}`);
    } catch { load(); } finally {
      setBusyAlert(null);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500 text-sm">{t('common.loading')}</div>;
  }

  if (!overview || !overview.visible) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-6">{t('predictive.title')}</h1>
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-10 text-center space-y-3 max-w-xl mx-auto">
          <ShieldQuestion className="mx-auto text-gray-600" size={32} />
          <p className="text-gray-400">{t('predictive.notVisible')}</p>
          <p className="text-gray-600 text-sm">
            {t('predictive.modeLabel')}: {t(`predictive.mode.${overview?.mode ?? 'off'}`)}
          </p>
        </div>
      </div>
    );
  }

  const k = overview.kpis;
  const kpiCards = [
    { label: t('predictive.kpiTracked'), value: k.machines_tracked ?? 0, icon: Activity, tone: 'text-blue-400' },
    { label: t('predictive.kpiCritical'), value: (k.machines_critical ?? 0) + (k.machines_alert ?? 0), icon: AlertTriangle, tone: 'text-red-400' },
    { label: t('predictive.kpiAlertsOpen'), value: k.alerts_open ?? 0, icon: Brain, tone: 'text-orange-400' },
    { label: t('predictive.kpiConfirmed'), value: k.feedback_confirmed_30d ?? 0, icon: CheckCircle2, tone: 'text-emerald-400' },
    { label: t('predictive.kpiFalsePositives'), value: k.feedback_false_positive_30d ?? 0, icon: ShieldQuestion, tone: 'text-gray-400' },
    { label: t('predictive.kpiSensorProblems'), value: k.sensor_problems ?? 0, icon: WifiOff, tone: 'text-amber-400' },
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('predictive.title')}</h1>
          <p className="text-gray-500 text-sm mt-0.5">{t('predictive.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium px-2.5 py-1 rounded-full border ${
            overview.mode === 'active'
              ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
              : 'border-amber-500/20 bg-amber-500/10 text-amber-400'
          }`}>
            {t('predictive.modeLabel')}: {t(`predictive.mode.${overview.mode}`)}
          </span>
          <button onClick={load} className="p-2 rounded-lg border border-white/[0.08] text-gray-400 hover:text-gray-200">
            <RefreshCw size={14} />
          </button>
          {canManage && (
            <button onClick={() => setSettingsOpen(true)} title={t('predictive.settingsTitle')}
                    className="p-2 rounded-lg border border-white/[0.08] text-gray-400 hover:text-gray-200">
              <SettingsIcon size={14} />
            </button>
          )}
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {kpiCards.map((c) => (
          <div key={c.label} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
            <c.icon size={16} className={c.tone} />
            <p className="text-2xl font-bold text-white mt-2">{c.value}</p>
            <p className="text-xs text-gray-500 mt-0.5">{c.label}</p>
          </div>
        ))}
      </div>

      {/* Machine ranking */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02]">
        <div className="p-4 flex items-center gap-3 flex-wrap border-b border-white/[0.06]">
          <h2 className="text-white font-semibold text-sm">{t('predictive.rankingTitle')}</h2>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-600" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('common.search')}
                className="pl-8 pr-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-white w-44"
              />
            </div>
            <select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
              className="px-2 py-1.5 rounded-lg bg-gray-900 border border-white/[0.08] text-sm text-gray-300"
            >
              <option value="">{t('predictive.allLevels')}</option>
              {['critical', 'alert', 'watch', 'normal', 'no_data'].map((l) => (
                <option key={l} value={l}>{t(`predictive.level.${l}`)}</option>
              ))}
            </select>
          </div>
        </div>
        {machines.length === 0 ? (
          <p className="text-gray-500 text-sm p-6 text-center">{t('predictive.noMachines')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-white/[0.06]">
                  <th className="px-4 py-2.5">{t('predictive.colMachine')}</th>
                  <th className="px-3 py-2.5">{t('predictive.colScore')}</th>
                  <th className="px-3 py-2.5">{t('predictive.colLevel')}</th>
                  <th className="px-3 py-2.5 hidden md:table-cell">{t('predictive.colConfidence')}</th>
                  <th className="px-3 py-2.5 hidden lg:table-cell">{t('predictive.colMtbf')}</th>
                  <th className="px-3 py-2.5 hidden lg:table-cell">{t('predictive.colMaturity')}</th>
                  <th className="px-3 py-2.5">{t('predictive.colAlerts')}</th>
                </tr>
              </thead>
              <tbody>
                {machines.map((m) => (
                  <tr
                    key={m.equipment_id}
                    onClick={() => navigate(`/equipment/${m.equipment_id}`)}
                    className="border-b border-white/[0.04] hover:bg-white/[0.03] cursor-pointer"
                  >
                    <td className="px-4 py-2.5">
                      <p className="text-gray-200">{m.name}</p>
                      <p className="text-xs text-gray-600 font-mono">{m.code} {m.department ? `· ${m.department}` : ''}</p>
                    </td>
                    <td className="px-3 py-2.5 min-w-[110px]">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-white/[0.05]">
                          <div className="h-1.5 rounded-full"
                               style={{ width: `${m.score}%`, background: scoreLevelHex(m.score) }} />
                        </div>
                        <span className="text-xs text-gray-300 w-7 text-right">{Math.round(m.score)}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${LEVEL_COLORS[m.level]}`}>
                        {t(`predictive.level.${m.level}`)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-gray-400 text-xs hidden md:table-cell">
                      {m.confidence != null ? `${Math.round(m.confidence * 100)}%` : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-gray-400 text-xs hidden lg:table-cell">
                      {m.mtbf_pct != null ? `${Math.round(m.mtbf_pct)}%` : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-gray-500 text-xs hidden lg:table-cell">
                      {t(`predictive.maturity.${m.maturity ?? 'no_data'}`)}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {m.open_alerts > 0
                        ? <span className="text-xs px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/20">{m.open_alerts}</span>
                        : <span className="text-gray-700 text-xs">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Alerts */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02]">
        <div className="p-4 flex items-center gap-3 border-b border-white/[0.06]">
          <h2 className="text-white font-semibold text-sm">{t('predictive.alertsTitle')}</h2>
          <label className="ml-auto flex items-center gap-2 text-xs text-gray-500 cursor-pointer">
            <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
            {t('predictive.openOnly')}
          </label>
        </div>
        {alerts.length === 0 ? (
          <p className="text-gray-500 text-sm p-6 text-center">{t('predictive.noAlerts')}</p>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {alerts.map((a) => (
              <div key={a.id} className="p-4 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${LEVEL_COLORS[a.level]}`}>
                    {t(`predictive.level.${a.level}`)}
                  </span>
                  <Link to={`/equipment/${a.equipment_id}`} className="text-sm text-gray-200 hover:text-blue-300">
                    {a.equipment_name ?? a.equipment_id.slice(0, 8)}
                  </Link>
                  <span className="text-xs text-gray-500">{t(`predictive.kind.${a.kind}`)}</span>
                  {a.probable_component && (
                    <span className="text-xs text-gray-500">· {a.probable_component}</span>
                  )}
                  <span className="text-xs text-gray-600">
                    {a.created_at ? new Date(a.created_at).toLocaleString() : ''}
                  </span>
                  {a.silent && <span className="text-xs text-gray-600">({t('predictive.silentTag')})</span>}
                  <span className="ml-auto text-xs text-gray-500">
                    {Math.round(a.score)}/100 · {t('predictive.confidence')} {Math.round((a.confidence ?? 0) * 100)}%
                  </span>
                </div>
                <ul className="text-xs text-gray-400 space-y-0.5 list-disc list-inside">
                  {a.reasons.slice(0, 5).map((r, i) => <li key={i}>{reasonText(r)}</li>)}
                </ul>
                {a.recommendation && (
                  <p className="text-xs text-blue-300/80">
                    {t('predictive.recommendedAction')}: {t(`predictive.recommendation.${a.recommendation}`)}
                  </p>
                )}
                <div className="flex items-center gap-2 flex-wrap pt-1">
                  <select
                    value={a.status}
                    disabled={busyAlert === a.id}
                    onChange={(e) => setStatus(a, e.target.value as PredictiveAlertStatus)}
                    className="px-2 py-1 rounded-lg bg-gray-900 border border-white/[0.08] text-xs text-gray-300"
                  >
                    {STATUS_FLOW.map((s) => (
                      <option key={s} value={s}>{t(`predictive.status.${s}`)}</option>
                    ))}
                  </select>
                  <button onClick={() => setFeedbackAlert(a)}
                          className="text-xs px-2.5 py-1 rounded-lg border border-white/[0.08] text-gray-400 hover:text-gray-200">
                    {t('predictive.giveFeedback')}
                  </button>
                  {canManage && !a.ticket_id && (
                    <button onClick={() => makeTicket(a)} disabled={busyAlert === a.id}
                            className="text-xs px-2.5 py-1 rounded-lg border border-blue-500/30 text-blue-300 hover:bg-blue-500/10 inline-flex items-center gap-1">
                      <TicketIcon size={11} />
                      {t('predictive.createTicket')}
                    </button>
                  )}
                  {a.ticket_id && (
                    <Link to={`/tickets/${a.ticket_id}`}
                          className="text-xs px-2.5 py-1 rounded-lg border border-white/[0.08] text-gray-400 hover:text-gray-200 inline-flex items-center gap-1">
                      <TicketIcon size={11} />
                      {t('predictive.viewTicket')}
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Backtest / simulation — managers replay history through the live engine
          before trusting or re-tuning it. */}
      {canManage && <BacktestPanel machines={overview.machines} />}

      {feedbackAlert && (
        <FeedbackModal
          alert={feedbackAlert}
          onClose={() => setFeedbackAlert(null)}
          onSubmitted={load}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          machines={overview.machines}
          onClose={() => setSettingsOpen(false)}
          onSaved={load}
        />
      )}
    </div>
  );
};

export default PredictiveDashboard;
