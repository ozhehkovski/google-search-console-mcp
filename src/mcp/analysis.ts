import {
  buildActionPlan,
  buildCtrCurve,
  countLeaderSwitches,
  detectCannibalization,
  explainInspection,
  explainTrafficChange,
  findDecayingPages,
  findLowCtr,
  findStrikingDistance,
  renderSeoReport,
  sitemapHealth,
  summarizeInspections,
  type ActionItem,
  type ChangeDimension,
  type DeltaRow,
  type IndexingIssueInput,
  type Metrics,
  type PageWeeklySeries,
  type QueryPageRow,
} from "../analysis";
import {InsightsClient, type DateRange} from "../db/insights";
import {getLastDataDate, latestInspections as loadLatestInspections, listAnnotations} from "../db/store";
import {GscApiError} from "../google/errors";
import {listSitemaps, listSites as listGscSites} from "../google/gsc";
import {ToolError, type SiteContext} from "./context";
import {
  addDays,
  dataLagDays,
  resolvePeriods,
  shiftYears,
  type CompareMode,
  type PeriodPreset,
  type ResolvedPeriods,
} from "./periods";

export type PeriodArgs = {
  period?: PeriodPreset;
  compare?: CompareMode;
  start?: string;
  end?: string;
};

/** Common tool result shape */
export type InsightResult = {
  summary: string;
  site: string;
  period?: {start: string; end: string; compareStart?: string; compareEnd?: string};
  dataFreshness?: {lastDataDate: string; lagDays: number};
  items?: unknown[];
  actions?: ActionItem[];
  notes?: string[];
  dashboardUrl: string;
  [extra: string]: unknown;
};

const QUERY_NOTE = "Google Search Console hides anonymized (rare) queries, so query-level results cover only part of the traffic.";
const LAG_NOTE = "Search Console data arrives with a 2–3 day delay; periods end on the last day with data.";

type Prepared = {
  client: InsightsClient;
  lastDataDate: string;
  periods: ResolvedPeriods;
};

async function prepare(site: SiteContext, args: PeriodArgs, defaultPeriod: PeriodPreset): Promise<Prepared> {
  const client = new InsightsClient(site.siteUrl);
  const lastDataDate = await getLastDataDate(site.siteUrl);
  if (!lastDataDate) {
    throw new ToolError("data_not_ready",
      `Search Console data for ${site.displayName} is still being imported. Try again in a few minutes (progress: ${site.dashboardUrl}).`);
  }

  let periods: ResolvedPeriods;
  try {
    const preset = args.start && args.end ? "custom" : args.period ?? defaultPeriod;
    periods = resolvePeriods({
      preset,
      lastDataDate,
      compare: args.compare,
      custom: args.start && args.end ? {start: args.start, end: args.end} : undefined,
    });
  } catch (error) {
    throw new ToolError("invalid_argument", error instanceof Error ? error.message : String(error));
  }
  return {client, lastDataDate, periods};
}

function baseResult(site: SiteContext, prepared: Prepared | null, summary: string): InsightResult {
  return {
    summary,
    site: site.displayName,
    dashboardUrl: site.dashboardUrl,
    ...(prepared ? {
      period: {
        start: prepared.periods.current.start,
        end: prepared.periods.current.end,
        compareStart: prepared.periods.previous.start,
        compareEnd: prepared.periods.previous.end,
      },
      dataFreshness: {lastDataDate: prepared.lastDataDate, lagDays: dataLagDays(prepared.lastDataDate)},
    } : {}),
  };
}

function metricsSummary(metrics: Metrics) {
  return {
    clicks: metrics.clicks,
    impressions: metrics.impressions,
    ctr: metrics.impressions ? Math.round((metrics.clicks / metrics.impressions) * 10000) / 100 : 0,
    position: Math.round(metrics.position * 10) / 10,
  };
}

function formatPercent(current: number, previous: number): string {
  if (previous <= 0) return "n/a";
  const value = ((current - previous) / previous) * 100;
  return `${value > 0 ? "+" : ""}${Math.round(value * 10) / 10}%`;
}

/* ─────────────────────────────── Overview ─────────────────────────────── */

