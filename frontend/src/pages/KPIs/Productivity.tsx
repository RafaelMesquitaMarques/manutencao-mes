// Productivity views for the Machine Reports page.
//
//  - ProductivityView         plant-wide, two panes sharing one filter bar:
//                             OVERVIEW  pieces by machine / operator / shift /
//                                       department / weekday / hour / OF
//                             COMPARE   machines, operators, shifts or departments
//                                       side by side over the same window
//  - MachineProductionSection the same story for the single machine on the
//                             Report tab (its shifts, operators and OFs)
//
// Both panes send the SAME filter set to the API (machines, operators, shift,
// department, custom range), so what you compare is always the slice you filtered.
//
// Every number comes off the shift production logs (one row = machine·date·shift)
// except the hour-of-day curve (real per-hour feed) and the per-OF counts (job
// order runs) — both report their own coverage so partial instrumentation is
// visible rather than silently understated.
import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactECharts from 'echarts-for-react';
import {
  Package, CheckCircle2, XCircle, Target, Zap, Factory, Clock,
} from 'lucide-react';
import { fetchProductivity, fetchProductivityCompare } from '../../api/reports';
import type { ProductivityQuery } from '../../api/reports';
import type {
  ProductivityData, ProductivityBucket, ProductivityTrendPoint,
  ProductivityHourly, ProductivityJobOrder, MachineProductionData,
  ProductivityFacets, ProductivityCompareData, ProductivityCompareEntity,
  CompareDimension,
} from '../../types';
import {
  MetricCard, LoadingBlock, Empty, Panel, MultiSelect, Segmented,
  CARD, INPUT, SERIES_COLORS,
  fmtInt, fmtPct, fmtCompact, AXIS_COLOR, SPLIT_COLOR,
} from './reportUI';
import type { MultiOption, DayRange } from './reportUI';

const SHIFT_COLORS: Record<string, string> = {
  morning: '#3b82f6',
  afternoon: '#f59e0b',
  night: '#8b5cf6',
};

const GOOD = '#22c55e';
const REJECT = '#ef4444';
const TARGET = '#64748b';

/** 2024-01-01 was a Monday, so weekday 0..6 maps straight onto it. */
function weekdayLabel(wd: number, lng: string): string {
  const d = new Date(Date.UTC(2024, 0, 1 + wd));
  return new Intl.DateTimeFormat(lng, { weekday: 'short', timeZone: 'UTC' }).format(d);
}

function shortDate(iso: string): string {
  return iso.slice(5);
}

// ─── Plant-wide productivity tab ───────────────────────────────────────────────

/** Sentinel operator option: output logged with nobody selected on the machine.
 *  Offered inside the operator picker rather than as a separate switch, because
 *  "who made these pieces" and "nobody claimed these pieces" are the same question. */
const UNATTRIBUTED = '__unattributed__';

interface ProdFilters {
  machineIds: string[];
  operators: string[];      // may contain UNATTRIBUTED
  shift: string;
  department: string;
}

const EMPTY_FILTERS: ProdFilters = {
  machineIds: [], operators: [], shift: '', department: '',
};

function filtersActive(f: ProdFilters): boolean {
  return f.machineIds.length > 0 || f.operators.length > 0 || !!f.shift || !!f.department;
}

/** The window comes from the page header (one date range for all three tabs);
 *  these filters only narrow WHAT is counted inside it. */
function toQuery(f: ProdFilters, range: DayRange): ProductivityQuery {
  return {
    start: range.start,
    end: range.end,
    ...(f.shift ? { shift: f.shift } : {}),
    ...(f.department ? { department: f.department } : {}),
    machine_ids: f.machineIds,
    operators: f.operators.filter((o) => o !== UNATTRIBUTED),
    include_unattributed: f.operators.includes(UNATTRIBUTED),
  };
}

export function ProductivityView({ range }: { range: DayRange }) {
  const [view, setView] = useState<'overview' | 'compare'>('overview');
  const [filters, setFilters] = useState<ProdFilters>(EMPTY_FILTERS);
  const [dimension, setDimension] = useState<CompareDimension>('machine');
  const [compareKeys, setCompareKeys] = useState<string[]>([]);
  const [top, setTop] = useState(5);
  // Facets arrive with whichever response came last; both endpoints return the
  // same unfiltered option lists, so the pickers stay stable across views.
  const [facets, setFacets] = useState<ProductivityFacets | null>(null);

  const query = useMemo(() => toQuery(filters, range), [filters, range]);
  // Switching dimension invalidates the pinned keys (a machine id is not an
  // operator name) — fall back to "top N of the new dimension".
  const changeDimension = (d: CompareDimension) => {
    setDimension(d);
    setCompareKeys([]);
  };

  return (
    <>
      <FilterBar
        view={view}
        onView={setView}
        filters={filters}
        onFilters={setFilters}
        facets={facets}
      />

      {view === 'overview'
        ? <OverviewPane query={query} onFacets={setFacets} />
        : (
          <ComparePane
            query={query}
            dimension={dimension}
            onDimension={changeDimension}
            keys={compareKeys}
            onKeys={setCompareKeys}
            top={top}
            onTop={setTop}
            onFacets={setFacets}
          />
        )}
    </>
  );
}

// ─── Filter bar ───────────────────────────────────────────────────────────────

