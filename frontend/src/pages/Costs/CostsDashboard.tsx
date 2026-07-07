import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import ReactECharts from 'echarts-for-react';
import {
  DollarSign, Wallet, TrendingUp, PiggyBank, Plus, Loader2, Check,
  ChevronRight, ChevronDown, BarChart3, Table2, Factory, Building2, Trash2, X,
  Flame, Receipt, CalendarRange, Upload, MessageSquareText, Landmark, Truck,
} from 'lucide-react';
import {
  fetchCostPnL, fetchCostCenters, fetchCostCenterBudgets, saveCostCenterBudgets,
  fetchCostByMachine, fetchManageCostCenters, createCostCenter, updateCostCenter,
  deleteCostCenter, saveDeptMap, fetchCostTransactions, importSapCosts,
  type CostPnL, type CostCenterBudgetRow, type CCBudgetItem, type MonthMapEntry,
  type CostByMachine, type CostCenterManaged, type CostTransactions, type CostScope,
  type SapImportResult,
} from '../../api/costs';
import { usePermission } from '../../hooks/usePermission';
import Spinner from '../../components/ui/Spinner';

// English fallbacks for expense types (localized via t('costType.*')).
const COST_TYPE_FALLBACK: Record<string, string> = {
  labor: 'Labor', local_parts: 'Local Parts', external_parts: 'External Parts',
  contracts: 'Contracts', rentals: 'Rentals', other: 'Other', parts: 'Parts used (stock)',
};
const TYPE_COLORS: Record<string, string> = {
  labor: '#3b82f6', parts: '#8b5cf6', local_parts: '#06b6d4', external_parts: '#ec4899',
  contracts: '#f59e0b', rentals: '#10b981', other: '#64748b',
};
// SAP years break spend down by GL account (arbitrary keys) — give each a
// stable color from a palette instead of the grey fallback.
const EXTRA_COLORS = ['#3b82f6', '#8b5cf6', '#06b6d4', '#ec4899', '#f59e0b', '#10b981', '#f97316', '#84cc16'];
const colorFor = (key: string): string => {
  if (TYPE_COLORS[key]) return TYPE_COLORS[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return EXTRA_COLORS[h % EXTRA_COLORS.length];
};
// Work-order types: corrective is the unplanned bucket, everything else is planned work.
// Improvement WOs are the CAPEX scope (mirrors the backend rule).
const WO_TYPE_ORDER = ['corrective', 'preventive', 'predictive', 'inspection', 'improvement'];
const CAPEX_WO_TYPES = ['improvement'];
const WO_TYPE_COLORS: Record<string, string> = {
  corrective: '#ef4444', preventive: '#10b981', predictive: '#06b6d4',
  inspection: '#f59e0b', improvement: '#8b5cf6',
};

// Cost-center label with its SAP code shown as a monospace prefix, e.g.
// "CA101020  Maintenance". Falls back to just the name when there's no code.
function CcName({ code, label }: { code?: string | null; label: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      {code && <span className="text-[11px] font-mono text-gray-500">{code}</span>}
      <span>{label}</span>
    </span>
  );
}

const money = (v: number) => `$${Math.round(v).toLocaleString()}`;
const signedMoney = (v: number) => `${v < 0 ? '-' : ''}$${Math.round(Math.abs(v)).toLocaleString()}`;
const sumMonths = (arr: number[], months: number[]) => months.reduce((s, m) => s + (arr[m - 1] ?? 0), 0);
const cumulative = (arr: number[]) => arr.reduce<number[]>((acc, v, i) => { acc.push((acc[i - 1] ?? 0) + v); return acc; }, []);
const ZEROS = Array(12).fill(0) as number[];

// Custom month-range period key, e.g. "custom:4-7" = April through July.
const parseCustomPeriod = (key: string): { from: number; to: number } | null => {
  const m = /^custom:(\d{1,2})-(\d{1,2})$/.exec(key);
  if (!m) return null;
  const from = Math.min(Math.max(Number(m[1]), 1), 12);
  const to = Math.min(Math.max(Number(m[2]), from), 12);
  return { from, to };
};

type Tab = 'pnl' | 'machine' | 'budget' | 'manage';

export default function CostsDashboard() {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || 'en').slice(0, 2);
  const canEdit = usePermission('costs', 'update');

  const thisYear = new Date().getFullYear();
  const [tab, setTab] = useState<Tab>('pnl');
  const [year, setYear] = useState(thisYear);
  const [pnl, setPnl] = useState<CostPnL | null>(null);
  const [loading, setLoading] = useState(true);
  const [importOpen, setImportOpen] = useState(false);

  // Months map: which calendar (year, month) sits behind each of the 12 slots.
  // Calendar years map Jan..Dec; SAP fiscal years map Dec of year-1 .. Nov.
  const mmap: MonthMapEntry[] = useMemo(
    () => pnl?.month_map ?? Array.from({ length: 12 }, (_, i) => ({ year, month: i + 1 })),
    [pnl, year],
  );
  const fiscal = pnl?.fiscal ?? false;
  const sapMode = pnl?.source === 'sap';

  const monthLabel = (m: number) => {
    const e = mmap[m - 1];
    return new Date(e?.year ?? 2000, (e?.month ?? m) - 1, 1).toLocaleDateString(lang, { month: 'short' });
  };
  // The budget grid stays calendar-keyed (Jan..Dec) even on fiscal years.
  const calMonthLabel = (m: number) => new Date(2000, m - 1, 1).toLocaleDateString(lang, { month: 'short' });
  const monthYearLabel = (e: MonthMapEntry) =>
    new Date(e.year, e.month - 1, 1).toLocaleDateString(lang, { month: 'short', year: 'numeric' });
  const ccLabel = (cc: string) => (cc === 'Unassigned' ? t('costs.unassigned') : cc);
  const typeLabel = (ty: string) => t(`costType.${ty}`, COST_TYPE_FALLBACK[ty] ?? ty);

  // ── Period selector (slot subset the statement rolls up) ──
  // Slot of the current calendar month inside the map (0 = today outside it).
  const now = new Date();
  const todaySlot = mmap.findIndex((e) => e.year === now.getFullYear() && e.month === now.getMonth() + 1) + 1;
  const lastEntry = mmap[11];
  const mapInPast = lastEntry.year < now.getFullYear()
    || (lastEntry.year === now.getFullYear() && lastEntry.month < now.getMonth() + 1);
  const currentMonth = todaySlot > 0 ? todaySlot : mapInPast ? 12 : 0;
  const mmapKey = mmap.map((e) => `${e.year}-${e.month}`).join(',');
  const PERIODS = useMemo(() => {
    const list: { key: string; label: string; months: number[] }[] = [
      { key: 'year', label: t('costs.fullYear'), months: [1,2,3,4,5,6,7,8,9,10,11,12] },
      { key: 'ytd', label: t('costs.ytd'), months: Array.from({ length: Math.max(currentMonth, 1) }, (_, i) => i + 1) },
      { key: 'q1', label: 'Q1', months: [1,2,3] },
      { key: 'q2', label: 'Q2', months: [4,5,6] },
      { key: 'q3', label: 'Q3', months: [7,8,9] },
      { key: 'q4', label: 'Q4', months: [10,11,12] },
    ];
    for (let m = 1; m <= 12; m++) list.push({ key: `m${m}`, label: monthLabel(m), months: [m] });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, currentMonth, lang, mmapKey]);
  const [periodKey, setPeriodKey] = useState('year');
  const custom = parseCustomPeriod(periodKey);
  const months = custom
    ? Array.from({ length: custom.to - custom.from + 1 }, (_, i) => custom.from + i)
    : (PERIODS.find((p) => p.key === periodKey) ?? PERIODS[0]).months;
  const periodLabel = custom
    ? (custom.from === custom.to ? monthLabel(custom.from) : `${monthLabel(custom.from)} – ${monthLabel(custom.to)}`)
    : (PERIODS.find((p) => p.key === periodKey) ?? PERIODS[0]).label;

  const loadPnl = useCallback(async () => {
    setLoading(true);
    try { setPnl(await fetchCostPnL(year)); }
    finally { setLoading(false); }
  }, [year]);
  useEffect(() => { loadPnl(); }, [loadPnl]);

  const YEARS = [thisYear - 2, thisYear - 1, thisYear, thisYear + 1];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('costs.title')}</h1>
          <p className="text-gray-500 text-sm mt-0.5">{t('costs.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {fiscal && (
            <span className="flex items-center gap-1.5 text-xs text-purple-300/90 bg-purple-500/10 border border-purple-500/25 rounded-lg px-3 py-1.5"
              title={t('costs.sapOfficialNote')}>
              <Landmark size={13} />
              {t('costs.fiscalNote', { from: monthYearLabel(mmap[0]), to: monthYearLabel(mmap[11]) })}
            </span>
          )}
          {canEdit && (
            <button onClick={() => setImportOpen(true)} className="btn-secondary py-1.5 px-3 text-sm">
              <Upload size={14} /> {t('costs.importSap')}
            </button>
          )}
          <div className="flex gap-1 bg-[#0d1421] border border-white/[0.06] rounded-lg p-1">
            {YEARS.map((y) => (
              <button key={y} onClick={() => setYear(y)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  year === y ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
                {y}
              </button>
            ))}
          </div>
        </div>
      </div>

      {importOpen && (
        <ImportSapModal onClose={() => setImportOpen(false)}
          onImported={(fy) => { setImportOpen(false); if (fy !== year) setYear(fy); else loadPnl(); }} />
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-[#0d1421] border border-white/[0.06] rounded-lg p-1 w-fit flex-wrap">
        {([
          ['pnl', Table2, t('costs.tabControl')],
          ['machine', Factory, t('costs.tabByMachine')],
          ['budget', Wallet, t('costs.tabBudget')],
          ...(canEdit ? [['manage', Building2, t('costs.tabManage')] as const] : []),
        ] as const).map(([id, Icon, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-2 rounded text-sm font-medium transition-colors ${
              tab === id ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>
      ) : tab === 'pnl' ? (
        <ControlTab pnl={pnl} months={months} periodKey={periodKey} setPeriodKey={setPeriodKey}
          periods={PERIODS} periodLabel={periodLabel} monthLabel={monthLabel} ccLabel={ccLabel} typeLabel={typeLabel} year={year}
          todaySlot={todaySlot} sapMode={sapMode} fiscal={fiscal} />
      ) : tab === 'machine' ? (
        <ByMachineTab year={year} months={months} periodKey={periodKey} setPeriodKey={setPeriodKey}
          periods={PERIODS} periodLabel={periodLabel} monthLabel={monthLabel} typeLabel={typeLabel} fiscal={fiscal} />
      ) : tab === 'manage' ? (
        <ManageTab ccLabel={ccLabel} onSaved={loadPnl} />
      ) : (
        <BudgetTab year={year} canEdit={canEdit} monthLabel={calMonthLabel} ccLabel={ccLabel}
          onSaved={loadPnl} sapMode={sapMode} />
      )}
    </div>
  );
}

// ─── Period picker (preset dropdown + custom month-range calendar) ────────────

function PeriodPicker({ periodKey, setPeriodKey, periods, periodLabel, monthLabel }: {
  periodKey: string;
  setPeriodKey: (k: string) => void;
  periods: { key: string; label: string; months: number[] }[];
  periodLabel: string;
  monthLabel: (m: number) => string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<number | null>(null);   // first month clicked, waiting for the second
  const ref = useRef<HTMLDivElement>(null);
  const custom = parseCustomPeriod(periodKey);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setAnchor(null); }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const selectedMonths = custom
    ? Array.from({ length: custom.to - custom.from + 1 }, (_, i) => custom.from + i)
    : (periods.find((p) => p.key === periodKey) ?? periods[0]).months;

  const clickMonth = (m: number) => {
    if (anchor == null) {
      setAnchor(m);
      setPeriodKey(`custom:${m}-${m}`);
    } else {
      const from = Math.min(anchor, m);
      const to = Math.max(anchor, m);
      setPeriodKey(from === 1 && to === 12 ? 'year' : `custom:${from}-${to}`);
      setAnchor(null);
      setOpen(false);
    }
  };

  return (
    <div ref={ref} className="relative flex items-center gap-1.5">
      <select value={custom ? 'custom' : periodKey}
        onChange={(e) => { if (e.target.value !== 'custom') { setPeriodKey(e.target.value); setAnchor(null); } }}
        className="bg-[#0d1421] border border-white/[0.06] rounded-lg px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500">
        {periods.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        {custom && <option value="custom">{periodLabel}</option>}
      </select>
      <button onClick={() => { setOpen((o) => !o); setAnchor(null); }} title={t('costs.customRange')}
        className={`p-2 rounded-lg border transition-colors ${
          custom ? 'bg-blue-600 border-blue-600 text-white'
            : 'bg-[#0d1421] border-white/[0.06] text-gray-400 hover:text-gray-200'}`}>
        <CalendarRange size={15} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-2 z-40 bg-[#0d1421] border border-white/10 rounded-xl p-3 shadow-2xl w-60">
          <p className="text-xs text-gray-500 mb-2">
            {anchor == null ? t('costs.pickStartMonth') : t('costs.pickEndMonth')}
          </p>
          <div className="grid grid-cols-4 gap-1">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
              const isAnchor = anchor === m;
              const inSelection = anchor == null && selectedMonths.includes(m);
              return (
                <button key={m} onClick={() => clickMonth(m)}
                  className={`px-1 py-1.5 rounded text-xs capitalize transition-colors ${
                    isAnchor ? 'bg-blue-600 text-white'
                      : inSelection ? 'bg-blue-600/25 text-blue-200'
                        : 'text-gray-400 hover:bg-white/[0.06] hover:text-gray-200'}`}>
                  {monthLabel(m)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Budget vs Actual tab (cost-control statement) ────────────────────────────

function ControlTab({ pnl, months, periodKey, setPeriodKey, periods, periodLabel, monthLabel, ccLabel, typeLabel, year, todaySlot, sapMode, fiscal }: {
  pnl: CostPnL | null;
  months: number[];
  periodKey: string;
  setPeriodKey: (k: string) => void;
  periods: { key: string; label: string; months: number[] }[];
  periodLabel: string;
  monthLabel: (m: number) => string;
  ccLabel: (cc: string) => string;
  typeLabel: (ty: string) => string;
  year: number;
  todaySlot: number;              // slot of the current calendar month (0 = outside this year)
  sapMode: boolean;
  fiscal: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [scope, setScope] = useState<CostScope>('opex');
  const [txCc, setTxCc] = useState<string | null>(null);

  const now = new Date();
  // Everything below works in slot space (1..12 over the months map) — on SAP
  // fiscal years slot 1 is December, so "the current month" is its slot.
  const isCurrentYear = todaySlot > 0;
  const curMonth = todaySlot;
  const isOpex = scope === 'opex';
  // On SAP years the official OPEX series is the ledger; the platform-tracked
  // spend only powers the coverage indicator and the drill-downs.
  const sapOfficial = sapMode && isOpex;

  // Period-aware slicing: the time-series charts render only the months in the
  // selected period (full year → all 12; Q2 → Apr–Jun; a single month → one point).
  const mIdx = months.map((m) => m - 1);
  const xLabels = months.map((m) => monthLabel(m));
  const pick = (arr: number[]) => mIdx.map((i) => arr[i] ?? 0);

  const rows = useMemo(() => {
    if (!pnl) return [];
    return pnl.cost_centers.map((c) => {
      const budget = sumMonths(c.budget[scope] ?? ZEROS, months);
      const actual = sumMonths(c.actual[scope] ?? ZEROS, months);
      return { ...c, budgetP: budget, actualP: actual, variance: budget - actual };
    }).filter((r) => r.budgetP !== 0 || r.actualP !== 0)
      .sort((a, b) => b.actualP - a.actualP);
  }, [pnl, months, scope]);

  // Plant-wide monthly arrays for the selected scope
  const totBudgetArr = pnl?.totals.budget[scope] ?? ZEROS;
  const totActualArr = pnl?.totals.actual[scope] ?? ZEROS;
  const totCommittedArr = pnl?.totals.committed?.[scope] ?? ZEROS;
  const prevActualArr = pnl?.prev_actual?.[scope] ?? ZEROS;
  const woTypeMonthly = useMemo(() => {
    const out: Record<string, number[]> = {};
    Object.entries(pnl?.by_wo_type ?? {}).forEach(([wt, expenses]) => {
      const isCapexType = CAPEX_WO_TYPES.includes(wt);
      if (scope === 'capex' ? !isCapexType : isCapexType) return;
      const arr = Array(12).fill(0);
      Object.values(expenses).forEach((a) => { for (let i = 0; i < 12; i++) arr[i] += a[i] ?? 0; });
      if (arr.some((v) => v > 0)) out[wt] = arr;
    });
    return out;
  }, [pnl, scope]);

  // ── Summary cards ──
  const totBudget = sumMonths(totBudgetArr, months);
  const totActual = sumMonths(totActualArr, months);
  const totVar = totBudget - totActual;
  const consumedPct = totBudget > 0 ? Math.round((totActual / totBudget) * 100) : null;
  const consumedColor = consumedPct == null ? 'text-gray-500'
    : consumedPct <= 90 ? 'text-green-400' : consumedPct <= 100 ? 'text-amber-400' : 'text-red-400';

  const prevPeriod = sumMonths(prevActualArr, months);
  const yoyPct = prevPeriod > 0 ? Math.round(((totActual - prevPeriod) / prevPeriod) * 100) : null;
  const daysInCurMonth = pnl?.current_month?.days_in_month ?? 30;
  const elapsedPct = isCurrentYear
    ? Math.round((((curMonth - 1) + Math.min(now.getDate(), daysInCurMonth) / daysInCurMonth) / 12) * 100)
    : 100;

  // Unplanned share is measured on the platform-tracked spend (WO types only
  // exist there) — on SAP years the official actual is a different series.
  const unplanned = sumMonths(woTypeMonthly.corrective ?? ZEROS, months);
  const trackedWoTotal = Object.values(woTypeMonthly).reduce((s, arr) => s + sumMonths(arr, months), 0);
  const unplannedPct = trackedWoTotal > 0 ? Math.round((unplanned / trackedWoTotal) * 100) : null;
  const unplannedColor = unplannedPct == null ? 'text-gray-500'
    : unplannedPct <= 25 ? 'text-green-400' : unplannedPct <= 40 ? 'text-amber-400' : 'text-red-400';

  // Coverage: how much of the official SAP actual is visible on work orders.
  const trackedOpex = sumMonths(pnl?.totals.tracked_actual ?? ZEROS, months);
  const coveragePct = sapOfficial && totActual > 0 ? Math.round((trackedOpex / totActual) * 100) : null;

  // Open-PO commitments per slot (known future costs feeding the forecast).
  const pickedCommitted = pick(totCommittedArr);
  const committedPeriod = sumMonths(totCommittedArr, months);
  // A future month is forecast to land at whichever is higher: its budget (the
  // plan) or its open commitments (POs already emitted).
  const slotToGo = (m: number) => Math.max(totBudgetArr[m - 1] ?? 0, totCommittedArr[m - 1] ?? 0);

  // ── Period forecast (EAC): complete months at actuals, the current month
  // projected (run rate / SAP posting, plus its own commitments), remaining
  // months at max(budget, commitments). Keeps the S-curve and bridge in sync. ──
  const cm = pnl?.current_month ?? null;
  const cmElapsed = cm ? Math.min(cm.today, cm.days_in_month) : 0;
  const cmMtd = cm ? (cm.daily[scope] ?? []).slice(0, cmElapsed).reduce((s, v) => s + v, 0) : 0;
  const cmProjected = cm && cmElapsed > 0 ? (cmMtd / cmElapsed) * cm.days_in_month : 0;
  // On SAP years the tracked daily run rate under-reads the ledger; project the
  // current month from what SAP already posted vs the month's budget instead.
  const curSlotActual = curMonth > 0 ? (totActualArr[curMonth - 1] ?? 0) : 0;
  const curSlotCommitted = curMonth > 0 ? (totCommittedArr[curMonth - 1] ?? 0) : 0;
  const cmMtdEff = sapOfficial ? curSlotActual : cmMtd;
  const cmProjectedBase = sapOfficial
    ? Math.max(curSlotActual, curMonth > 0 ? (totBudgetArr[curMonth - 1] ?? 0) : 0)
    : cmProjected;
  // Fold the current month's own open commitments into its projection.
  const cmProjectedEff = Math.max(cmProjectedBase, curSlotActual + curSlotCommitted);
  const hasCurMonth = isCurrentYear && months.includes(curMonth);

  const pickedBudget = pick(totBudgetArr);
  const pickedActual = pick(totActualArr);
  const pickedPrev = pick(prevActualArr);
  const pastMonths = isCurrentYear ? months.filter((m) => m < curMonth) : months;
  const actualPast = pastMonths.reduce((s, m) => s + (totActualArr[m - 1] ?? 0), 0);
  const budgetToGo = isCurrentYear
    ? months.filter((m) => m > curMonth).reduce((s, m) => s + slotToGo(m), 0) : 0;
  const periodBudget = totBudget;
  const eac = actualPast + (hasCurMonth ? cmProjectedEff : 0) + budgetToGo;
  const elapsedFrac = pastMonths.length + (hasCurMonth && cm ? cmElapsed / cm.days_in_month : 0);
  const runRate = elapsedFrac > 0
    ? ((actualPast + (hasCurMonth ? cmMtdEff : 0)) / elapsedFrac) * months.length : 0;
  const vac = periodBudget - eac;

  // ── Cumulative S-curve with forecast (over the selected months) ──
  const cumBudget = cumulative(pickedBudget);
  const cumActualFull = cumulative(pickedActual);
  // The booked line stops at the last COMPLETE month; the current month lives on
  // the forecast line (its booked value is partial — and the demo data even
  // carries future-dated lines inside the month).
  const cumActual = isCurrentYear
    ? cumActualFull.map((v, j) => (months[j] < curMonth ? v : null))
    : cumActualFull;
  const forecastData = useMemo(() => {
    if (!isCurrentYear) return null;
    let lastIdx = -1;
    months.forEach((m, j) => { if (m < curMonth) lastIdx = j; });
    const hasCur = months.includes(curMonth);
    if (lastIdx >= months.length - 1) return null;              // period fully in the past
    if (lastIdx < 0 && !hasCur) return null;                    // period fully in the future
    const data: (number | null)[] = months.map(() => null);
    let acc = lastIdx >= 0 ? (cumActualFull[lastIdx] ?? 0) : 0;
    if (lastIdx >= 0) data[lastIdx] = acc;
    for (let j = lastIdx + 1; j < months.length; j++) {
      acc += months[j] === curMonth ? cmProjectedEff : Math.max(pickedBudget[j] ?? 0, pickedCommitted[j] ?? 0);
      data[j] = acc;
    }
    return data;
  }, [isCurrentYear, curMonth, months, cmProjectedEff, cumActualFull, pickedBudget, pickedCommitted]);

  // ── Current-month landing (daily cumulative + run-rate projection) ──
  const landing = useMemo(() => {
    if (!cm) return null;
    const daily = cm.daily[scope] ?? [];
    const cum = cumulative(daily);
    const elapsed = Math.min(cm.today, cm.days_in_month);
    const mtd = cum[elapsed - 1] ?? 0;
    const rate = elapsed > 0 ? mtd / elapsed : 0;
    const projected = mtd + rate * (cm.days_in_month - elapsed);
    // Budget of the current month's SLOT (curMonth), not its calendar index.
    const monthBudget = curMonth > 0 ? (totBudgetArr[curMonth - 1] ?? 0) : 0;
    return {
      mtd, projected, monthBudget,
      actualData: cum.map((v, i) => (i < elapsed ? v : null)),
      forecastData: cum.map((_, i) => (i < elapsed - 1 ? null : mtd + rate * (i + 1 - elapsed))),
      budgetData: Array.from({ length: cm.days_in_month }, (_, i) => monthBudget * ((i + 1) / cm.days_in_month)),
    };
  }, [cm, scope, totBudgetArr, curMonth]);

  // Bridge view — landing of the SELECTED PERIOD by expense type: elapsed months
  // at actuals, the current month projected at run rate, upcoming months at budget.
  // `curMonth` is the slot of the current month (calendar or fiscal); cm.daily is
  // always the current calendar month, mapped onto that slot.
  const [landingView, setLandingView] = useState<'bridge' | 'curve'>('bridge');
  const periodLanding = useMemo(() => {
    if (!cm) return null;
    const hasCur = months.includes(curMonth);
    const byType: Record<string, number> = {};

    if (sapOfficial) {
      // SAP: actuals are posted per GL account per month — no daily run rate.
      // Take every posted month in the period, then top the current month up to
      // its budget and roll the remaining months at budget (matches the EAC).
      months.forEach((m) => pnl?.cost_centers.forEach((c) =>
        Object.entries(c.by_type[scope] ?? {}).forEach(([k, arr]) => {
          const v = arr[m - 1] ?? 0;
          if (v) byType[k] = (byType[k] ?? 0) + v;
        })));
      const curActual = curMonth > 0 ? (totActualArr[curMonth - 1] ?? 0) : 0;
      // Top the current month up to whichever is higher, its budget or its own
      // commitments; roll remaining months at max(budget, commitments).
      const curTarget = curMonth > 0 ? Math.max(totBudgetArr[curMonth - 1] ?? 0, curActual + curSlotCommitted) : 0;
      const curTopUp = hasCur ? Math.max(0, curTarget - curActual) : 0;
      const futureBudget = months.filter((m) => m > curMonth)
        .reduce((s, m) => s + slotToGo(m), 0) + curTopUp;
      const entries = Object.entries(byType)
        .filter(([, v]) => Math.round(v) !== 0)
        .map(([type, value]) => ({ type, value }))
        .sort((a, b) => b.value - a.value);
      const landingTotal = entries.reduce((s, e) => s + e.value, 0) + futureBudget;
      const budget = sumMonths(totBudgetArr, months);
      return { entries, futureBudget, landingTotal, budget, variance: budget - landingTotal, hasCur };
    }

    // Platform-tracked: elapsed months at actuals, the current month projected at
    // the day-of-month run rate, upcoming months at budget.
    const elapsedDays = Math.min(cm.today, cm.days_in_month);
    const factor = elapsedDays > 0 ? cm.days_in_month / elapsedDays : 0;
    const pastMonths = months.filter((m) => m < curMonth);
    const futureMonths = months.filter((m) => m > curMonth);
    pnl?.cost_centers.forEach((c) => Object.entries(c.by_type[scope] ?? {}).forEach(([k, arr]) => {
      const v = pastMonths.reduce((s, m) => s + (arr[m - 1] ?? 0), 0);
      if (v) byType[k] = (byType[k] ?? 0) + v;
    }));
    if (hasCur) {
      Object.entries(cm.mtd_by_type?.[scope] ?? {}).forEach(([k, mtd]) => {
        byType[k] = (byType[k] ?? 0) + mtd * factor;
      });
    }
    const entries = Object.entries(byType)
      .filter(([, v]) => Math.round(v) !== 0)
      .map(([type, value]) => ({ type, value }))
      .sort((a, b) => b.value - a.value);
    const futureBudget = futureMonths.reduce((s, m) => s + slotToGo(m), 0);
    const landingTotal = entries.reduce((s, e) => s + e.value, 0) + futureBudget;
    const budget = sumMonths(totBudgetArr, months);
    return { entries, futureBudget, landingTotal, budget, variance: budget - landingTotal, hasCur };
  }, [cm, months, pnl, scope, totBudgetArr, totActualArr, totCommittedArr, curSlotCommitted, curMonth, sapOfficial]);

  const bridgeOption = useMemo(() => {
    if (!periodLanding) return null;
    const { entries, futureBudget, budget } = periodLanding;
    // Reference bar (period budget), then a contribution walk from zero — one
    // floating block per expense type (down for credits), a grey block for
    // upcoming months at budget — closing on the anchored landing bar.
    const labels = [t('costs.budget'), ...entries.map((e) => typeLabel(e.type))];
    const base: number[] = [0];
    const visible: { value: number; itemStyle: object }[] = [
      { value: Math.round(budget), itemStyle: { color: '#a855f7', borderRadius: [4, 4, 0, 0] } },
    ];
    let cum = 0;
    entries.forEach((e) => {
      base.push(Math.min(cum, cum + e.value));
      visible.push({ value: Math.round(Math.abs(e.value)), itemStyle: { color: colorFor(e.type), borderRadius: [4, 4, 0, 0] } });
      cum += e.value;
    });
    if (futureBudget > 0) {
      // SAP: this block is the current-month top-up + remaining months at budget;
      // platform-tracked: strictly the upcoming months at budget.
      labels.push(t(sapOfficial ? 'costs.remainingBudgetBlock' : 'costs.futureBudgetBlock'));
      base.push(cum);
      visible.push({ value: Math.round(futureBudget), itemStyle: { color: '#64748b', borderRadius: [4, 4, 0, 0] } });
      cum += futureBudget;
    }
    labels.push(t('costs.projLanding'));
    base.push(0);
    visible.push({ value: Math.round(cum), itemStyle: { color: '#3b82f6', borderRadius: [4, 4, 0, 0] } });
    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        formatter: (p: { name: string; value: number }) => `${p.name}: ${money(p.value)}`,
      },
      grid: { left: '3%', right: '4%', top: '10%', bottom: '6%', containLabel: true },
      xAxis: { type: 'category', data: labels, axisLabel: { color: '#94a3b8', rotate: 28, fontSize: 10 } },
      yAxis: { type: 'value', axisLabel: { color: '#94a3b8', formatter: (v: number) => `$${v >= 1000 ? `${v / 1000}k` : v}` }, splitLine: { lineStyle: { color: '#1e293b' } } },
      series: [
        { type: 'bar', stack: 'bridge', silent: true, itemStyle: { color: 'transparent' },
          emphasis: { itemStyle: { color: 'transparent' } }, tooltip: { show: false }, data: base },
        { type: 'bar', stack: 'bridge', barMaxWidth: 34, data: visible,
          label: { show: true, position: 'top', color: '#94a3b8', fontSize: 10,
            formatter: (p: { value: number }) => `$${Math.abs(p.value) >= 1000 ? `${Math.round(p.value / 100) / 10}k` : Math.round(p.value)}` } },
      ],
    };
  }, [periodLanding, t, typeLabel, sapOfficial]);

  const landingOption = landing && cm ? {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', valueFormatter: (v: number | null) => (v == null ? '—' : money(v)) },
    legend: { textStyle: { color: '#94a3b8' }, top: 0, itemWidth: 14, itemHeight: 8 },
    grid: { left: '3%', right: '4%', top: '16%', bottom: '6%', containLabel: true },
    xAxis: { type: 'category', data: Array.from({ length: cm.days_in_month }, (_, i) => String(i + 1)), axisLabel: { color: '#94a3b8' } },
    yAxis: { type: 'value', axisLabel: { color: '#94a3b8', formatter: (v: number) => `$${v >= 1000 ? `${v / 1000}k` : v}` }, splitLine: { lineStyle: { color: '#1e293b' } } },
    series: [
      { name: t('costs.cumBudget'), type: 'line', symbol: 'none', data: landing.budgetData,
        lineStyle: { color: '#a855f7', width: 2, type: 'dashed' }, itemStyle: { color: '#a855f7' } },
      { name: t('costs.cumActual'), type: 'line', symbol: 'circle', symbolSize: 4, data: landing.actualData,
        lineStyle: { color: '#3b82f6', width: 2.5 }, itemStyle: { color: '#3b82f6' },
        areaStyle: { color: 'rgba(59,130,246,0.12)' } },
      { name: t('costs.forecastLine'), type: 'line', symbol: 'none', data: landing.forecastData,
        lineStyle: { color: '#94a3b8', width: 2, type: 'dotted' }, itemStyle: { color: '#94a3b8' } },
    ],
  } : null;

  const sCurveOption = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', valueFormatter: (v: number | null) => (v == null ? '—' : money(v)) },
    legend: { textStyle: { color: '#94a3b8' }, top: 0, itemWidth: 14, itemHeight: 8 },
    grid: { left: '3%', right: '4%', top: '16%', bottom: '6%', containLabel: true },
    xAxis: { type: 'category', data: xLabels, axisLabel: { color: '#94a3b8' } },
    yAxis: { type: 'value', axisLabel: { color: '#94a3b8', formatter: (v: number) => `$${v >= 1000 ? `${v / 1000}k` : v}` }, splitLine: { lineStyle: { color: '#1e293b' } } },
    series: [
      { name: t('costs.cumBudget'), type: 'line', symbol: 'none', data: cumBudget,
        lineStyle: { color: '#a855f7', width: 2, type: 'dashed' }, itemStyle: { color: '#a855f7' } },
      { name: t('costs.cumActual'), type: 'line', symbol: 'circle', symbolSize: 5, data: cumActual,
        lineStyle: { color: '#3b82f6', width: 2.5 }, itemStyle: { color: '#3b82f6' },
        areaStyle: { color: 'rgba(59,130,246,0.12)' } },
      ...(forecastData ? [{ name: t('costs.forecastLine'), type: 'line', symbol: 'none', data: forecastData,
        lineStyle: { color: '#94a3b8', width: 2, type: 'dotted' }, itemStyle: { color: '#94a3b8' } }] : []),
    ],
  };

  // ── Monthly bars vs budget, with previous-year ghost line ──
  const hasPrev = pickedPrev.some((v) => v > 0);
  const monthlyOption = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', valueFormatter: (v: number | null) => (v == null ? '—' : money(v)) },
    legend: { textStyle: { color: '#94a3b8' }, top: 0, itemWidth: 14, itemHeight: 8 },
    grid: { left: '3%', right: '4%', top: '16%', bottom: '6%', containLabel: true },
    xAxis: { type: 'category', data: xLabels, axisLabel: { color: '#94a3b8' } },
    yAxis: { type: 'value', axisLabel: { color: '#94a3b8', formatter: (v: number) => `$${v >= 1000 ? `${v / 1000}k` : v}` }, splitLine: { lineStyle: { color: '#1e293b' } } },
    series: [
      { name: t('costs.actual'), type: 'bar', barMaxWidth: 28,
        data: pickedActual.map((v: number, j: number) => ({ value: v, itemStyle: { color: pickedBudget[j] > 0 && v > pickedBudget[j] ? '#ef4444' : '#3b82f6', borderRadius: [4, 4, 0, 0] } })) },
      { name: t('costs.budget'), type: 'line', step: 'middle', symbol: 'none', data: pickedBudget,
        lineStyle: { color: '#a855f7', width: 2, type: 'dashed' }, itemStyle: { color: '#a855f7' } },
      ...(hasPrev ? [{ name: String(pnl?.prev_year ?? year - 1), type: 'line', smooth: true, symbol: 'none',
        data: pickedPrev, lineStyle: { color: '#64748b', width: 1.5 }, itemStyle: { color: '#64748b' } }] : []),
    ],
  };

  // ── Planned vs unplanned (by WO type) ──
  const woTypes = [...WO_TYPE_ORDER.filter((wt) => woTypeMonthly[wt]),
    ...Object.keys(woTypeMonthly).filter((wt) => !WO_TYPE_ORDER.includes(wt))];
  const unplannedShareLine = months.map((m) => {
    const i = m - 1;
    const tot = woTypes.reduce((s, wt) => s + (woTypeMonthly[wt]?.[i] ?? 0), 0);
    return tot > 0 ? Math.round(((woTypeMonthly.corrective?.[i] ?? 0) / tot) * 100) : null;
  });
  const woTypeLabel = (wt: string) => t(`type.${wt}`, wt);
  const planOption = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    legend: { textStyle: { color: '#94a3b8' }, top: 0, itemWidth: 14, itemHeight: 8 },
    grid: { left: '3%', right: '4%', top: '18%', bottom: '6%', containLabel: true },
    xAxis: { type: 'category', data: xLabels, axisLabel: { color: '#94a3b8' } },
    yAxis: [
      { type: 'value', axisLabel: { color: '#94a3b8', formatter: (v: number) => `$${v >= 1000 ? `${v / 1000}k` : v}` }, splitLine: { lineStyle: { color: '#1e293b' } } },
      { type: 'value', min: 0, max: 100, axisLabel: { color: '#94a3b8', formatter: '{value}%' }, splitLine: { show: false } },
    ],
    series: [
      ...woTypes.map((wt) => ({
        name: woTypeLabel(wt), type: 'bar', stack: 'wo', barMaxWidth: 28,
        data: pick(woTypeMonthly[wt]),
        itemStyle: { color: WO_TYPE_COLORS[wt] ?? '#64748b' },
        tooltip: { valueFormatter: (v: number | null) => (v == null ? '—' : money(v)) },
      })),
      { name: t('costs.unplannedShare'), type: 'line', yAxisIndex: 1, symbol: 'none', smooth: true,
        data: unplannedShareLine,
        lineStyle: { color: '#f87171', width: 1.5, type: 'dashed' }, itemStyle: { color: '#f87171' },
        tooltip: { valueFormatter: (v: number | null) => (v == null ? '—' : `${v}%`) } },
    ],
  };

  // ── Expense composition for the selected period ──
  const byType: Record<string, number> = {};
  pnl?.cost_centers.forEach((c) => Object.entries(c.by_type[scope] ?? {}).forEach(([k, arr]) => {
    byType[k] = (byType[k] ?? 0) + sumMonths(arr, months);
  }));
  const byTypeEntries = Object.entries(byType).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const compositionOption = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item', formatter: (p: { name: string; value: number; percent: number }) => `${p.name}: ${money(p.value)} (${p.percent}%)` },
    legend: { bottom: '2%', left: 'center', textStyle: { color: '#94a3b8' }, itemWidth: 10, itemHeight: 10 },
    series: [{
      type: 'pie', radius: ['45%', '70%'], center: ['50%', '42%'], avoidLabelOverlap: true,
      label: { show: false }, emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold', color: '#fff' } },
      data: byTypeEntries.map(([k, v]) => ({ name: typeLabel(k), value: Math.round(v), itemStyle: { color: colorFor(k) } })),
      itemStyle: { borderRadius: 4, borderColor: '#0b1120', borderWidth: 2 },
    }],
  };

  const monthFrom = Math.min(...months);
  const monthTo = Math.max(...months);

  return (
    <div className="space-y-6">
      {/* Scope (OPEX / CAPEX) + period selector */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex gap-1 bg-[#0d1421] border border-white/[0.06] rounded-lg p-1">
          {(['opex', 'capex'] as CostScope[]).map((s) => (
            <button key={s} onClick={() => setScope(s)}
              className={`px-3 py-1.5 rounded text-xs font-semibold tracking-wide transition-colors ${
                scope === s ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
              {t(s === 'opex' ? 'costs.scopeOpex' : 'costs.scopeCapex')}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 uppercase tracking-wide">{t('costs.period')}</span>
          <PeriodPicker periodKey={periodKey} setPeriodKey={setPeriodKey} periods={periods}
            periodLabel={periodLabel} monthLabel={monthLabel} />
        </div>
        <span className="text-xs text-gray-600">
          {sapOfficial ? t('costs.sapOfficialNote') : t('costs.capexRuleNote')}
        </span>
      </div>

      {/* Summary cards — column count grows with the optional cards */}
      {(() => {
        const showCommitted = committedPeriod > 0;
        const nCards = (isOpex ? (sapOfficial ? 6 : 5) : 4) + (showCommitted ? 1 : 0);
        const gridCols = ({ 4: 'xl:grid-cols-4', 5: 'xl:grid-cols-5', 6: 'xl:grid-cols-6', 7: 'xl:grid-cols-7' } as Record<number, string>)[nCards];
        return (
          <div className={`grid grid-cols-2 lg:grid-cols-3 ${gridCols} gap-4`}>
            <Card icon={<Wallet size={20} className="text-blue-400" />} label={t('costs.budget')} value={money(totBudget)} sub={periodLabel} color="blue" />
            <Card icon={<DollarSign size={20} className="text-purple-400" />} label={t('costs.actual')} value={money(totActual)}
              sub={yoyPct == null ? periodLabel : t('costs.vsLastYear', { pct: `${yoyPct >= 0 ? '+' : ''}${yoyPct}`, year: pnl?.prev_year ?? year - 1 })} color="purple" />
            <Card icon={<TrendingUp size={20} className={totVar >= 0 ? 'text-green-400' : 'text-red-400'} />}
              label={t('costs.variance')} value={signedMoney(totVar)} sub={totVar >= 0 ? t('costs.underBudget') : t('costs.overBudget')}
              color={totVar >= 0 ? 'green' : 'red'} valueClass={totVar >= 0 ? 'text-green-400' : 'text-red-400'} />
            <Card icon={<PiggyBank size={20} className="text-amber-400" />} label={t('costs.consumed')}
              value={consumedPct == null ? '—' : `${consumedPct}%`}
              sub={isCurrentYear ? t('costs.elapsed', { pct: elapsedPct }) : t('costs.consumedSub')} color="amber" valueClass={consumedColor} />
            {showCommitted && (
              <Card icon={<Truck size={20} className="text-cyan-400" />} label={t('costs.committed')}
                value={money(committedPeriod)} sub={t('costs.committedSub')} color="cyan" />
            )}
            {isOpex && (
              <Card icon={<Flame size={20} className="text-red-400" />} label={t('costs.unplannedShare')}
                value={unplannedPct == null ? '—' : `${unplannedPct}%`} sub={t('costs.unplannedShareSub')} color="red" valueClass={unplannedColor} />
            )}
            {sapOfficial && (
              <Card icon={<Factory size={20} className="text-blue-400" />} label={t('costs.trackedCoverage')}
                value={coveragePct == null ? '—' : `${coveragePct}%`}
                sub={t('costs.trackedCoverageSub', { amount: money(trackedOpex) })} color="blue" />
            )}
          </div>
        );
      })()}

      {/* S-curve + monthly bars (+ current-month landing) */}
      <div className={`grid grid-cols-1 lg:grid-cols-2 ${periodLanding && bridgeOption && cm ? 'xl:grid-cols-3' : ''} gap-4`}>
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
            <div>
              <div className="flex items-center gap-2">
                <TrendingUp size={15} className="text-gray-500" />
                <h3 className="text-sm font-semibold text-gray-300">{t('costs.sCurve')}</h3>
              </div>
              <p className="text-xs text-gray-600">{t('costs.sCurveSub')}</p>
            </div>
            {isCurrentYear && periodBudget > 0 && (
              <div className="flex gap-4 text-right">
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wide">{t('costs.forecastEac')}</p>
                  <p className="text-sm font-semibold text-white font-mono">{money(eac)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wide">{t('costs.runRate')}</p>
                  <p className="text-sm font-semibold text-gray-300 font-mono">{money(runRate)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wide">{t('costs.vac')}</p>
                  <p className={`text-sm font-semibold font-mono ${vac >= 0 ? 'text-green-400' : 'text-red-400'}`}>{signedMoney(vac)}</p>
                </div>
              </div>
            )}
          </div>
          <ReactECharts option={sCurveOption} style={{ height: 300 }} theme="dark" />
        </div>
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-1">
            <BarChart3 size={15} className="text-gray-500" />
            <h3 className="text-sm font-semibold text-gray-300">{t('costs.monthlyChart')}</h3>
          </div>
          <p className="text-xs text-gray-600 mb-2">{t('costs.monthlyChartSub')}</p>
          <ReactECharts option={monthlyOption} style={{ height: 300 }} theme="dark" />
        </div>
        {/* Landing bridge. Platform-tracked years also offer a daily-curve view;
            SAP years project from posted monthly actuals, so bridge only. */}
        {periodLanding && bridgeOption && cm && (
          <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
            <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
              <div>
                <div className="flex items-center gap-2">
                  <CalendarRange size={15} className="text-gray-500" />
                  <h3 className="text-sm font-semibold text-gray-300 capitalize">
                    {t('costs.periodLanding', { period: periodLabel })}
                  </h3>
                </div>
                <p className="text-xs text-gray-600">{t(sapOfficial ? 'costs.sapLandingSub' : 'costs.periodLandingSub')}</p>
              </div>
              <div className="flex items-start gap-4 text-right">
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wide">{t('costs.projLanding')}</p>
                  <p className="text-sm font-semibold text-white font-mono">{money(periodLanding.landingTotal)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wide">{t('costs.budget')}</p>
                  <p className="text-sm font-semibold text-gray-300 font-mono">{money(periodLanding.budget)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wide">{t('costs.projVariance')}</p>
                  <p className={`text-sm font-semibold font-mono ${
                    periodLanding.variance >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {signedMoney(periodLanding.variance)}
                  </p>
                </div>
                <div className="flex gap-1 bg-[#0b1120] border border-white/[0.06] rounded-lg p-1">
                  <button onClick={() => setLandingView('bridge')} title={t('costs.landingBridge')}
                    className={`p-1.5 rounded transition-colors ${
                      landingView !== 'curve' || !periodLanding.hasCur ? 'bg-blue-600 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                    <BarChart3 size={13} />
                  </button>
                  {periodLanding.hasCur && !sapOfficial && (
                    <button onClick={() => setLandingView('curve')} title={t('costs.landingCurve')}
                      className={`p-1.5 rounded transition-colors ${
                        landingView === 'curve' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                      <TrendingUp size={13} />
                    </button>
                  )}
                </div>
              </div>
            </div>
            <ReactECharts
              option={landingView === 'curve' && periodLanding.hasCur && landingOption && !sapOfficial ? landingOption : bridgeOption}
              style={{ height: 300 }} theme="dark" notMerge />
          </div>
        )}
      </div>

      {/* Budget vs actual table */}
      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Table2 size={15} className="text-gray-500" />
          <h3 className="text-sm font-semibold text-gray-300">{t('costs.controlTitle')}</h3>
        </div>
        {rows.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-gray-600 text-sm">{t('common.noData')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] text-gray-500 text-xs uppercase tracking-wider">
                  <th className="text-left py-2 pr-4 font-medium">{t('costs.costCenter')}</th>
                  <th className="text-right py-2 px-3 font-medium">{t('costs.budget')}</th>
                  <th className="text-right py-2 px-3 font-medium">{t('costs.actual')}</th>
                  <th className="text-right py-2 px-3 font-medium">{t('costs.variance')}</th>
                  <th className="text-right py-2 px-3 font-medium">{t('costs.varPct')}</th>
                  <th className="text-right py-2 pl-3 font-medium">{t('costs.pctOfTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const varPct = r.budgetP > 0 ? Math.round((r.variance / r.budgetP) * 100) : null;
                  const pctTotal = totActual > 0 ? Math.round((r.actualP / totActual) * 100) : 0;
                  const overspend = r.variance < 0;
                  const isOpen = expanded === r.cost_center;
                  const typeEntries = Object.entries(r.by_type[scope] ?? {})
                    .map(([k, arr]) => [k, sumMonths(arr, months)] as [string, number])
                    .filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]);
                  const ccComments = isOpex ? (r.comments ?? []).filter((c) => months.includes(c.pos)) : [];
                  return (
                    <Fragment key={r.cost_center}>
                      <tr
                        onClick={() => setExpanded(isOpen ? null : r.cost_center)}
                        className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors cursor-pointer">
                        <td className="py-2 pr-4 text-gray-200">
                          <span className="flex items-center gap-1.5">
                            {isOpen ? <ChevronDown size={13} className="text-gray-500" /> : <ChevronRight size={13} className="text-gray-500" />}
                            <CcName code={r.code} label={ccLabel(r.cost_center)} />
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right text-gray-300 font-mono">{money(r.budgetP)}</td>
                        <td className="py-2 px-3 text-right text-gray-100 font-mono">{money(r.actualP)}</td>
                        <td className={`py-2 px-3 text-right font-mono ${overspend ? 'text-red-400' : 'text-green-400'}`}>{signedMoney(r.variance)}</td>
                        <td className={`py-2 px-3 text-right font-mono ${overspend ? 'text-red-400' : 'text-green-400'}`}>{varPct == null ? '—' : `${varPct}%`}</td>
                        <td className="py-2 pl-3 text-right text-gray-400 font-mono">{pctTotal}%</td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-white/[0.015]">
                          <td colSpan={6} className="px-8 py-3">
                            <div className="space-y-3">
                              <div className="flex items-start justify-between gap-4 flex-wrap">
                                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-x-6 gap-y-2 flex-1 min-w-0">
                                  {typeEntries.length === 0 ? (
                                    <span className="text-xs text-gray-600">{t('costs.noBreakdown')}</span>
                                  ) : typeEntries.map(([k, v]) => (
                                    <div key={k} className="flex items-center gap-2 min-w-0">
                                      <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: colorFor(k) }} />
                                      <span className="text-xs text-gray-400 flex-1 truncate" title={typeLabel(k)}>{typeLabel(k)}</span>
                                      <span className="text-xs text-gray-300 font-mono flex-shrink-0">{money(v)}</span>
                                    </div>
                                  ))}
                                </div>
                                <button onClick={(e) => { e.stopPropagation(); setTxCc(r.cost_center); }}
                                  className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors flex-shrink-0">
                                  <Receipt size={13} /> {t('costs.viewTransactions')}
                                </button>
                              </div>
                              {ccComments.length > 0 && (
                                <div className="border-t border-white/[0.05] pt-2 space-y-1">
                                  <p className="flex items-center gap-1.5 text-[10px] text-gray-500 uppercase tracking-wide">
                                    <MessageSquareText size={11} /> {t('costs.sapComments')}
                                  </p>
                                  {ccComments.map((c, ci) => (
                                    <p key={ci} className="text-xs text-gray-400 whitespace-pre-line">
                                      <span className="text-gray-500 capitalize">{monthLabel(c.pos)}</span>
                                      <span className="text-gray-600"> · {c.account}: </span>
                                      {c.text}
                                    </p>
                                  ))}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-white/[0.1] font-semibold">
                  <td className="py-2.5 pr-4 text-white">{t('costs.totalLabel')}</td>
                  <td className="py-2.5 px-3 text-right text-gray-200 font-mono">{money(totBudget)}</td>
                  <td className="py-2.5 px-3 text-right text-white font-mono">{money(totActual)}</td>
                  <td className={`py-2.5 px-3 text-right font-mono ${totVar < 0 ? 'text-red-400' : 'text-green-400'}`}>{signedMoney(totVar)}</td>
                  <td className={`py-2.5 px-3 text-right font-mono ${totVar < 0 ? 'text-red-400' : 'text-green-400'}`}>{totBudget > 0 ? `${Math.round((totVar / totBudget) * 100)}%` : '—'}</td>
                  <td className="py-2.5 pl-3 text-right text-gray-400 font-mono">100%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Planned vs unplanned (OPEX only) + composition */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {isOpex && (
          <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1">
              <Flame size={15} className="text-gray-500" />
              <h3 className="text-sm font-semibold text-gray-300">{t('costs.planVsUnplan')}</h3>
            </div>
            <p className="text-xs text-gray-600 mb-2">{t('costs.planVsUnplanSub')}</p>
            {woTypes.length === 0 ? (
              <div className="flex items-center justify-center h-[280px] text-gray-600 text-sm">{t('common.noData')}</div>
            ) : (
              <ReactECharts option={planOption} style={{ height: 300 }} theme="dark" />
            )}
          </div>
        )}
        <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-1">{t('costs.expenseComposition', { year })}</h3>
          <p className="text-xs text-gray-600 mb-2">{t('costs.expenseCompositionSub')}</p>
          {byTypeEntries.length === 0 ? (
            <div className="flex items-center justify-center h-[280px] text-gray-600 text-sm">{t('common.noData')}</div>
          ) : (
            <ReactECharts option={compositionOption} style={{ height: 300 }} theme="dark" />
          )}
        </div>
      </div>

      {txCc && (
        <TransactionsModal year={year} monthFrom={monthFrom} monthTo={monthTo}
          costCenter={txCc} scope={scope} fiscal={fiscal}
          title={`${ccLabel(txCc)} — ${periodLabel} (${t(isOpex ? 'costs.scopeOpex' : 'costs.scopeCapex')})`}
          typeLabel={typeLabel} onClose={() => setTxCc(null)} />
      )}
    </div>
  );
}

// ─── Transactions drill-down modal (audit trail) ─────────────────────────────

function TransactionsModal({ year, monthFrom, monthTo, costCenter, equipmentId, scope, fiscal, title, typeLabel, onClose }: {
  year: number;
  monthFrom: number;
  monthTo: number;
  costCenter?: string;
  equipmentId?: string;
  scope?: CostScope;
  fiscal?: boolean;
  title: string;
  typeLabel: (ty: string) => string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<CostTransactions | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchCostTransactions({ year, month_from: monthFrom, month_to: monthTo, cost_center: costCenter, equipment_id: equipmentId, scope, fiscal })
      .then(setData).finally(() => setLoading(false));
  }, [year, monthFrom, monthTo, costCenter, equipmentId, scope, fiscal]);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-[#0d1421] border border-white/10 rounded-xl w-full max-w-4xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 p-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-2 min-w-0">
            <Receipt size={16} className="text-blue-400 flex-shrink-0" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-white truncate">{t('costs.transactions')} · {title}</h3>
              {data && (
                <p className="text-xs text-gray-500">
                  {t('costs.txSummary', { count: data.count, total: money(data.total_amount) })}
                </p>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors flex-shrink-0"><X size={18} /></button>
        </div>
        <div className="overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center h-40"><Spinner size="lg" /></div>
          ) : !data || data.lines.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-gray-600 text-sm">{t('costs.noTransactions')}</div>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06] text-gray-500 text-xs uppercase tracking-wider">
                    <th className="text-left py-2 pr-3 font-medium">{t('common.date')}</th>
                    <th className="text-left py-2 px-3 font-medium">{t('costs.workOrder')}</th>
                    <th className="text-left py-2 px-3 font-medium">{t('costs.machine')}</th>
                    <th className="text-left py-2 px-3 font-medium">{t('common.type')}</th>
                    <th className="text-left py-2 px-3 font-medium">{t('common.description')}</th>
                    <th className="text-right py-2 pl-3 font-medium">{t('costs.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((ln, i) => (
                    <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                      <td className="py-1.5 pr-3 text-gray-400 font-mono text-xs whitespace-nowrap">{ln.date}</td>
                      <td className="py-1.5 px-3 whitespace-nowrap">
                        {ln.wo_id && ln.wo_number ? (
                          <Link to={`/work-orders/${ln.wo_id}`} className="text-blue-400 hover:underline font-mono text-xs" title={ln.wo_title ?? ''}>
                            {ln.wo_number}
                          </Link>
                        ) : (
                          <span className="text-gray-500 text-xs">{t('costs.intervention')}</span>
                        )}
                      </td>
                      <td className="py-1.5 px-3 text-gray-400 text-xs whitespace-nowrap">{ln.equipment_code || ln.equipment_name || '—'}</td>
                      <td className="py-1.5 px-3 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5 text-xs text-gray-300">
                          <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: colorFor(ln.expense_type) }} />
                          {typeLabel(ln.expense_type)}
                        </span>
                      </td>
                      <td className="py-1.5 px-3 text-gray-300 text-xs max-w-[260px] truncate" title={ln.description}>{ln.description}</td>
                      <td className="py-1.5 pl-3 text-right text-gray-100 font-mono text-xs whitespace-nowrap">{money(ln.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-white/[0.1] font-semibold">
                    <td colSpan={5} className="py-2 pr-3 text-white">{t('costs.totalLabel')}</td>
                    <td className="py-2 pl-3 text-right text-white font-mono">{money(data.total_amount)}</td>
                  </tr>
                </tfoot>
              </table>
              {data.truncated && (
                <p className="text-xs text-amber-400/80 mt-3">{t('costs.truncatedNote', { shown: data.lines.length, count: data.count })}</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── By-machine tab ───────────────────────────────────────────────────────────

function ByMachineTab({ year, months, periodKey, setPeriodKey, periods, periodLabel, monthLabel, typeLabel, fiscal }: {
  year: number;
  months: number[];
  periodKey: string;
  setPeriodKey: (k: string) => void;
  periods: { key: string; label: string; months: number[] }[];
  periodLabel: string;
  monthLabel: (m: number) => string;
  typeLabel: (ty: string) => string;
  fiscal: boolean;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<CostByMachine | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [txMachine, setTxMachine] = useState<{ id: string; label: string } | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchCostByMachine(year, fiscal).then(setData).finally(() => setLoading(false));
  }, [year, fiscal]);

  const rows = useMemo(() => {
    if (!data) return [];
    return data.machines.map((m) => ({ ...m, cost: sumMonths(m.monthly, months) }))
      .filter((r) => r.cost > 0)
      .sort((a, b) => b.cost - a.cost);
  }, [data, months]);
  const total = rows.reduce((s, r) => s + r.cost, 0);
  const top = rows.slice(0, 15);

  // Pareto: bars = cost per machine, line = cumulative share of total plant spend.
  let running = 0;
  const paretoCum = top.map((m) => { running += m.cost; return total > 0 ? Math.round((running / total) * 100) : 0; });
  const paretoOption = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { textStyle: { color: '#94a3b8' }, top: 0, itemWidth: 14, itemHeight: 8 },
    grid: { left: '3%', right: '4%', top: '16%', bottom: '2%', containLabel: true },
    xAxis: { type: 'category', data: top.map((m) => m.code || m.name), axisLabel: { color: '#94a3b8', rotate: 40, fontSize: 10 } },
    yAxis: [
      { type: 'value', axisLabel: { color: '#94a3b8', formatter: (v: number) => `$${v >= 1000 ? `${v / 1000}k` : v}` }, splitLine: { lineStyle: { color: '#1e293b' } } },
      { type: 'value', min: 0, max: 100, axisLabel: { color: '#94a3b8', formatter: '{value}%' }, splitLine: { show: false } },
    ],
    series: [
      { name: t('costs.cost'), type: 'bar', barMaxWidth: 22, data: top.map((m) => m.cost),
        itemStyle: { color: '#3b82f6', borderRadius: [4, 4, 0, 0] },
        tooltip: { valueFormatter: (v: number | null) => (v == null ? '—' : money(v)) } },
      { name: t('costs.cumulativePct'), type: 'line', yAxisIndex: 1, symbol: 'circle', symbolSize: 5,
        data: paretoCum, lineStyle: { color: '#f59e0b', width: 2 }, itemStyle: { color: '#f59e0b' },
        tooltip: { valueFormatter: (v: number | null) => (v == null ? '—' : `${v}%`) } },
    ],
  };

  if (loading) return <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 uppercase tracking-wide">{t('costs.period')}</span>
          <PeriodPicker periodKey={periodKey} setPeriodKey={setPeriodKey} periods={periods}
            periodLabel={periodLabel} monthLabel={monthLabel} />
        </div>
        <span className="text-xs text-gray-600">{t('costs.byMachineLaborNote')}</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Card icon={<DollarSign size={20} className="text-purple-400" />} label={t('costs.totalCost')} value={money(total)} sub={periodLabel} color="purple" />
        <Card icon={<Factory size={20} className="text-blue-400" />} label={t('costs.machinesWithCost')} value={String(rows.length)} sub={periodLabel} color="blue" />
        <Card icon={<TrendingUp size={20} className="text-amber-400" />} label={t('costs.topMachine')}
          value={rows[0] ? (rows[0].code || rows[0].name) : '—'} sub={rows[0] ? money(rows[0].cost) : ''} color="amber" />
      </div>

      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
        <div className="flex items-center gap-2 mb-1"><BarChart3 size={15} className="text-gray-500" />
          <h3 className="text-sm font-semibold text-gray-300">{t('costs.paretoTitle')}</h3></div>
        <p className="text-xs text-gray-600 mb-2">{t('costs.paretoSub')}</p>
        {top.length === 0 ? <div className="flex items-center justify-center h-40 text-gray-600 text-sm">{t('common.noData')}</div>
          : <ReactECharts option={paretoOption} style={{ height: 340 }} theme="dark" />}
      </div>

      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3"><Table2 size={15} className="text-gray-500" />
          <h3 className="text-sm font-semibold text-gray-300">{t('costs.costByMachineTitle', { year })}</h3></div>
        {rows.length === 0 ? <div className="flex items-center justify-center h-40 text-gray-600 text-sm">{t('common.noData')}</div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] text-gray-500 text-xs uppercase tracking-wider">
                  <th className="text-left py-2 pr-4 font-medium">{t('costs.machine')}</th>
                  <th className="text-left py-2 px-3 font-medium">{t('costs.code')}</th>
                  <th className="text-right py-2 px-3 font-medium">{t('costs.cost')}</th>
                  <th className="text-right py-2 pl-3 font-medium">{t('costs.pctOfTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const key = r.equipment_id || r.name;
                  const isOpen = expanded === key;
                  const pct = total > 0 ? Math.round((r.cost / total) * 100) : 0;
                  const types = Object.entries(r.by_type)
                    .map(([k, arr]) => [k, sumMonths(arr, months)] as [string, number])
                    .filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
                  return (
                    <Fragment key={key}>
                      <tr onClick={() => setExpanded(isOpen ? null : key)}
                        className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors cursor-pointer">
                        <td className="py-2 pr-4 text-gray-200">
                          <span className="flex items-center gap-1.5">
                            {isOpen ? <ChevronDown size={13} className="text-gray-500" /> : <ChevronRight size={13} className="text-gray-500" />}
                            {r.name}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-gray-500 font-mono text-xs">{r.code || '—'}</td>
                        <td className="py-2 px-3 text-right text-gray-100 font-mono">{money(r.cost)}</td>
                        <td className="py-2 pl-3 text-right text-gray-400 font-mono">{pct}%</td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-white/[0.015]">
                          <td colSpan={4} className="px-8 py-3">
                            <div className="flex items-start justify-between gap-4 flex-wrap">
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 flex-1">
                                {types.length === 0 ? <span className="text-xs text-gray-600">{t('costs.noBreakdown')}</span>
                                  : types.map(([k, v]) => (
                                    <div key={k} className="flex items-center gap-2">
                                      <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: colorFor(k) }} />
                                      <span className="text-xs text-gray-400 flex-1 truncate">{typeLabel(k)}</span>
                                      <span className="text-xs text-gray-300 font-mono">{money(v)}</span>
                                    </div>
                                  ))}
                              </div>
                              {r.equipment_id && (
                                <button onClick={(e) => { e.stopPropagation(); setTxMachine({ id: r.equipment_id!, label: r.code || r.name }); }}
                                  className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors flex-shrink-0">
                                  <Receipt size={13} /> {t('costs.viewTransactions')}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-white/[0.1] font-semibold">
                  <td className="py-2.5 pr-4 text-white" colSpan={2}>{t('costs.totalLabel')}</td>
                  <td className="py-2.5 px-3 text-right text-white font-mono">{money(total)}</td>
                  <td className="py-2.5 pl-3 text-right text-gray-400 font-mono">100%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {txMachine && (
        <TransactionsModal year={year} monthFrom={Math.min(...months)} monthTo={Math.max(...months)}
          equipmentId={txMachine.id} fiscal={fiscal} title={`${txMachine.label} — ${periodLabel}`}
          typeLabel={typeLabel} onClose={() => setTxMachine(null)} />
      )}
    </div>
  );
}

// ─── Budget tab ───────────────────────────────────────────────────────────────

function BudgetTab({ year, canEdit, monthLabel, ccLabel, onSaved, sapMode }: {
  year: number;
  canEdit: boolean;
  monthLabel: (m: number) => string;
  ccLabel: (cc: string) => string;
  onSaved: () => void;
  sapMode: boolean;
}) {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || 'en').slice(0, 2);
  const [kind, setKind] = useState<CostScope>('opex');
  const [rows, setRows] = useState<CostCenterBudgetRow[]>([]);
  const [known, setKnown] = useState<string[]>([]);
  const [readOnly, setReadOnly] = useState(false);
  const [monthMap, setMonthMap] = useState<MonthMapEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [newCc, setNewCc] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setSuccess(false);
    try {
      const [b, k] = await Promise.all([fetchCostCenterBudgets(year, kind), fetchCostCenters()]);
      setRows(b.rows);
      setReadOnly(b.read_only);
      setMonthMap(b.month_map);
      setKnown(k);
    } finally { setLoading(false); }
  }, [year, kind]);
  useEffect(() => { load(); }, [load]);

  // SAP OPEX years label columns by fiscal month (Dec–Nov); everything else is
  // the calendar label passed from the parent.
  const colLabel = (i: number) => {
    const e = monthMap?.[i];
    return e ? new Date(e.year, e.month - 1, 1).toLocaleDateString(lang, { month: 'short' }) : monthLabel(i + 1);
  };
  const editable = canEdit && !readOnly;

  const setCell = (cc: string, m: number, value: number) =>
    setRows((rs) => rs.map((r) => r.cost_center === cc
      ? { ...r, months: r.months.map((v, i) => (i === m ? value : v)) } : r));

  const addRow = (cc: string) => {
    const name = cc.trim();
    if (!name || rows.some((r) => r.cost_center.toLowerCase() === name.toLowerCase())) return;
    setRows((rs) => [...rs, { cost_center: name, months: Array(12).fill(0) }]
      .sort((a, b) => a.cost_center.toLowerCase().localeCompare(b.cost_center.toLowerCase())));
    setNewCc('');
  };

  const handleSave = async () => {
    setSaving(true); setError(''); setSuccess(false);
    try {
      const items: CCBudgetItem[] = [];
      rows.forEach((r) => r.months.forEach((amount, i) => items.push({ cost_center: r.cost_center, month: i + 1, amount: amount || 0 })));
      const saved = await saveCostCenterBudgets(year, kind, items);
      setRows(saved.rows);
      setSuccess(true);
      onSaved();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg === 'opex_budget_from_sap' ? t('costs.opexFromSap') : (msg ?? t('common.error')));
    } finally { setSaving(false); }
  };

  const available = known.filter((k) => !rows.some((r) => r.cost_center.toLowerCase() === k.toLowerCase()));
  const grandTotal = rows.reduce((s, r) => s + r.months.reduce((a, v) => a + (v || 0), 0), 0);
  const colTotal = (m: number) => rows.reduce((s, r) => s + (r.months[m] || 0), 0);

  if (loading) return <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>;

  return (
    <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4 space-y-4">
      {sapMode && !readOnly && (
        <div className="flex items-center gap-2.5 p-3 bg-purple-500/10 border border-purple-500/25 rounded-lg">
          <Landmark size={14} className="text-purple-300 flex-shrink-0" />
          <p className="text-purple-200/90 text-sm">{t('costs.sapBudgetNote')}</p>
        </div>
      )}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold text-gray-300">{t('costs.budgetGrid', { year })}</h3>
            <p className="text-xs text-gray-600">{t('costs.budgetGridSub')}</p>
          </div>
          <div className="flex gap-1 bg-[#0b1120] border border-white/[0.06] rounded-lg p-1">
            {(['opex', 'capex'] as CostScope[]).map((s) => (
              <button key={s} onClick={() => setKind(s)}
                className={`px-3 py-1 rounded text-xs font-semibold tracking-wide transition-colors ${
                  kind === s ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
                {t(s === 'opex' ? 'costs.scopeOpex' : 'costs.scopeCapex')}
              </button>
            ))}
          </div>
        </div>
        {editable && (
          <div className="flex items-center gap-2">
            <input list="cc-options" value={newCc} onChange={(e) => setNewCc(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addRow(newCc); }}
              placeholder={t('costs.selectCostCenter')}
              className="bg-[#0b1120] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 w-64" />
            <datalist id="cc-options">
              {available.map((k) => <option key={k} value={k} />)}
            </datalist>
            <button onClick={() => addRow(newCc)} disabled={!newCc.trim()}
              className="btn-secondary py-1.5 px-3 text-sm disabled:opacity-40"><Plus size={14} /> {t('common.add')}</button>
          </div>
        )}
      </div>

      {readOnly && (
        <div className="flex items-center gap-2.5 p-3 bg-blue-500/10 border border-blue-500/25 rounded-lg">
          <Landmark size={14} className="text-blue-300 flex-shrink-0" />
          <p className="text-blue-200/90 text-sm">{t('costs.opexFromSap')}</p>
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2.5 p-3 bg-green-500/10 border border-green-500/25 rounded-lg">
          <Check size={14} className="text-green-400" /><p className="text-green-400 text-sm">{t('costs.budgetSaved')}</p>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="flex items-center justify-center h-40 text-gray-600 text-sm">{t('costs.noCostCenters')}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="text-sm border-collapse">
            <thead>
              <tr className="text-gray-500 text-xs uppercase tracking-wider">
                <th className="text-left py-2 pr-4 font-medium sticky left-0 bg-[#0d1421] z-10">{t('costs.costCenter')}</th>
                {Array.from({ length: 12 }, (_, i) => (
                  <th key={i} className="text-right py-2 px-2 font-medium capitalize min-w-[72px]">{colLabel(i)}</th>
                ))}
                <th className="text-right py-2 pl-3 font-medium">{t('costs.totalLabel')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const rowTotal = r.months.reduce((a, v) => a + (v || 0), 0);
                return (
                  <tr key={r.cost_center} className="border-t border-white/[0.03] hover:bg-white/[0.02]">
                    <td className="py-1.5 pr-4 text-gray-200 whitespace-nowrap sticky left-0 bg-[#0d1421]">
                      <CcName code={r.code} label={ccLabel(r.cost_center)} />
                    </td>
                    {r.months.map((v, i) => (
                      <td key={i} className="py-1.5 px-1">
                        {readOnly ? (
                          <div className="w-[68px] px-2 py-1 text-xs text-right text-gray-300 font-mono">{v ? money(v) : '—'}</div>
                        ) : (
                          <input type="number" min={0} step={100} value={v || ''} disabled={!canEdit}
                            onChange={(e) => setCell(r.cost_center, i, Number(e.target.value))}
                            placeholder="0"
                            className="w-[68px] bg-[#0b1120] border border-white/10 rounded px-2 py-1 text-xs text-right text-gray-100 focus:outline-none focus:border-blue-500 disabled:opacity-60 disabled:cursor-not-allowed" />
                        )}
                      </td>
                    ))}
                    <td className="py-1.5 pl-3 text-right text-gray-300 font-mono whitespace-nowrap">{money(rowTotal)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-white/[0.1] font-semibold text-gray-200">
                <td className="py-2 pr-4 sticky left-0 bg-[#0d1421]">{t('costs.totalLabel')}</td>
                {Array.from({ length: 12 }, (_, i) => (
                  <td key={i} className="py-2 px-2 text-right font-mono text-xs">{money(colTotal(i))}</td>
                ))}
                <td className="py-2 pl-3 text-right font-mono">{money(grandTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {editable && rows.length > 0 && (
        <div className="flex justify-end pt-2 border-t border-white/[0.06]">
          <button onClick={handleSave} disabled={saving} className="btn-primary">
            {saving ? <><Loader2 size={14} className="animate-spin" /> {t('common.saving')}</> : <><Check size={14} /> {t('common.save')}</>}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Manage cost centers tab ──────────────────────────────────────────────────

function ManageTab({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation();
  const [ccs, setCcs] = useState<CostCenterManaged[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newCode, setNewCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchManageCostCenters();
      setCcs(d.cost_centers);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const refresh = async () => { await load(); onSaved(); };

  const addCc = async () => {
    if (!newName.trim()) return;
    setBusy(true); setErr('');
    try {
      await createCostCenter(newName.trim(), newCode.trim() || undefined);
      setNewName(''); setNewCode(''); await refresh();
    } catch (e: unknown) {
      const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setErr(d === 'cost_center_exists' ? t('costs.ccExists') : t('common.error'));
    } finally { setBusy(false); }
  };

  const patchCc = async (id: string, patch: { name?: string; code?: string | null; active?: boolean }) => {
    setErr('');
    try { await updateCostCenter(id, patch); await refresh(); }
    catch (e: unknown) {
      const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setErr(d === 'cost_center_exists' ? t('costs.ccExists') : t('common.error'));
      await load();
    }
  };

  const removeCc = async (c: CostCenterManaged) => {
    if (!window.confirm(t('costs.deleteCcConfirm', { name: c.name }))) return;
    await deleteCostCenter(c.id); await refresh();
  };

  if (loading) return <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>;

  return (
    <div className="space-y-6">
      {/* Cost-center list (CRUD) */}
      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4 space-y-4">
        <div className="flex items-center gap-2"><Building2 size={15} className="text-gray-500" />
          <h3 className="text-sm font-semibold text-gray-300">{t('costs.costCentersList')}</h3></div>
        {err && (
          <div className="flex items-center gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
            <X size={14} className="text-red-400" /><p className="text-red-400 text-sm">{err}</p>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] text-gray-500 text-xs uppercase tracking-wider">
                <th className="text-left py-2 pr-4 font-medium">{t('costs.name')}</th>
                <th className="text-left py-2 px-3 font-medium">{t('costs.code')}</th>
                <th className="text-center py-2 px-3 font-medium">{t('costs.active')}</th>
                <th className="py-2 pl-3"></th>
              </tr>
            </thead>
            <tbody>
              {ccs.map((c) => (
                <tr key={c.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                  <td className="py-1.5 pr-4">
                    <input defaultValue={c.name} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== c.name) patchCc(c.id, { name: v }); }}
                      className="bg-[#0b1120] border border-white/10 rounded px-2 py-1 text-sm text-gray-100 focus:outline-none focus:border-blue-500 w-full min-w-[160px]" />
                  </td>
                  <td className="py-1.5 px-3">
                    <input defaultValue={c.code ?? ''} onBlur={(e) => { const v = e.target.value.trim(); if (v !== (c.code ?? '')) patchCc(c.id, { code: v }); }}
                      className="bg-[#0b1120] border border-white/10 rounded px-2 py-1 text-sm text-gray-100 focus:outline-none focus:border-blue-500 w-24 font-mono" />
                  </td>
                  <td className="py-1.5 px-3 text-center">
                    <input type="checkbox" checked={c.active} onChange={(e) => patchCc(c.id, { active: e.target.checked })}
                      className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-blue-500 cursor-pointer" />
                  </td>
                  <td className="py-1.5 pl-3 text-right">
                    <button onClick={() => removeCc(c)} className="text-gray-600 hover:text-red-400 transition-colors" title={t('common.delete')}><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addCc(); }}
            placeholder={t('costs.newCostCenter')}
            className="bg-[#0b1120] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 w-56" />
          <input value={newCode} onChange={(e) => setNewCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addCc(); }}
            placeholder={t('costs.code')}
            className="bg-[#0b1120] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 w-28 font-mono" />
          <button onClick={addCc} disabled={busy || !newName.trim()} className="btn-secondary py-1.5 px-3 text-sm disabled:opacity-40">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {t('common.add')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── SAP import modal ─────────────────────────────────────────────────────────

const SAP_IMPORT_ERRORS: Record<string, string> = {
  sap_import_bad_format: 'costs.sapImportBadFormat',
  sap_import_mixed_years: 'costs.sapImportMixedYears',
  sap_import_duplicate_months: 'costs.sapImportDuplicateMonths',
};

function ImportSapModal({ onClose, onImported }: {
  onClose: () => void;
  onImported: (fiscalYear: number) => void;
}) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SapImportResult | null>(null);
  const [error, setError] = useState('');

  const run = async () => {
    if (!file) return;
    setBusy(true); setError('');
    try {
      setResult(await importSapCosts(file));
    } catch (e: unknown) {
      const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(t(SAP_IMPORT_ERRORS[d ?? ''] ?? 'costs.sapImportBadFormat'));
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-[#0d1421] border border-white/10 rounded-xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 p-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <Upload size={16} className="text-blue-400" />
            <h3 className="text-sm font-semibold text-white">{t('costs.importSapTitle')}</h3>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors"><X size={18} /></button>
        </div>
        <div className="p-4 space-y-4">
          {result ? (
            <div className="flex items-start gap-2.5 p-3 bg-green-500/10 border border-green-500/25 rounded-lg">
              <Check size={15} className="text-green-400 flex-shrink-0 mt-0.5" />
              <p className="text-green-300/90 text-sm">
                {t('costs.importSuccess', {
                  year: result.fiscal_year, months: result.months, lines: result.lines,
                  budget: money(result.total_budget), actual: money(result.total_actual),
                })}
              </p>
            </div>
          ) : (
            <>
              <p className="text-xs text-gray-500">{t('costs.importSapHint')}</p>
              <input type="file" accept=".xlsx"
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(''); }}
                className="block w-full text-sm text-gray-300 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-blue-600 file:text-white file:text-sm file:cursor-pointer hover:file:bg-blue-500 cursor-pointer" />
              {error && (
                <div className="flex items-center gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
                  <X size={14} className="text-red-400 flex-shrink-0" />
                  <p className="text-red-400 text-sm">{error}</p>
                </div>
              )}
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-white/[0.06]">
          {result ? (
            <button onClick={() => onImported(result.fiscal_year)} className="btn-primary">
              <Check size={14} /> {t('costs.importDone')}
            </button>
          ) : (
            <>
              <button onClick={onClose} className="btn-secondary py-1.5 px-3 text-sm">{t('common.cancel')}</button>
              <button onClick={run} disabled={!file || busy} className="btn-primary disabled:opacity-40">
                {busy ? <><Loader2 size={14} className="animate-spin" /> {t('common.loading')}</>
                  : <><Upload size={14} /> {t('costs.importSapRun')}</>}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Shared card ──────────────────────────────────────────────────────────────

function Card({ icon, label, value, sub, color, valueClass }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  color: 'blue' | 'amber' | 'green' | 'purple' | 'red' | 'cyan';
  valueClass?: string;
}) {
  const bg: Record<string, string> = {
    blue: 'bg-blue-500/10', amber: 'bg-amber-500/10', green: 'bg-green-500/10',
    purple: 'bg-purple-500/10', red: 'bg-red-500/10', cyan: 'bg-cyan-500/10',
  };
  return (
    <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">{label}</p>
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${bg[color]}`}>{icon}</div>
      </div>
      <p className={`text-2xl font-bold ${valueClass ?? 'text-white'}`}>{value}</p>
      <p className="text-xs text-gray-600 mt-1">{sub}</p>
    </div>
  );
}