export async function getSiteOverview(site: SiteContext, args: PeriodArgs): Promise<InsightResult> {
  const prepared = await prepare(site, args, "last_28d");
  const {client, periods} = prepared;
  const yearAgo = {start: shiftYears(periods.current.start, -1), end: shiftYears(periods.current.end, -1)};
  const [[current, previous, lastYear], pages] = await Promise.all([
    client.totals([periods.current, periods.previous, yearAgo]),
    client.delta("page", periods.current, periods.previous, {limit: 20}),
  ]);

  const byDelta = pages.map((row) => ({page: row.key, clicksDelta: row.current.clicks - row.previous.clicks, clicks: row.current.clicks}));
  const summary = `${site.displayName}: ${current.clicks} clicks (${formatPercent(current.clicks, previous.clicks)}), ` +
    `${current.impressions} impressions (${formatPercent(current.impressions, previous.impressions)}), ` +
    `avg. position ${Math.round(current.position * 10) / 10} vs ${Math.round(previous.position * 10) / 10}.`;

  return {
    ...baseResult(site, prepared, summary),
    metrics: {
      current: metricsSummary(current),
      previous: metricsSummary(previous),
      yearAgo: lastYear.impressions > 0 ? metricsSummary(lastYear) : null,
    },
    topGrowingPages: byDelta.filter((row) => row.clicksDelta > 0).slice(0, 3),
    topDecliningPages: byDelta.filter((row) => row.clicksDelta < 0).slice(0, 3),
    notes: [LAG_NOTE],
  };
}

/* ──────────────────────────── Traffic change ──────────────────────────── */

async function computeTrafficChange(site: SiteContext, prepared: Prepared) {
  const {client, periods} = prepared;
  const yearAgoCurrent = {start: shiftYears(periods.current.start, -1), end: shiftYears(periods.current.end, -1)};
  const yearAgoPrevious = {start: shiftYears(periods.previous.start, -1), end: shiftYears(periods.previous.end, -1)};
  const dimensions: ChangeDimension[] = ["page", "query", "device", "country", "brand"];

  const [totals, daily, ...deltaRows] = await Promise.all([
    client.totals([periods.current, periods.previous, yearAgoCurrent, yearAgoPrevious]),
    client.daily({start: periods.previous.start, end: periods.current.end}),
    ...dimensions.map((dimension) => client.delta(dimension, periods.current, periods.previous, {
      brandNames: site.brandNames,
      limit: 15,
    })),
  ]);
  const [current, previous, lyCurrent, lyPrevious] = totals;

  const deltas: Partial<Record<ChangeDimension, DeltaRow[]>> = {};
  dimensions.forEach((dimension, index) => {
    // branded split is meaningless without brand terms
    if (dimension === "brand" && site.brandNames.length === 0) return;
    deltas[dimension] = deltaRows[index];
  });

  const annotations = await listAnnotations(site.siteUrl, periods.previous.start, periods.current.end);

  return explainTrafficChange({
    current,
    previous,
    // the daily series only makes sense for adjacent periods, not year-over-year
    daily: periods.previous.end === addDays(periods.current.start, -1) ? daily.map((row) => ({date: row.date, clicks: row.clicks})) : [],
    deltas,
    lastYear: lyPrevious.impressions > 0 ? {current: lyCurrent, previous: lyPrevious} : null,
    annotations: annotations.map((annotation) => ({date: annotation.date, name: annotation.title})),
  });
}