function FilterBar({ view, onView, filters, onFilters, facets }: {
  view: 'overview' | 'compare';
  onView: (v: 'overview' | 'compare') => void;
  filters: ProdFilters;
  onFilters: (f: ProdFilters) => void;
  facets: ProductivityFacets | null;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<ProdFilters>) => onFilters({ ...filters, ...patch });

  const machineOptions: MultiOption[] = (facets?.machines ?? []).map((m) => ({
    value: m.id,
    label: m.label,
    hint: [m.code, m.department].filter(Boolean).join(' · ') || undefined,
    count: m.pieces,
  }));
  const operatorOptions: MultiOption[] = [
    ...(facets?.operators ?? []).map((o) => ({ value: o.name, label: o.name, count: o.pieces })),
    { value: UNATTRIBUTED, label: t('productivity.unattributed') },
  ];

  return (
    <div className={`${CARD} p-3 flex flex-wrap items-center gap-3`}>
      <Segmented
        value={view}
        onChange={onView}
        options={[
          { value: 'overview' as const, label: t('productivity.viewOverview') },
          { value: 'compare' as const, label: t('productivity.viewCompare') },
        ]}
      />
      <span className="h-6 w-px bg-white/[0.08]" />

      <MultiSelect
        options={machineOptions}
        selected={filters.machineIds}
        onChange={(machineIds) => set({ machineIds })}
        placeholder={t('productivity.filterMachines')}
        searchPlaceholder={t('productivity.searchMachine')}
        emptyLabel={t('productivity.noMatch')}
        allLabel={t('productivity.selectAll')}
        noneLabel={t('productivity.selectNone')}
      />
      <MultiSelect
        options={operatorOptions}
        selected={filters.operators}
        onChange={(operators) => set({ operators })}
        placeholder={t('productivity.filterOperators')}
        searchPlaceholder={t('productivity.searchOperator')}
        emptyLabel={t('productivity.noMatch')}
        allLabel={t('productivity.selectAll')}
        noneLabel={t('productivity.selectNone')}
        width="w-48"
      />
      <select value={filters.shift} onChange={(e) => set({ shift: e.target.value })} className={INPUT}>
        <option value="">{t('productivity.allShifts')}</option>
        <option value="morning">{t('shift.morning')}</option>
        <option value="afternoon">{t('shift.afternoon')}</option>
        <option value="night">{t('shift.night')}</option>
      </select>
      <select value={filters.department} onChange={(e) => set({ department: e.target.value })} className={INPUT}>
        <option value="">{t('productivity.allDepartments')}</option>
        {(facets?.departments ?? []).map((d) => <option key={d} value={d}>{d}</option>)}
      </select>

      {filtersActive(filters) && (
        <button onClick={() => onFilters(EMPTY_FILTERS)} className="text-xs text-gray-500 hover:text-gray-300">
          {t('common.clearFilters')}
        </button>
      )}
    </div>
  );
}

// ─── Overview ─────────────────────────────────────────────────────────────────