export async function explainTrafficChangeForSite(site: SiteContext, args: PeriodArgs): Promise<InsightResult> {
  const prepared = await prepare(site, args, "last_7d");
  const change = await computeTrafficChange(site, prepared);

  // For a drop, check indexing of the pages that lost the most
  const lostPages = change.drivers.filter((driver) => driver.dimension === "page" && driver.clicksDelta < 0).map((driver) => driver.key);
  const inspections = lostPages.length ? await latestInspections(site.siteUrl, lostPages) : [];
  const notIndexed = inspections.filter((item) => !item.isIndexed);

  const actions: string[] = [];
  if (notIndexed.length) actions.push(`Fix indexing for ${notIndexed.map((item) => item.url).join(", ")} (see get_indexing_issues).`);
  if (change.primaryCause === "rankings") actions.push("Run analyze_page for the top declining pages to see which queries lost positions, then refresh those pages.");
  if (change.primaryCause === "ctr") actions.push("Check SERP features / AI Overviews for the affected queries and improve titles and meta descriptions (find_low_ctr_pages).");
  if (change.primaryCause === "demand") actions.push("Demand dropped: compare with last year (compare=previous_year) and shift focus to growing queries (find_query_changes type=new).");
  if (change.seasonality.likelySeasonal) actions.push("The change looks seasonal; compare with the same period last year before making big changes.");

  return {
    ...baseResult(site, prepared, change.summary + (notIndexed.length ? ` ${notIndexed.length} of the top declining pages are not indexed.` : "")),
    change: {
      direction: change.direction,
      clicks: change.clicks,
      impressionsChangePercent: change.impressionsChangePercent,
      ctrBefore: change.ctrBefore,
      ctrAfter: change.ctrAfter,
      positionBefore: change.positionBefore,
      positionAfter: change.positionAfter,
      primaryCause: change.primaryCause,
      causeBreakdown: change.causeBreakdown,
      changeStartDate: change.changeStartDate,
      seasonality: change.seasonality,
      annotations: change.annotations,
    },
    items: change.drivers,
    indexingOfDecliningPages: inspections,
    recommendedNextSteps: actions,
    notes: [LAG_NOTE, QUERY_NOTE],
  };
}

/* ───────────────────────────── Decaying pages ──────────────────────────── */

async function computeDecaying(site: SiteContext, client: InsightsClient, lastDataDate: string, weeks: number, limit: number) {
  const rows = await client.pageWeekly(lastDataDate, weeks);
  const seriesByPage = new Map<string, PageWeeklySeries>();
  for (const row of rows) {
    const series = seriesByPage.get(row.page) ?? {
      page: row.page,
      weeklyClicks: Array(weeks).fill(0),
      lastYearWeeklyClicks: Array(weeks).fill(0),
    };
    // weekIndex 0 is the latest week; the series goes oldest to newest
    const position = weeks - 1 - row.weekIndex;
    if (position >= 0 && position < weeks) {
      const target = row.lastYear ? series.lastYearWeeklyClicks! : series.weeklyClicks;
      target[position] += row.clicks;
    }
    seriesByPage.set(row.page, series);
  }
  const series = Array.from(seriesByPage.values()).map((item) => ({
    ...item,
    // no data a year ago — can't use it for seasonality
    lastYearWeeklyClicks: item.lastYearWeeklyClicks!.some((value) => value > 0) ? item.lastYearWeeklyClicks : undefined,
  }));
  return findDecayingPages(series, {limit});
}

export async function findDecayingPagesForSite(site: SiteContext, args: {weeks?: number; limit?: number}): Promise<InsightResult> {
  const prepared = await prepare(site, {}, "last_28d");
  const weeks = args.weeks ?? 12;
  const pages = await computeDecaying(site, prepared.client, prepared.lastDataDate, weeks, args.limit ?? 20);
  const real = pages.filter((page) => page.class !== "seasonal");
  const lost = Math.round(real.reduce((sum, page) => sum + page.lostClicksPerWeek, 0));

  return {
    ...baseResult(site, prepared, pages.length
      ? `${real.length} pages are losing clicks (about ${lost} clicks/week in total)` +
        `${pages.length > real.length ? `; ${pages.length - real.length} more drops look seasonal` : ""}. Biggest: ${pages[0].page} (${pages[0].changePercent}%).`
      : "No pages with a significant loss of clicks in the last weeks."),
    period: {start: addDays(prepared.lastDataDate, -(weeks * 7 - 1)), end: prepared.lastDataDate},
    items: pages,
    notes: [
      "Compares the average weekly clicks of the last 4 weeks with the 4 weeks before. sudden_drop = most of the loss happened within a week or two; gradual_decay = steady decline; seasonal = a similar drop happened last year.",
      LAG_NOTE,
    ],
  };
}

/* ─────────────────────── Striking distance / low CTR ─────────────────────── */

async function loadQueryPage(prepared: Prepared, range: DateRange = prepared.periods.current): Promise<QueryPageRow[]> {
  return prepared.client.queryPage(range, {minImpressions: 10, limit: 5000});
}

export async function findStrikingDistanceForSite(
  site: SiteContext,
  args: PeriodArgs & {minPosition?: number; maxPosition?: number; limit?: number},
): Promise<InsightResult> {
  const prepared = await prepare(site, args, "last_28d");
  const rows = await loadQueryPage(prepared);
  const curve = buildCtrCurve(rows);
  const items = findStrikingDistance(rows, curve, {
    minPosition: args.minPosition ?? 4,
    maxPosition: args.maxPosition ?? 15,
    limit: args.limit ?? 20,
  });
  const total = items.reduce((sum, item) => sum + item.potentialExtraClicks, 0);

  return {
    ...baseResult(site, prepared, items.length
      ? `${items.length} queries rank ${args.minPosition ?? 4}–${args.maxPosition ?? 15} with real demand. Reaching the top 3 could add ~${total} clicks per ${prepared.periods.days} days. Best: "${items[0].query}" (#${items[0].position}, +${items[0].potentialExtraClicks}).`
      : "No striking-distance queries with meaningful demand in this period."),
    items,
    ctrCurve: {calibratedPositions: curve.calibratedPositions},
    notes: [
      "potentialExtraClicks = impressions × (expected CTR at position 3 − current CTR); the CTR curve is calibrated on this site's own data where there is enough volume.",
      QUERY_NOTE,
    ],
  };
}

export async function findLowCtrForSite(site: SiteContext, args: PeriodArgs & {limit?: number}): Promise<InsightResult> {
  const prepared = await prepare(site, args, "last_28d");
  const rows = await loadQueryPage(prepared);
  const curve = buildCtrCurve(rows);
  const items = findLowCtr(rows, curve, {limit: args.limit ?? 20});
  const lost = items.reduce((sum, item) => sum + item.lostClicks, 0);

  return {
    ...baseResult(site, prepared, items.length
      ? `${items.length} top-5 rankings get far fewer clicks than expected (~${lost} clicks lost per ${prepared.periods.days} days). Start with "${items[0].query}" on ${items[0].page}.`
      : "Top rankings get the expected share of clicks."),
    items,
    notes: [
      "Low CTR at a high position usually means an unattractive title/description, a mismatch with search intent, or SERP features / AI Overviews answering the query on Google.",
      QUERY_NOTE,
    ],
  };
}

/* ───────────────────────────── Cannibalization ───────────────────────────── */

async function computeCannibalization(prepared: Prepared, limit: number) {
  const rows = await loadQueryPage(prepared);
  const preliminary = detectCannibalization(rows, {limit: Math.max(limit, 30)});
  const leaders = await prepared.client.dailyLeaders(prepared.periods.current, preliminary.map((item) => item.query));
  return detectCannibalization(rows, {limit, leaderSwitches: countLeaderSwitches(leaders)});
}

export async function findCannibalizationForSite(site: SiteContext, args: PeriodArgs & {limit?: number}): Promise<InsightResult> {
  const prepared = await prepare(site, args, "last_28d");
  const items = await computeCannibalization(prepared, args.limit ?? 20);

  return {
    ...baseResult(site, prepared, items.length
      ? `${items.length} queries are split between several pages; ${items.filter((item) => item.severity === "high").length} are high severity. Worst: "${items[0].query}" (${items[0].pages.length} pages${items[0].leaderSwitches ? `, ranking page switched ${items[0].leaderSwitches} times` : ""}).`
      : "No significant keyword cannibalization found."),
    items,
    notes: [
      "leaderSwitches = how many times the page with the most impressions for the query changed day to day (flip-flopping).",
      "consolidate = merge content into the winner and 301-redirect; differentiate = give pages distinct intents; canonical = point duplicates to the winner.",
      QUERY_NOTE,
    ],
  };
}

/* ───────────────────────────── Query changes ───────────────────────────── */