function OverviewPane({ query, onFacets }: {
  query: ProductivityQuery;
  onFacets: (f: ProductivityFacets) => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<ProductivityData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Changing two filters in quick succession fires overlapping requests; without
    // this guard a slower earlier response lands last and the page shows data that
    // no longer matches the pickers.
    let current = true;
    setLoading(true);
    fetchProductivity(query)
      .then((d) => {
        if (!current) return;
        setData(d);
        onFacets(d.facets);
      })
      .catch(() => { if (current) setData(null); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [query]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <LoadingBlock label={t('common.loading')} />;
  if (!data || data.totals.shifts === 0) {
    return <Empty tall label={t('productivity.noData')} hint={t('productivity.noDataHint')} />;
  }
  return <PlantProductivity data={data} />;
}

// ─── Comparison ───────────────────────────────────────────────────────────────

const DIMENSIONS: CompareDimension[] = ['machine', 'operator', 'shift', 'department'];

function ComparePane({ query, dimension, onDimension, keys, onKeys, top, onTop, onFacets }: {
  query: ProductivityQuery;
  dimension: CompareDimension;
  onDimension: (d: CompareDimension) => void;
  keys: string[];
  onKeys: (k: string[]) => void;
  top: number;
  onTop: (n: number) => void;
  onFacets: (f: ProductivityFacets) => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<ProductivityCompareData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let current = true;
    setLoading(true);
    fetchProductivityCompare(dimension, { keys, top }, query)
      .then((d) => {
        if (!current) return;
        setData(d);
        onFacets(d.facets);
      })
      .catch(() => { if (current) setData(null); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [query, dimension, keys, top]);   // eslint-disable-line react-hooks/exhaustive-deps

  const dimLabel = (d: CompareDimension) => t(`productivity.dim_${d}`);
  const entityOptions: MultiOption[] = (data?.available ?? []).map((a) => ({
    value: a.key,
    label: a.unattributed ? t('productivity.unattributed')
      : a.unassigned ? t('productivity.noDepartment')
      : (dimension === 'shift' ? t(`shift.${a.key}`) : a.label),
    hint: a.code ?? undefined,
    count: a.pieces,
  }));

  return (
    <>
      <div className={`${CARD} p-3 flex flex-wrap items-center gap-3`}>
        <Segmented
          value={dimension}
          onChange={onDimension}
          options={DIMENSIONS.map((d) => ({ value: d, label: dimLabel(d) }))}
        />
        <MultiSelect
          options={entityOptions}
          selected={keys}
          onChange={onKeys}
          placeholder={t('productivity.pickEntities')}
          searchPlaceholder={t('productivity.searchEntity')}
          emptyLabel={t('productivity.noMatch')}
          allLabel={t('productivity.selectAll')}
          noneLabel={t('productivity.selectNone')}
          max={SERIES_COLORS.length}
          width="w-60"
        />
        {keys.length === 0 && (
          <>
            <span className="text-[11px] text-gray-500">{t('productivity.showingTop')}</span>
            <Segmented
              size="xs"
              value={String(top)}
              onChange={(v) => onTop(Number(v))}
              options={['3', '5', '8'].map((n) => ({ value: n, label: n }))}
            />
          </>
        )}
      </div>

      {loading ? <LoadingBlock label={t('common.loading')} />
        : !data || data.entities.length === 0
          ? <Empty tall label={t('productivity.noCompareData')} hint={t('productivity.noCompareDataHint')} />
          : <CompareBody data={data} />}
    </>
  );
}

type TrendMetric = 'pieces' | 'good_pieces' | 'rejects' | 'attainment';

function trendValue(p: ProductivityTrendPoint, m: TrendMetric): number | null {
  if (m === 'attainment') {
    return p.target ? Math.round((p.pieces / p.target) * 1000) / 10 : null;
  }
  return p[m];
}

function CompareBody({ data }: { data: ProductivityCompareData }) {
  const { t } = useTranslation();
  const [metric, setMetric] = useState<TrendMetric>('pieces');
  const { dimension, entities, dates } = data;

  const labels = useMemo(
    () => entities.map((e) => {
      if (e.unattributed) return t('productivity.unattributed');
      if (e.unassigned) return t('productivity.noDepartment');
      return dimension === 'shift' ? t(`shift.${e.key}`) : e.label;
    }),
    [entities, dimension, t],
  );

  const trendOption = useMemo(() => {
    const pct = metric === 'attainment';
    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: number | null) => (v == null ? '—' : pct ? `${v}%` : fmtInt(v)),
      },
      legend: { top: 0, type: 'scroll', textStyle: { color: AXIS_COLOR }, itemWidth: 10, itemHeight: 10 },
      grid: { left: '3%', right: '3%', top: 36, bottom: '6%', containLabel: true },
      xAxis: {
        type: 'category',
        data: dates.map(shortDate),
        axisLabel: { color: AXIS_COLOR },
      },
      yAxis: {
        type: 'value',
        axisLabel: {
          color: AXIS_COLOR,
          formatter: (v: number) => (pct ? `${v}%` : fmtCompact(v)),
        },
        splitLine: { lineStyle: { color: SPLIT_COLOR } },
      },
      series: entities.map((e, i) => {
        const byDate = Object.fromEntries(e.trend.map((p) => [p.date, trendValue(p, metric)]));
        return {
          name: labels[i],
          type: 'line',
          smooth: true,
          // A day the entity did not run is a gap, not a zero — connectNulls off.
          connectNulls: false,
          showSymbol: dates.length <= 20,
          symbolSize: 5,
          data: dates.map((d) => byDate[d] ?? null),
          lineStyle: { color: SERIES_COLORS[i % SERIES_COLORS.length], width: 2 },
          itemStyle: { color: SERIES_COLORS[i % SERIES_COLORS.length] },
        };
      }),
    };
  }, [entities, dates, labels, metric]);

  const TREND_METRICS: { value: TrendMetric; labelKey: string }[] = [
    { value: 'pieces', labelKey: 'productivity.pieces' },
    { value: 'good_pieces', labelKey: 'productivity.goodPieces' },
    { value: 'rejects', labelKey: 'productivity.rejects' },
    { value: 'attainment', labelKey: 'productivity.attainment' },
  ];

  return (
    <>
      <Panel
        title={t('productivity.compareTrend')}
        sub={t('productivity.compareTrendSub')}
        right={
          <Segmented
            size="xs"
            value={metric}
            onChange={setMetric}
            options={TREND_METRICS.map((m) => ({ value: m.value, label: t(m.labelKey) }))}
          />
        }
      >
        {dates.length === 0
          ? <Empty label={t('productivity.noData')} />
          : <ReactECharts option={trendOption} style={{ height: 300 }} theme="dark" />}
      </Panel>

      <CompareTable entities={entities} labels={labels} />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <CompareShiftPanel entities={entities} labels={labels} />
        <CompareCrossPanel entities={entities} labels={labels} dimension={dimension} />
      </div>
    </>
  );
}

type Better = 'high' | 'low' | null;

const COMPARE_ROWS: {
  key: keyof ProductivityBucket;
  labelKey: string;
  fmt: (v: number | null) => string;
  better: Better;
}[] = [
  { key: 'pieces', labelKey: 'productivity.pieces', fmt: fmtInt, better: 'high' },
  { key: 'good_pieces', labelKey: 'productivity.goodPieces', fmt: fmtInt, better: 'high' },
  { key: 'rejects', labelKey: 'productivity.rejects', fmt: fmtInt, better: 'low' },
  { key: 'quality_pct', labelKey: 'productivity.quality', fmt: fmtPct, better: 'high' },
  { key: 'scrap_pct', labelKey: 'productivity.scrapRate', fmt: fmtPct, better: 'low' },
  { key: 'target', labelKey: 'productivity.target', fmt: fmtInt, better: null },
  { key: 'attainment_pct', labelKey: 'productivity.attainment', fmt: fmtPct, better: 'high' },
  { key: 'pieces_per_hour', labelKey: 'productivity.perHour', fmt: fmtInt, better: 'high' },
  { key: 'pieces_per_shift', labelKey: 'productivity.perShift', fmt: fmtInt, better: 'high' },
  { key: 'pieces_per_day', labelKey: 'productivity.perDay', fmt: fmtInt, better: 'high' },
  { key: 'oee_pct', labelKey: 'OEE', fmt: fmtPct, better: 'high' },
  { key: 'production_hours', labelKey: 'productivity.productionHours', fmt: (v) => (v == null ? '—' : `${fmtInt(v)}h`), better: null },
  { key: 'shifts', labelKey: 'productivity.shiftsCount', fmt: (v) => (v == null ? '—' : String(v)), better: null },
  { key: 'days', labelKey: 'productivity.daysCount', fmt: (v) => (v == null ? '—' : String(v)), better: null },
];

function CompareTable({ entities, labels }: {
  entities: ProductivityCompareEntity[];
  labels: string[];
}) {
  const { t } = useTranslation();
  // Head-to-head only reads as a delta when there are exactly two sides.
  const duel = entities.length === 2;

  return (
    <Panel title={t('productivity.compareTable')} sub={t('productivity.compareTableSub')}>
      <div className="overflow-x-auto -mx-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-y border-white/[0.06]">
              <th className="px-4 py-2.5 sticky left-0 bg-[#0d1421]">{t('productivity.metric')}</th>
              {labels.map((l, i) => (
                <th key={`${l}-${i}`} className="px-3 py-2.5 text-right whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="w-2 h-2 rounded-full inline-block"
                      style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
                    />
                    {l}
                  </span>
                </th>
              ))}
              {duel && <th className="px-3 py-2.5 text-right">{t('productivity.delta')}</th>}
            </tr>
          </thead>
          <tbody>
            {COMPARE_ROWS.map((row) => {
              const values = entities.map((e) => (e[row.key] as number | null) ?? null);
              const present = values.filter((v): v is number => v != null);
              const best = row.better == null || present.length < 2
                ? null
                : row.better === 'high' ? Math.max(...present) : Math.min(...present);
              const [a, b] = values;
              // Subtracting two already-rounded percentages leaks float noise
              // (0.5999999999999943) — re-round to the metric's own precision.
              const delta = duel && a != null && b != null
                ? Math.round((b - a) * 10) / 10
                : null;
              // "Better" is direction-aware: fewer rejects is an improvement.
              const deltaGood = delta == null || row.better == null
                ? null
                : row.better === 'high' ? delta > 0 : delta < 0;
              return (
                <tr key={String(row.key)} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                  <td className="px-4 py-2 text-gray-400 sticky left-0 bg-[#0d1421]">
                    {row.labelKey.includes('.') ? t(row.labelKey) : row.labelKey}
                  </td>
                  {values.map((v, i) => (
                    <td
                      key={i}
                      className={`px-3 py-2 text-right tabular-nums ${
                        best != null && v === best ? 'text-green-400 font-semibold' : 'text-gray-200'
                      }`}
                    >
                      {row.fmt(v)}
                    </td>
                  ))}
                  {duel && (
                    <td className={`px-3 py-2 text-right tabular-nums ${
                      deltaGood == null ? 'text-gray-500' : deltaGood ? 'text-green-400' : 'text-red-400'
                    }`}>
                      {delta == null
                        ? '—'
                        : `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${row.fmt(Math.abs(delta))}`}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function CompareShiftPanel({ entities, labels }: {
  entities: ProductivityCompareEntity[];
  labels: string[];
}) {
  const { t } = useTranslation();
  const shiftKeys = ['morning', 'afternoon', 'night'];

  const option = useMemo(() => ({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => fmtInt(v) },
    legend: { top: 0, type: 'scroll', textStyle: { color: AXIS_COLOR }, itemWidth: 10, itemHeight: 10 },
    grid: { left: '3%', right: '3%', top: 36, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: shiftKeys.map((s) => t(`shift.${s}`)),
      axisLabel: { color: AXIS_COLOR, interval: 0, fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: AXIS_COLOR, formatter: (v: number) => fmtCompact(v) },
      splitLine: { lineStyle: { color: SPLIT_COLOR } },
    },
    series: entities.map((e, i) => {
      const byShift = Object.fromEntries(e.by_shift.map((b) => [b.key, b.pieces]));
      return {
        name: labels[i],
        type: 'bar',
        data: shiftKeys.map((s) => byShift[s] ?? 0),
        itemStyle: { color: SERIES_COLORS[i % SERIES_COLORS.length], borderRadius: [3, 3, 0, 0] },
      };
    }),
  }), [entities, labels, t]);

  return (
    <Panel title={t('productivity.compareShifts')} sub={t('productivity.compareShiftsSub')}>
      <ReactECharts option={option} style={{ height: 280 }} theme="dark" />
    </Panel>
  );
}

function CompareCrossPanel({ entities, labels, dimension }: {
  entities: ProductivityCompareEntity[];
  labels: string[];
  dimension: CompareDimension;
}) {
  const { t } = useTranslation();
  // Comparing operators? show the machines each ran. Anything else? show who ran it.
  const title = dimension === 'operator'
    ? t('productivity.crossMachines')
    : t('productivity.crossOperators');
  const sub = dimension === 'operator'
    ? t('productivity.crossMachinesSub')
    : t('productivity.crossOperatorsSub');

  return (
    <Panel title={title} sub={sub}>
      <div className="space-y-3 max-h-[280px] overflow-y-auto pr-1">
        {entities.map((e, i) => {
          const total = e.cross.reduce((s, c) => s + c.pieces, 0);
          return (
            <div key={`${e.key}-${i}`}>
              <div className="flex items-center gap-1.5 mb-1.5">
                <span
                  className="w-2 h-2 rounded-full inline-block shrink-0"
                  style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
                />
                <span className="text-xs text-gray-300 font-medium truncate">{labels[i]}</span>
                <span className="text-[11px] text-gray-600">
                  {e.cross.length} {dimension === 'operator' ? t('productivity.machinesShort') : t('productivity.operatorsLogged')}
                </span>
              </div>
              <div className="space-y-1 pl-3.5">
                {e.cross.slice(0, 5).map((c) => (
                  <div key={c.key} className="flex items-center gap-2 text-[11px]">
                    <span className={`w-40 truncate ${c.unattributed ? 'text-gray-500 italic' : 'text-gray-400'}`}>
                      {c.unattributed ? t('productivity.unattributed') : c.label}
                    </span>
                    <span className="flex-1 h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${total ? (c.pieces / total) * 100 : 0}%`,
                          background: SERIES_COLORS[i % SERIES_COLORS.length],
                          opacity: 0.7,
                        }}
                      />
                    </span>
                    <span className="text-gray-400 tabular-nums w-16 text-right">{fmtInt(c.pieces)}</span>
                  </div>
                ))}
                {e.cross.length > 5 && (
                  <p className="text-[11px] text-gray-600">
                    {t('productivity.andMore', { n: e.cross.length - 5 })}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function PlantProductivity({ data }: { data: ProductivityData }) {
  const { t } = useTranslation();
  const tot = data.totals;

  return (
    <>
      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <MetricCard
          icon={<Package size={18} />}
          label={t('productivity.piecesProduced')}
          value={fmtInt(tot.pieces)}
          sub={`${fmtInt(tot.pieces_per_day)} / ${t('productivity.day')}`}
          color="blue"
        />
        <MetricCard
          icon={<CheckCircle2 size={18} />}
          label={t('productivity.goodPieces')}
          value={fmtInt(tot.good_pieces)}
          sub={`${t('productivity.quality')} ${fmtPct(tot.quality_pct)}`}
          color="green"
        />
        <MetricCard
          icon={<XCircle size={18} />}
          label={t('productivity.rejects')}
          value={fmtInt(tot.rejects)}
          sub={`${t('productivity.scrapRate')} ${fmtPct(tot.scrap_pct)}`}
          color="red"
        />
        <MetricCard
          icon={<Target size={18} />}
          label={t('productivity.attainment')}
          value={fmtPct(tot.attainment_pct)}
          sub={`${t('productivity.target')} ${fmtInt(tot.target)}`}
          color={tot.attainment_pct != null && tot.attainment_pct >= 100 ? 'green' : 'amber'}
        />
        <MetricCard
          icon={<Zap size={18} />}
          label={t('productivity.rate')}
          value={tot.pieces_per_hour == null ? '—' : `${fmtInt(tot.pieces_per_hour)}/h`}
          sub={`${fmtInt(tot.pieces_per_shift)} / ${t('productivity.shiftUnit')}`}
          color="teal"
        />
        <MetricCard
          icon={<Factory size={18} />}
          label={t('productivity.coverage')}
          value={String(tot.machines)}
          sub={`${tot.shifts} ${t('productivity.shiftsLogged')} · ${tot.operators} ${t('productivity.operatorsLogged')}`}
          color="gray"
        />
      </div>

      {/* Daily trend */}
      <TrendPanel
        trend={data.trend}
        best={data.best_day}
        title={t('productivity.trendTitle')}
        sub={t('productivity.trendSub')}
      />

      {/* By machine */}
      <MachineRanking items={data.by_machine} />

      {/* By shift + by operator */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <ShiftPanel items={data.by_shift} />
        <OperatorPanel items={data.by_operator} />
      </div>

      {/* Hour of day + weekday */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <HourPanel hourly={data.by_hour} tz={data.timezone} />
        <WeekdayPanel items={data.by_weekday} />
      </div>

      {/* Department + machine×shift matrix */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <DepartmentPanel items={data.by_department} />
        <MatrixPanel items={data.machine_shift} />
      </div>

      {/* Top OFs */}
      <JobOrderPanel items={data.by_job_order} />
    </>
  );
}

// ─── Single-machine production block (Report tab) ──────────────────────────────

export function MachineProductionSection({ production }: { production?: MachineProductionData }) {
  const { t } = useTranslation();
  if (!production) return null;
  const p = production;

  if (p.shifts === 0) {
    return (
      <Panel title={t('productivity.machineTitle')} sub={t('productivity.machineSub')}>
        <Empty label={t('productivity.noData')} hint={t('productivity.noMachineDataHint')} />
      </Panel>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <MetricCard
          icon={<Package size={18} />}
          label={t('productivity.piecesProduced')}
          value={fmtInt(p.pieces)}
          sub={`${fmtInt(p.pieces_per_day)} / ${t('productivity.day')}`}
          color="blue"
        />
        <MetricCard
          icon={<CheckCircle2 size={18} />}
          label={t('productivity.goodPieces')}
          value={fmtInt(p.good_pieces)}
          sub={`${t('productivity.quality')} ${fmtPct(p.quality_pct)}`}
          color="green"
        />
        <MetricCard
          icon={<XCircle size={18} />}
          label={t('productivity.rejects')}
          value={fmtInt(p.rejects)}
          sub={`${t('productivity.scrapRate')} ${fmtPct(p.scrap_pct)}`}
          color="red"
        />
        <MetricCard
          icon={<Target size={18} />}
          label={t('productivity.attainment')}
          value={fmtPct(p.attainment_pct)}
          sub={`${t('productivity.target')} ${fmtInt(p.target)}`}
          color={p.attainment_pct != null && p.attainment_pct >= 100 ? 'green' : 'amber'}
        />
        <MetricCard
          icon={<Zap size={18} />}
          label={t('productivity.rate')}
          value={p.pieces_per_hour == null ? '—' : `${fmtInt(p.pieces_per_hour)}/h`}
          sub={p.target_per_hour
            ? `${t('productivity.target')} ${fmtInt(p.target_per_hour)}/h`
            : `${fmtInt(p.pieces_per_shift)} / ${t('productivity.shiftUnit')}`}
          color="teal"
        />
        <MetricCard
          icon={<Clock size={18} />}
          label={t('productivity.productionHours')}
          value={`${fmtInt(p.production_hours)}h`}
          sub={`${p.shifts} ${t('productivity.shiftsLogged')} · ${p.days} ${t('productivity.days')}`}
          color="gray"
        />
      </div>

      <TrendPanel
        trend={p.trend}
        best={p.best_day}
        title={t('productivity.trendTitle')}
        sub={t('productivity.trendSub')}
      />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <ShiftPanel items={p.by_shift} />
        <OperatorPanel items={p.by_operator} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <HourPanel hourly={p.by_hour} />
        <WeekdayPanel items={p.by_weekday} />
      </div>

      <JobOrderPanel items={p.by_job_order} />
    </>
  );
}

// ─── Panels ───────────────────────────────────────────────────────────────────

function TrendPanel({ trend, best, title, sub }: {
  trend: ProductivityTrendPoint[];
  best: ProductivityTrendPoint | null;
  title: string;
  sub: string;
}) {
  const { t } = useTranslation();
  const option = useMemo(() => ({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { top: 0, textStyle: { color: AXIS_COLOR }, itemWidth: 10, itemHeight: 10 },
    grid: { left: '3%', right: '3%', top: 32, bottom: '6%', containLabel: true },
    xAxis: {
      type: 'category',
      data: trend.map((p) => shortDate(p.date)),
      axisLabel: { color: AXIS_COLOR },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: AXIS_COLOR, formatter: (v: number) => fmtCompact(v) },
      splitLine: { lineStyle: { color: SPLIT_COLOR } },
    },
    series: [
      {
        name: t('productivity.goodPieces'),
        type: 'bar',
        stack: 'p',
        data: trend.map((p) => p.good_pieces),
        itemStyle: { color: GOOD },
      },
      {
        name: t('productivity.rejects'),
        type: 'bar',
        stack: 'p',
        data: trend.map((p) => p.rejects),
        itemStyle: { color: REJECT, borderRadius: [3, 3, 0, 0] },
      },
      {
        name: t('productivity.target'),
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: trend.map((p) => p.target || null),
        lineStyle: { color: TARGET, width: 2, type: 'dashed' },
        itemStyle: { color: TARGET },
      },
    ],
  }), [trend, t]);

  return (
    <Panel
      title={title}
      sub={sub}
      right={best ? (
        <div className="text-right">
          <p className="text-[11px] text-gray-500 uppercase tracking-wide">{t('productivity.bestDay')}</p>
          <p className="text-sm text-gray-200 font-medium">
            {best.date} · {fmtInt(best.pieces)}
          </p>
        </div>
      ) : undefined}
    >
      {trend.length === 0
        ? <Empty label={t('productivity.noData')} />
        : <ReactECharts option={option} style={{ height: 280 }} theme="dark" />}
    </Panel>
  );
}

type MachineMetric = 'pieces' | 'attainment_pct' | 'quality_pct' | 'pieces_per_hour' | 'rejects';

function MachineRanking({ items }: { items: ProductivityBucket[] }) {
  const { t } = useTranslation();
  const [metric, setMetric] = useState<MachineMetric>('pieces');

  const METRICS: { key: MachineMetric; labelKey: string; fmt: (v: number | null) => string }[] = [
    { key: 'pieces', labelKey: 'productivity.pieces', fmt: fmtInt },
    { key: 'attainment_pct', labelKey: 'productivity.attainment', fmt: fmtPct },
    { key: 'quality_pct', labelKey: 'productivity.quality', fmt: fmtPct },
    { key: 'pieces_per_hour', labelKey: 'productivity.perHour', fmt: fmtInt },
    { key: 'rejects', labelKey: 'productivity.rejects', fmt: fmtInt },
  ];
  const def = METRICS.find((m) => m.key === metric)!;

  const top = useMemo(() => {
    const sorted = [...items].sort((a, b) => ((b[metric] ?? 0) as number) - ((a[metric] ?? 0) as number));
    return sorted.slice(0, 15).reverse();
  }, [items, metric]);

  const option = useMemo(() => ({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (ps: { name: string; value: number }[]) => `${ps[0].name}: ${def.fmt(ps[0].value ?? null)}`,
    },
    grid: { left: '3%', right: '12%', top: 8, bottom: 8, containLabel: true },
    xAxis: {
      type: 'value',
      axisLabel: { color: AXIS_COLOR, formatter: (v: number) => fmtCompact(v) },
      splitLine: { lineStyle: { color: SPLIT_COLOR } },
    },
    yAxis: { type: 'category', data: top.map((i) => i.label), axisLabel: { color: AXIS_COLOR } },
    series: [{
      type: 'bar',
      data: top.map((i) => i[metric] ?? 0),
      itemStyle: { color: metric === 'rejects' ? REJECT : '#3b82f6', borderRadius: [0, 4, 4, 0] },
      label: {
        show: true, position: 'right', color: '#cbd5e1',
        formatter: (p: { value: number }) => def.fmt(p.value),
      },
    }],
  }), [top, metric, def]);

  return (
    <Panel
      title={t('productivity.byMachine')}
      sub={t('productivity.byMachineSub')}
      right={
        <div className="flex flex-wrap gap-1 bg-[#0b1120] border border-white/[0.06] rounded-lg p-1">
          {METRICS.map((m) => (
            <button
              key={m.key}
              onClick={() => setMetric(m.key)}
              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                metric === m.key ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {t(m.labelKey)}
            </button>
          ))}
        </div>
      }
    >
      {items.length === 0 ? <Empty label={t('productivity.noData')} /> : (
        <>
          <ReactECharts option={option} style={{ height: Math.max(220, top.length * 30) }} theme="dark" />
          <div className="overflow-x-auto mt-3 -mx-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-y border-white/[0.06]">
                  <th className="px-4 py-2.5">{t('productivity.machine')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.pieces')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.rejects')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.quality')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.target')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.attainment')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.perHour')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.perShift')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.perDay')}</th>
                  <th className="px-3 py-2.5 text-right">OEE</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.shiftsLogged')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((m) => (
                  <tr key={m.key} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                    <td className="px-4 py-2">
                      <span className="text-gray-200 font-medium">{m.label}</span>
                      {m.code && <span className="text-gray-600 ml-1.5 text-xs">{m.code}</span>}
                      {m.department && <div className="text-[11px] text-gray-600">{m.department}</div>}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-200 font-medium">{fmtInt(m.pieces)}</td>
                    <td className="px-3 py-2 text-right text-gray-400">{fmtInt(m.rejects)}</td>
                    <td className="px-3 py-2 text-right text-gray-300">{fmtPct(m.quality_pct)}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{fmtInt(m.target)}</td>
                    <td className={`px-3 py-2 text-right font-medium ${
                      m.attainment_pct == null ? 'text-gray-500'
                        : m.attainment_pct >= 100 ? 'text-green-400'
                        : m.attainment_pct >= 85 ? 'text-amber-400' : 'text-red-400'
                    }`}>{fmtPct(m.attainment_pct)}</td>
                    <td className="px-3 py-2 text-right text-gray-300">{fmtInt(m.pieces_per_hour)}</td>
                    <td className="px-3 py-2 text-right text-gray-300">{fmtInt(m.pieces_per_shift)}</td>
                    <td className="px-3 py-2 text-right text-gray-300">{fmtInt(m.pieces_per_day)}</td>
                    <td className="px-3 py-2 text-right text-gray-300">{fmtPct(m.oee_pct)}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{m.shifts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}

function ShiftPanel({ items }: { items: ProductivityBucket[] }) {
  const { t } = useTranslation();
  const option = useMemo(() => ({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item', formatter: (p: { name: string; value: number; percent: number }) =>
      `${p.name}: ${fmtInt(p.value)} (${p.percent}%)` },
    legend: { bottom: 0, left: 'center', textStyle: { color: AXIS_COLOR }, itemWidth: 10, itemHeight: 10 },
    series: [{
      type: 'pie',
      radius: ['45%', '70%'],
      center: ['50%', '44%'],
      label: { show: false },
      emphasis: { label: { show: true, fontSize: 13, fontWeight: 'bold', color: '#fff' } },
      data: items.map((s) => ({
        name: t(`shift.${s.key}`),
        value: s.pieces,
        itemStyle: { color: SHIFT_COLORS[s.key] ?? '#64748b' },
      })),
      itemStyle: { borderRadius: 4, borderColor: '#0b1120', borderWidth: 2 },
    }],
  }), [items, t]);

  return (
    <Panel title={t('productivity.byShift')} sub={t('productivity.byShiftSub')}>
      {items.length === 0 ? <Empty label={t('productivity.noData')} /> : (
        <>
          <ReactECharts option={option} style={{ height: 220 }} theme="dark" />
          <div className="overflow-x-auto -mx-4 mt-2">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-y border-white/[0.06]">
                  <th className="px-4 py-2.5">{t('productivity.shiftLabel')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.pieces')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.quality')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.attainment')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.perHour')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.perShift')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.key} className="border-b border-white/[0.04]">
                    <td className="px-4 py-2 text-gray-200">
                      <span className="inline-block w-2 h-2 rounded-full mr-2"
                            style={{ background: SHIFT_COLORS[s.key] ?? '#64748b' }} />
                      {t(`shift.${s.key}`)}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-200 font-medium">{fmtInt(s.pieces)}</td>
                    <td className="px-3 py-2 text-right text-gray-300">{fmtPct(s.quality_pct)}</td>
                    <td className="px-3 py-2 text-right text-gray-300">{fmtPct(s.attainment_pct)}</td>
                    <td className="px-3 py-2 text-right text-gray-300">{fmtInt(s.pieces_per_hour)}</td>
                    <td className="px-3 py-2 text-right text-gray-300">{fmtInt(s.pieces_per_shift)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}

function OperatorPanel({ items }: { items: ProductivityBucket[] }) {
  const { t } = useTranslation();
  const named = items.filter((o) => !o.unattributed);
  const unattributed = items.find((o) => o.unattributed);

  const option = useMemo(() => {
    const top = [...named].slice(0, 12).reverse();
    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (ps: { name: string; value: number }[]) => `${ps[0].name}: ${fmtInt(ps[0].value)}`,
      },
      grid: { left: '3%', right: '14%', top: 8, bottom: 8, containLabel: true },
      xAxis: {
        type: 'value',
        axisLabel: { color: AXIS_COLOR, formatter: (v: number) => fmtCompact(v) },
        splitLine: { lineStyle: { color: SPLIT_COLOR } },
      },
      yAxis: { type: 'category', data: top.map((o) => o.label), axisLabel: { color: AXIS_COLOR } },
      series: [{
        type: 'bar',
        data: top.map((o) => o.pieces),
        itemStyle: { color: '#14b8a6', borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: 'right', color: '#cbd5e1', formatter: (p: { value: number }) => fmtInt(p.value) },
      }],
    };
  }, [named]);

  return (
    <Panel
      title={t('productivity.byOperator')}
      sub={t('productivity.byOperatorSub')}
      right={unattributed ? (
        <div className="text-right">
          <p className="text-[11px] text-gray-500 uppercase tracking-wide">{t('productivity.unattributed')}</p>
          <p className="text-sm text-amber-400 font-medium">{fmtInt(unattributed.pieces)}</p>
        </div>
      ) : undefined}
    >
      {named.length === 0 ? (
        <Empty label={t('productivity.noOperatorData')} hint={t('productivity.noOperatorDataHint')} />
      ) : (
        <>
          <ReactECharts option={option} style={{ height: Math.max(200, Math.min(named.length, 12) * 26) }} theme="dark" />
          <div className="overflow-x-auto -mx-4 mt-2">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-y border-white/[0.06]">
                  <th className="px-4 py-2.5">{t('productivity.operator')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.pieces')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.rejects')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.quality')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.attainment')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.perShift')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.perHour')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.machinesShort')}</th>
                  <th className="px-3 py-2.5 text-right">{t('productivity.shiftsLogged')}</th>
                </tr>
              </thead>
              <tbody>
                {named.map((o) => (
                  <tr key={o.key} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                    <td className="px-4 py-2 text-gray-200 font-medium">{o.label}</td>
                    <td className="px-3 py-2 text-right text-gray-200 font-medium">{fmtInt(o.pieces)}</td>
                    <td className="px-3 py-2 text-right text-gray-400">{fmtInt(o.rejects)}</td>
                    <td className="px-3 py-2 text-right text-gray-300">{fmtPct(o.quality_pct)}</td>
                    <td className={`px-3 py-2 text-right ${
                      o.attainment_pct == null ? 'text-gray-500'
                        : o.attainment_pct >= 100 ? 'text-green-400' : 'text-gray-300'
                    }`}>{fmtPct(o.attainment_pct)}</td>
                    <td className="px-3 py-2 text-right text-gray-300">{fmtInt(o.pieces_per_shift)}</td>
                    <td className="px-3 py-2 text-right text-gray-300">{fmtInt(o.pieces_per_hour)}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{o.machines}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{o.shifts}</td>
                  </tr>
                ))}
                {unattributed && (
                  <tr className="border-b border-white/[0.04] bg-amber-500/[0.04]">
                    <td className="px-4 py-2 text-amber-400/90 italic">{t('productivity.unattributed')}</td>
                    <td className="px-3 py-2 text-right text-amber-400/90">{fmtInt(unattributed.pieces)}</td>
                    <td className="px-3 py-2 text-right text-gray-400">{fmtInt(unattributed.rejects)}</td>
                    <td className="px-3 py-2 text-right text-gray-300">{fmtPct(unattributed.quality_pct)}</td>
                    <td className="px-3 py-2 text-right text-gray-300">{fmtPct(unattributed.attainment_pct)}</td>
                    <td className="px-3 py-2 text-right text-gray-300">{fmtInt(unattributed.pieces_per_shift)}</td>
                    <td className="px-3 py-2 text-right text-gray-300">{fmtInt(unattributed.pieces_per_hour)}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{unattributed.machines}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{unattributed.shifts}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {unattributed && (
            <p className="text-[11px] text-gray-600 mt-2">{t('productivity.unattributedHint')}</p>
          )}
        </>
      )}
    </Panel>
  );
}

function HourPanel({ hourly, tz }: { hourly: ProductivityHourly; tz?: string }) {
  const { t } = useTranslation();
  const option = useMemo(() => ({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (ps: { name: string; value: number }[]) => `${ps[0].name}: ${fmtInt(ps[0].value)}`,
    },
    grid: { left: '3%', right: '3%', top: 12, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: hourly.hours.map((h) => `${String(h.hour).padStart(2, '0')}h`),
      axisLabel: { color: AXIS_COLOR, interval: 1 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: AXIS_COLOR, formatter: (v: number) => fmtCompact(v) },
      splitLine: { lineStyle: { color: SPLIT_COLOR } },
    },
    series: [{
      type: 'bar',
      data: hourly.hours.map((h) => h.pieces),
      itemStyle: { color: '#3b82f6', borderRadius: [3, 3, 0, 0] },
    }],
  }), [hourly]);

  return (
    <Panel
      title={t('productivity.byHour')}
      sub={tz ? t('productivity.byHourSubTz', { tz }) : t('productivity.byHourSub')}
      right={hourly.peak_hour != null ? (
        <div className="text-right">
          <p className="text-[11px] text-gray-500 uppercase tracking-wide">{t('productivity.peakHour')}</p>
          <p className="text-sm text-gray-200 font-medium">{String(hourly.peak_hour).padStart(2, '0')}:00</p>
        </div>
      ) : undefined}
    >
      {hourly.pieces === 0 ? (
        <Empty label={t('productivity.noHourData')} hint={t('productivity.noHourDataHint')} />
      ) : (
        <>
          <ReactECharts option={option} style={{ height: 240 }} theme="dark" />
          <p className="text-[11px] text-gray-600 mt-2">
            {t('productivity.hourCoverage', { machines: hourly.machines, pieces: fmtInt(hourly.pieces) })}
          </p>
        </>
      )}
    </Panel>
  );
}

function WeekdayPanel({ items }: { items: ProductivityBucket[] }) {
  const { t, i18n } = useTranslation();
  const option = useMemo(() => {
    const sorted = [...items].sort((a, b) => Number(a.key) - Number(b.key));
    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (ps: { name: string; value: number }[]) => `${ps[0].name}: ${fmtInt(ps[0].value)}`,
      },
      grid: { left: '3%', right: '3%', top: 12, bottom: 8, containLabel: true },
      xAxis: {
        type: 'category',
        data: sorted.map((d) => weekdayLabel(Number(d.key), i18n.language)),
        axisLabel: { color: AXIS_COLOR },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: AXIS_COLOR, formatter: (v: number) => fmtCompact(v) },
        splitLine: { lineStyle: { color: SPLIT_COLOR } },
      },
      series: [{
        type: 'bar',
        data: sorted.map((d) => d.pieces_per_day ?? 0),
        itemStyle: { color: '#8b5cf6', borderRadius: [3, 3, 0, 0] },
        label: {
          show: true, position: 'top', color: '#cbd5e1', fontSize: 10,
          formatter: (p: { value: number }) => fmtCompact(p.value),
        },
      }],
    };
  }, [items, i18n.language]);

  return (
    <Panel title={t('productivity.byWeekday')} sub={t('productivity.byWeekdaySub')}>
      {items.length === 0
        ? <Empty label={t('productivity.noData')} />
        : <ReactECharts option={option} style={{ height: 240 }} theme="dark" />}
    </Panel>
  );
}

function DepartmentPanel({ items }: { items: ProductivityBucket[] }) {
  const { t } = useTranslation();
  const total = items.reduce((s, d) => s + d.pieces, 0);

  return (
    <Panel title={t('productivity.byDepartment')} sub={t('productivity.byDepartmentSub')}>
      {items.length === 0 ? <Empty label={t('productivity.noData')} /> : (
        <div className="space-y-2.5">
          {items.map((d) => {
            const share = total > 0 ? (d.pieces / total) * 100 : 0;
            return (
              <div key={d.key}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className={d.unassigned ? 'text-gray-500 italic' : 'text-gray-300'}>
                    {d.unassigned ? t('productivity.noDepartment') : d.label}
                    <span className="text-gray-600 ml-2">
                      {d.machines} {t('productivity.machinesShort')}
                    </span>
                  </span>
                  <span className="text-gray-400">
                    {fmtInt(d.pieces)} <span className="text-gray-600">({share.toFixed(1)}%)</span>
                  </span>
                </div>
                <div className="h-2 bg-white/[0.04] rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500/70 rounded-full" style={{ width: `${share}%` }} />
                </div>
                <div className="flex gap-4 text-[11px] text-gray-600 mt-1">
                  <span>{t('productivity.quality')} {fmtPct(d.quality_pct)}</span>
                  <span>{t('productivity.attainment')} {fmtPct(d.attainment_pct)}</span>
                  <span>{fmtInt(d.pieces_per_hour)}/h</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function MatrixPanel({ items }: { items: ProductivityBucket[] }) {
  const { t } = useTranslation();

  const { machines, shifts, cells, max } = useMemo(() => {
    const shiftKeys = ['morning', 'afternoon', 'night'];
    const byMachine = new Map<string, string>();
    for (const c of items) byMachine.set(c.machine_id ?? c.key, c.label);
    // Busiest machines first, capped so the heatmap stays readable.
    const totals = new Map<string, number>();
    for (const c of items) {
      const id = c.machine_id ?? c.key;
      totals.set(id, (totals.get(id) ?? 0) + c.pieces);
    }
    const ids = [...byMachine.keys()]
      .sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0))
      .slice(0, 20);
    const idx = new Map(ids.map((id, i) => [id, i]));
    const data: [number, number, number][] = [];
    let m = 0;
    for (const c of items) {
      const y = idx.get(c.machine_id ?? c.key);
      const x = shiftKeys.indexOf(c.shift ?? '');
      if (y == null || x < 0) continue;
      data.push([x, y, c.pieces]);
      m = Math.max(m, c.pieces);
    }
    return {
      machines: ids.map((id) => byMachine.get(id) ?? id),
      shifts: shiftKeys,
      cells: data,
      max: m,
    };
  }, [items]);

  const option = useMemo(() => ({
    backgroundColor: 'transparent',
    tooltip: {
      formatter: (p: { data: [number, number, number] }) =>
        `${machines[p.data[1]]} · ${t(`shift.${shifts[p.data[0]]}`)}<br/>${fmtInt(p.data[2])}`,
    },
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: shifts.map((s) => t(`shift.${s}`)),
      position: 'top',
      // interval 0: never drop a shift label — ECharts hides colliding ones by
      // default, which silently loses the middle (longest) shift name.
      axisLabel: { color: AXIS_COLOR, interval: 0, fontSize: 11 },
      splitArea: { show: true, areaStyle: { color: ['transparent'] } },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'category',
      data: machines,
      inverse: true,
      axisLabel: {
        color: AXIS_COLOR,
        fontSize: 11,
        width: 150,
        overflow: 'truncate',
        // Long catalog names ("Lectra, Découpeuse à textile [Fabric cutting
        // machine]") would eat the plot; keep the head, which identifies them.
        formatter: (v: string) => (v.length > 26 ? `${v.slice(0, 25)}…` : v),
      },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    visualMap: {
      min: 0,
      max: max || 1,
      show: false,
      inRange: { color: ['#0f172a', '#1e3a8a', '#2563eb', '#60a5fa'] },
    },
    series: [{
      type: 'heatmap',
      data: cells,
      label: { show: true, color: '#e2e8f0', fontSize: 10, formatter: (p: { data: [number, number, number] }) => fmtCompact(p.data[2]) },
      itemStyle: { borderColor: '#0b1120', borderWidth: 2 },
    }],
  }), [machines, shifts, cells, max, t]);

  return (
    <Panel title={t('productivity.matrixTitle')} sub={t('productivity.matrixSub')}>
      {cells.length === 0
        ? <Empty label={t('productivity.noData')} />
        : <ReactECharts option={option} style={{ height: Math.max(240, machines.length * 26 + 40) }} theme="dark" />}
    </Panel>
  );
}

function JobOrderPanel({ items }: { items: ProductivityJobOrder[] }) {
  const { t } = useTranslation();
  return (
    <Panel title={t('productivity.byOF')} sub={t('productivity.byOFSub')}>
      {items.length === 0 ? (
        <Empty label={t('productivity.noOFData')} hint={t('productivity.noOFDataHint')} />
      ) : (
        <div className="overflow-x-auto -mx-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-y border-white/[0.06]">
                <th className="px-4 py-2.5">{t('productivity.of')}</th>
                <th className="px-3 py-2.5">{t('productivity.product')}</th>
                <th className="px-3 py-2.5 text-right">{t('productivity.pieces')}</th>
                <th className="px-3 py-2.5 text-right">{t('productivity.targetQty')}</th>
                <th className="px-3 py-2.5 text-right">{t('productivity.completion')}</th>
                <th className="px-3 py-2.5 text-right">{t('productivity.quality')}</th>
                <th className="px-3 py-2.5 text-right">{t('productivity.perHour')}</th>
                <th className="px-3 py-2.5 text-right">{t('productivity.machinesShort')}</th>
                <th className="px-3 py-2.5 text-right">{t('productivity.runs')}</th>
                <th className="px-3 py-2.5">{t('common.status')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.job_number} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                  <td className="px-4 py-2 text-gray-200 font-medium font-mono text-xs">{o.job_number}</td>
                  <td className="px-3 py-2 text-gray-400 max-w-[220px] truncate">{o.product_name ?? '—'}</td>
                  <td className="px-3 py-2 text-right text-gray-200 font-medium">{fmtInt(o.pieces)}</td>
                  <td className="px-3 py-2 text-right text-gray-500">{fmtInt(o.target_quantity)}</td>
                  <td className={`px-3 py-2 text-right ${
                    o.completion_pct == null ? 'text-gray-500'
                      : o.completion_pct >= 100 ? 'text-green-400' : 'text-gray-300'
                  }`}>{fmtPct(o.completion_pct)}</td>
                  <td className="px-3 py-2 text-right text-gray-300">{fmtPct(o.quality_pct)}</td>
                  <td className="px-3 py-2 text-right text-gray-300">{fmtInt(o.pieces_per_hour)}</td>
                  <td className="px-3 py-2 text-right text-gray-500">{o.machines}</td>
                  <td className="px-3 py-2 text-right text-gray-500">{o.runs}</td>
                  <td className="px-3 py-2 text-gray-400 text-xs">
                    {t(`jobOrders.status_${o.status}`, { defaultValue: o.status })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