export async function findQueryChangesForSite(
  site: SiteContext,
  args: PeriodArgs & {type: "new" | "lost"; limit?: number},
): Promise<InsightResult> {
  const prepared = await prepare(site, args, "last_28d");
  const rows = await prepared.client.delta("query", prepared.periods.current, prepared.periods.previous, {limit: 200});
  const limit = args.limit ?? 20;
  const items = (args.type === "new"
    ? rows.filter((row) => row.previous.impressions === 0 && row.current.impressions > 0)
      .sort((a, b) => b.current.impressions - a.current.impressions)
    : rows.filter((row) => row.previous.clicks > 0 && row.current.clicks <= row.previous.clicks * 0.2)
      .sort((a, b) => b.previous.clicks - a.previous.clicks))
    .slice(0, limit)
    .map((row) => ({query: row.key, current: metricsSummary(row.current), previous: metricsSummary(row.previous)}));

  return {
    ...baseResult(site, prepared, items.length
      ? args.type === "new"
        ? `${items.length} new queries started bringing impressions, e.g. "${items[0].query}" (${items[0].current.impressions} impressions).`
        : `${items.length} queries lost at least 80% of their clicks, e.g. "${items[0].query}" (${items[0].previous.clicks} → ${items[0].current.clicks}).`
      : `No ${args.type} queries found for this period.`),
    items,
    notes: [QUERY_NOTE],
  };
}

/* ───────────────────────────── Indexing ───────────────────────────── */

type LatestInspection = {
  url: string;
  issueKey: string;
  severity: string;
  isIndexed: boolean;
  coverageState: string | null;
  canonicalMismatch: boolean;
  lastCrawlTime: string | null;
  inspectedAt: string;
  clicks28d: number | null;
  inspectionLink: string | null;
};

async function latestInspections(site: string, urls?: string[]): Promise<LatestInspection[]> {
  const rows = await loadLatestInspections(site, urls);
  return rows.map((row) => {
    const explanation = explainInspection(row);
    return {
      url: row.url,
      issueKey: explanation.key,
      severity: explanation.severity,
      isIndexed: explanation.isIndexed,
      coverageState: row.coverageState,
      canonicalMismatch: explanation.canonicalMismatch,
      lastCrawlTime: row.lastCrawlTime,
      inspectedAt: row.inspectedAt,
      clicks28d: row.clicks28d,
      inspectionLink: row.inspectionLink,
    };
  }).sort((a, b) => (b.clicks28d ?? 0) - (a.clicks28d ?? 0));
}

export async function getIndexingIssuesForSite(site: SiteContext, args: {limit?: number}): Promise<InsightResult> {
  const inspections = await latestInspections(site.siteUrl);
  const summary = summarizeInspections(inspections.map((item) => ({
    key: item.issueKey as never,
    severity: item.severity as never,
    isIndexed: item.isIndexed,
    canonicalMismatch: item.canonicalMismatch,
  })));
  const order: Record<string, number> = {critical: 0, warning: 1, info: 2, ok: 3};
  const issues = inspections
    .filter((item) => item.severity !== "ok")
    .sort((a, b) => order[a.severity] - order[b.severity] || (b.clicks28d ?? 0) - (a.clicks28d ?? 0))
    .slice(0, args.limit ?? 30);

  return {
    ...baseResult(site, null, inspections.length
      ? `${summary.indexed} of ${summary.total} checked pages are indexed; ${summary.critical} pages that had clicks are not indexed, ${summary.warnings} more need attention.`
      : "No pages have been checked yet. Indexing checks run after the data import (INSPECTION_DAILY_LIMIT > 0)."),
    items: issues,
    totals: summary,
    notes: [
      "The most important pages are checked on every sync with Google's URL Inspection API (INSPECTION_DAILY_LIMIT per site, Google allows up to 2000/day).",
      "issueKey explains the status: crawled_not_indexed = thin/duplicate content, discovered_not_indexed = low crawl priority, noindex / blocked_by_robots = blocked by the site, canonical_mismatch = Google prefers another URL.",
    ],
  };
}

/* ───────────────────────────── Sitemaps ───────────────────────────── */

export async function getSitemapStatusForSite(site: SiteContext): Promise<InsightResult> {
  try {
    const [sitemaps, sites] = await Promise.all([listSitemaps(site.siteUrl), listGscSites()]);
    const permission = sites.find((item) => item.siteUrl === site.siteUrl)?.permissionLevel ?? "unknown";
    const issues = sitemapHealth(sitemaps);

    return {
      ...baseResult(site, null, sitemaps.length
        ? `${sitemaps.length} sitemaps, ${sitemaps.reduce((sum, item) => sum + item.submittedUrls, 0)} URLs submitted; ${issues.length ? `${issues.length} issues found` : "no issues"}.`
        : "No sitemap is submitted in Search Console for this site."),
      items: sitemaps,
      issues,
      permissionLevel: permission,
      notes: ["Resubmitting a sitemap asks Google to re-read it; it doesn't guarantee indexing."],
    };
  } catch (error) {
    if (error instanceof GscApiError) {
      throw new ToolError("google_error", `Search Console returned an error for ${site.displayName}: ${error.code}.`);
    }
    throw error;
  }
}

/* ───────────────────────────── Page analysis ───────────────────────────── */

export async function analyzePageForSite(site: SiteContext, args: PeriodArgs & {url: string}): Promise<InsightResult> {
  const prepared = await prepare(site, args, "last_28d");
  const {client, periods} = prepared;
  const [totals, queries, queryDeltas, inspections] = await Promise.all([
    client.totals([periods.current, periods.previous]),
    client.queryPage(periods.current, {page: args.url, minImpressions: 1, limit: 50}),
    client.delta("query", periods.current, periods.previous, {page: args.url, limit: 20}),
    latestInspections(site.siteUrl, [args.url]),
  ]);
  // site totals are only needed for the page's share of clicks
  const pageDaily = await client.daily({start: periods.previous.start, end: periods.current.end}, args.url);
  const sumMetrics = (rows: typeof pageDaily, range: DateRange): Metrics => {
    const selected = rows.filter((row) => row.date >= range.start && row.date <= range.end);
    const clicks = selected.reduce((sum, row) => sum + row.clicks, 0);
    const impressions = selected.reduce((sum, row) => sum + row.impressions, 0);
    const weighted = selected.reduce((sum, row) => sum + row.position * row.impressions, 0);
    return {clicks, impressions, position: impressions ? weighted / impressions : 0};
  };
  const current = sumMetrics(pageDaily, periods.current);
  const previous = sumMetrics(pageDaily, periods.previous);

  if (current.impressions === 0 && previous.impressions === 0) {
    throw new ToolError("invalid_argument", `No Search Console data for ${args.url} in this period. Pass the full page URL as it appears in Search Console.`);
  }

  const siteRows = await loadQueryPage(prepared);
  const pageQueries = new Set(queries.map((row) => row.query));
  const competing = detectCannibalization(siteRows.filter((row) => pageQueries.has(row.query)), {minQueryImpressions: 20, limit: 10})
    .filter((item) => item.pages.some((page) => page.page === args.url));
  const curve = buildCtrCurve(siteRows);
  const striking = findStrikingDistance(queries, curve, {minImpressions: 20, limit: 5});
  const lost = queryDeltas.filter((row) => row.current.clicks < row.previous.clicks)
    .map((row) => ({query: row.key, clicksBefore: row.previous.clicks, clicksAfter: row.current.clicks,
      positionBefore: Math.round(row.previous.position * 10) / 10, positionAfter: Math.round(row.current.position * 10) / 10}))
    .slice(0, 10);
  const share = totals[0].clicks ? Math.round((current.clicks / totals[0].clicks) * 1000) / 10 : 0;
  const indexing = inspections[0] ?? null;

  return {
    ...baseResult(site, prepared, `${args.url}: ${current.clicks} clicks (${formatPercent(current.clicks, previous.clicks)}), avg. position ${Math.round(current.position * 10) / 10}` +
      ` vs ${Math.round(previous.position * 10) / 10}, ${share}% of site clicks.` +
      (lost.length ? ` Biggest loss: "${lost[0].query}" (${lost[0].clicksBefore} → ${lost[0].clicksAfter}).` : "") +
      (competing.length ? ` Competes with other pages on ${competing.length} queries.` : "") +
      (indexing && !indexing.isIndexed ? ` Not indexed: ${indexing.issueKey}.` : "")),
    metrics: {current: metricsSummary(current), previous: metricsSummary(previous), shareOfSiteClicks: share},
    topQueries: queries.slice(0, 15).map((row) => ({query: row.query, ...metricsSummary(row)})),
    lostQueries: lost,
    strikingDistanceQueries: striking,
    cannibalization: competing,
    indexing,
    notes: [QUERY_NOTE],
  };
}

/* ─────────────────────────── Action plan & report ─────────────────────────── */

async function computeActionPlan(site: SiteContext, prepared: Prepared, capacity: number): Promise<ActionItem[]> {
  const rows = await loadQueryPage(prepared);
  const curve = buildCtrCurve(rows);
  const [decaying, cannibalization, inspections] = await Promise.all([
    computeDecaying(site, prepared.client, prepared.lastDataDate, 12, 20),
    computeCannibalization(prepared, 10),
    latestInspections(site.siteUrl),
  ]);
  const indexingIssues: IndexingIssueInput[] = inspections
    .filter((item) => item.severity === "critical")
    .map((item) => ({url: item.url, issueKey: item.issueKey as IndexingIssueInput["issueKey"], clicks28d: item.clicks28d}));

  return buildActionPlan({
    siteKey: site.siteUrl,
    periodDays: prepared.periods.days,
    decaying,
    strikingDistance: findStrikingDistance(rows, curve, {limit: 20}),
    lowCtr: findLowCtr(rows, curve, {limit: 20}),
    cannibalization,
    indexingIssues,
  }, capacity);
}

export async function getWeeklyActionPlanForSite(site: SiteContext, args: {capacity?: number}): Promise<InsightResult> {
  const prepared = await prepare(site, {period: "last_28d"}, "last_28d");
  const actions = await computeActionPlan(site, prepared, args.capacity ?? 5);
  const total = actions.reduce((sum, action) => sum + action.expectedWeeklyClicks, 0);

  return {
    ...baseResult(site, prepared, actions.length
      ? `${actions.length} highest-impact tasks for this week, worth ~${total} clicks/week in total. #1: ${actions[0].title}.`
      : "No high-impact tasks found — the site has no significant losses or quick wins right now."),
    actions,
    notes: [
      "expectedWeeklyClicks is an estimate based on Search Console data: clicks to recover (indexing, decay, cannibalization) or to gain (top-3, snippet CTR).",
      "Each page appears once with its most valuable task.",
    ],
  };
}

export async function generateSeoReportForSite(
  site: SiteContext,
  args: PeriodArgs & {audience?: "owner" | "seo"},
): Promise<InsightResult> {
  const prepared = await prepare(site, args, "last_7d");
  const {client, periods} = prepared;
  const yearAgo = {start: shiftYears(periods.current.start, -1), end: shiftYears(periods.current.end, -1)};
  const [change, [current, previous, lastYear], pages, actions, inspections] = await Promise.all([
    computeTrafficChange(site, prepared),
    client.totals([periods.current, periods.previous, yearAgo]),
    client.delta("page", periods.current, periods.previous, {limit: 30}),
    computeActionPlan(site, prepared, 5),
    latestInspections(site.siteUrl),
  ]);
  const indexingSummary = inspections.length ? summarizeInspections(inspections.map((item) => ({
    key: item.issueKey as never, severity: item.severity as never, isIndexed: item.isIndexed, canonicalMismatch: item.canonicalMismatch,
  }))) : null;

  const movers = pages.map((row) => ({key: row.key, clicksDelta: row.current.clicks - row.previous.clicks}));
  const markdown = renderSeoReport({
    siteUrl: site.displayName,
    period: periods.current,
    previousPeriod: periods.previous,
    current,
    previous,
    lastYear: lastYear.impressions > 0 ? lastYear : null,
    change,
    winners: movers.filter((item) => item.clicksDelta > 0).sort((a, b) => b.clicksDelta - a.clicksDelta).slice(0, 5),
    losers: movers.filter((item) => item.clicksDelta < 0).sort((a, b) => a.clicksDelta - b.clicksDelta).slice(0, 5),
    indexing: indexingSummary,
    actions,
    audience: args.audience ?? "owner",
  });

  return {
    ...baseResult(site, prepared, change.summary),
    markdown,
    actions,
    notes: [LAG_NOTE],
  };
}

export function periodDescription(periods: ResolvedPeriods): string {
  return `${periods.current.start}…${periods.current.end} vs ${periods.previous.start}…${periods.previous.end}`;
}
