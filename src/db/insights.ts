/**
 * Aggregations behind the MCP tools. All queries are parameterized; the site is always bound
 * as a parameter and never concatenated into SQL.
 */
import type {DeltaRow, Metrics, QueryPageRow} from "../analysis";
import {ANONYMOUS_PAGE, ANONYMOUS_QUERY} from "../sync/day-facts";
import {query, toNumber, type Row} from "./clickhouse";

export type DateRange = {start: string; end: string};
export type DeltaDimension = "page" | "query" | "device" | "country" | "brand";
export type PageWeeklyRow = {page: string; lastYear: boolean; weekIndex: number; clicks: number};

const WEIGHTED_POSITION = (condition = "1") =>
  `sumIf(g.position * g.impressions, ${condition}) / nullIf(sumIf(g.impressions, ${condition}), 0)`;
const KEYWORDS_JOIN = `
  ANY LEFT JOIN (SELECT kw_id, query FROM dim_keyword WHERE site = {site:String}) AS k
    ON g.kw_id = k.kw_id`;

function metrics(row: Row, prefix = ""): Metrics {
  return {
    clicks: toNumber(row[`${prefix}clicks`]),
    impressions: toNumber(row[`${prefix}impressions`]),
    position: toNumber(row[`${prefix}position`]),
  };
}

export class InsightsClient {
  constructor(private readonly site: string) {}

  /** Daily clicks / impressions / position, optionally for one page. */
  async daily(range: DateRange, page?: string): Promise<Array<Metrics & {date: string}>> {
    const rows = await query(`
      SELECT toString(g.gsc_date) AS date,
             sum(g.clicks) AS clicks,
             sum(g.impressions) AS impressions,
             ${WEIGHTED_POSITION()} AS position
      FROM gsc_raw AS g
      WHERE g.site = {site:String}
        AND g.gsc_date BETWEEN {start:Date} AND {end:Date}
        ${page ? "AND g.page = {page:String}" : ""}
      GROUP BY g.gsc_date
      ORDER BY g.gsc_date
    `, {site: this.site, start: range.start, end: range.end, page: page ?? ""});
    return rows.map((row) => ({date: String(row.date), ...metrics(row)}));
  }

  /** Totals for several (possibly non-adjacent) periods in one query. */
  async totals(periods: DateRange[]): Promise<Metrics[]> {
    const params: Record<string, unknown> = {site: this.site};
    const selects = periods.map((period, index) => {
      params[`s${index}`] = period.start;
      params[`e${index}`] = period.end;
      const condition = `g.gsc_date BETWEEN {s${index}:Date} AND {e${index}:Date}`;
      return `sumIf(g.clicks, ${condition}) AS p${index}_clicks,
              sumIf(g.impressions, ${condition}) AS p${index}_impressions,
              ${WEIGHTED_POSITION(condition)} AS p${index}_position`;
    });
    params.minStart = periods.map((period) => period.start).sort()[0];
    params.maxEnd = periods.map((period) => period.end).sort().reverse()[0];

    const [row] = await query(`
      SELECT ${selects.join(",\n")}
      FROM gsc_raw AS g
      WHERE g.site = {site:String}
        AND g.gsc_date BETWEEN {minStart:Date} AND {maxEnd:Date}
    `, params);
    return periods.map((_, index) => metrics(row ?? {}, `p${index}_`));
  }

  /** Metric change by dimension between two periods, top by |Δclicks|. */
  async delta(
    dimension: DeltaDimension,
    current: DateRange,
    previous: DateRange,
    options: {brandNames?: string[]; page?: string; limit?: number} = {},
  ): Promise<DeltaRow[]> {
    const keyExpression = {
      page: "g.page",
      query: "k.query",
      device: "g.device",
      country: "g.country",
      brand: "if(multiSearchAnyCaseInsensitive(k.query, {brands:Array(String)}), 'branded', 'non_branded')",
    }[dimension];
    const needsKeywords = dimension === "query" || dimension === "brand";
    const exclude = dimension === "page"
      ? "AND g.page != {anonPage:String}"
      : dimension === "query" ? "AND k.query != {anonQuery:String} AND k.query != ''" : "";
    const cur = "g.gsc_date BETWEEN {cs:Date} AND {ce:Date}";
    const prev = "g.gsc_date BETWEEN {ps:Date} AND {pe:Date}";

    const rows = await query(`
      SELECT ${keyExpression} AS key,
             sumIf(g.clicks, ${cur}) AS cur_clicks,
             sumIf(g.impressions, ${cur}) AS cur_impressions,
             ${WEIGHTED_POSITION(cur)} AS cur_position,
             sumIf(g.clicks, ${prev}) AS prev_clicks,
             sumIf(g.impressions, ${prev}) AS prev_impressions,
             ${WEIGHTED_POSITION(prev)} AS prev_position
      FROM gsc_raw AS g
      ${needsKeywords ? KEYWORDS_JOIN : ""}
      WHERE g.site = {site:String}
        AND (${cur} OR ${prev})
        ${exclude}
        ${options.page ? "AND g.page = {page:String}" : ""}
      GROUP BY key
      ORDER BY abs(toInt64(cur_clicks) - toInt64(prev_clicks)) DESC
      LIMIT {limit:UInt32}
    `, {
      site: this.site,
      cs: current.start, ce: current.end, ps: previous.start, pe: previous.end,
      brands: (options.brandNames ?? []).filter(Boolean),
      anonPage: ANONYMOUS_PAGE,
      anonQuery: ANONYMOUS_QUERY,
      page: options.page ?? "",
      limit: options.limit ?? 20,
    });
    return rows.map((row) => ({key: String(row.key), current: metrics(row, "cur_"), previous: metrics(row, "prev_")}));
  }

  /** Weekly clicks per top page (weekIndex 0 = latest week), plus the same weeks a year ago. */
  async pageWeekly(end: string, weeks: number, maxPages = 300): Promise<PageWeeklyRow[]> {
    const rows = await query(`
      WITH
        toDate({end:Date}) AS end_date,
        end_date - {days:UInt32} + 1 AS start_date,
        (
          SELECT groupArray(page) FROM (
            SELECT page FROM gsc_raw
            WHERE site = {site:String} AND gsc_date BETWEEN start_date AND end_date AND page != {anonPage:String}
            GROUP BY page ORDER BY sum(clicks) DESC LIMIT {maxPages:UInt32}
          )
        ) AS top_pages
      SELECT g.page AS page,
             if(g.gsc_date >= start_date, 0, 1) AS last_year,
             intDiv(dateDiff('day', g.gsc_date, if(g.gsc_date >= start_date, end_date, end_date - toIntervalYear(1))), 7) AS week_index,
             sum(g.clicks) AS clicks
      FROM gsc_raw AS g
      WHERE g.site = {site:String}
        AND has(top_pages, g.page)
        AND (
          g.gsc_date BETWEEN start_date AND end_date
          OR g.gsc_date BETWEEN start_date - toIntervalYear(1) AND end_date - toIntervalYear(1)
        )
      GROUP BY page, last_year, week_index
    `, {site: this.site, end, days: weeks * 7, maxPages, anonPage: ANONYMOUS_PAGE});
    return rows.map((row) => ({
      page: String(row.page),
      lastYear: toNumber(row.last_year) === 1,
      weekIndex: toNumber(row.week_index),
      clicks: toNumber(row.clicks),
    }));
  }

  /** Query × page rows for a period: the base for striking distance, cannibalization and CTR analysis. */
  async queryPage(range: DateRange, options: {page?: string; minImpressions?: number; limit?: number} = {}): Promise<QueryPageRow[]> {
    const rows = await query(`
      SELECT k.query AS query,
             g.page AS page,
             sum(g.clicks) AS clicks,
             sum(g.impressions) AS impressions,
             ${WEIGHTED_POSITION()} AS position
      FROM gsc_raw AS g
      ${KEYWORDS_JOIN}
      WHERE g.site = {site:String}
        AND g.gsc_date BETWEEN {start:Date} AND {end:Date}
        AND g.page != {anonPage:String}
        AND k.query != {anonQuery:String} AND k.query != ''
        ${options.page ? "AND g.page = {page:String}" : ""}
      GROUP BY query, page
      HAVING impressions >= {minImpressions:UInt32}
      ORDER BY impressions DESC
      LIMIT {limit:UInt32}
    `, {
      site: this.site,
      start: range.start,
      end: range.end,
      page: options.page ?? "",
      minImpressions: options.minImpressions ?? 10,
      limit: options.limit ?? 5000,
      anonPage: ANONYMOUS_PAGE,
      anonQuery: ANONYMOUS_QUERY,
    });
    return rows.map((row) => ({query: String(row.query), page: String(row.page), ...metrics(row)}));
  }

  /** Daily leading page (most impressions) per query — used to detect cannibalization flip-flops. */
  async dailyLeaders(range: DateRange, queries: string[]): Promise<Array<{query: string; date: string; page: string}>> {
    if (queries.length === 0) return [];
    const rows = await query(`
      SELECT query, toString(gsc_date) AS date, argMax(page, impressions) AS page
      FROM (
        SELECT k.query AS query, g.gsc_date AS gsc_date, g.page AS page, sum(g.impressions) AS impressions
        FROM gsc_raw AS g
        ${KEYWORDS_JOIN}
        WHERE g.site = {site:String}
          AND g.gsc_date BETWEEN {start:Date} AND {end:Date}
          AND k.query IN {queries:Array(String)}
        GROUP BY query, gsc_date, page
      )
      GROUP BY query, gsc_date
    `, {site: this.site, start: range.start, end: range.end, queries: queries.slice(0, 50)});
    return rows.map((row) => ({query: String(row.query), date: String(row.date), page: String(row.page)}));
  }

  /** Pages with most clicks, and pages whose impressions halved week over week — URL Inspection candidates. */
  async indexingCandidates(lastDate: string, topLimit: number): Promise<{
    topPages: Array<{url: string; clicks28d: number}>;
    droppingPages: Array<{url: string; clicks28d: number}>;
  }> {
    const top = await query(`
      SELECT page AS url, sum(clicks) AS clicks, sum(impressions) AS impressions
      FROM gsc_raw
      WHERE site = {site:String}
        AND gsc_date BETWEEN toDate({to:Date}) - 27 AND {to:Date}
        AND page != {anon:String}
      GROUP BY page
      ORDER BY clicks DESC, impressions DESC
      LIMIT {limit:UInt32}
    `, {site: this.site, to: lastDate, anon: ANONYMOUS_PAGE, limit: topLimit});

    const dropping = await query(`
      SELECT page AS url,
             sumIf(clicks, gsc_date >= toDate({to:Date}) - 27) AS clicks,
             sumIf(impressions, gsc_date BETWEEN toDate({to:Date}) - 13 AND toDate({to:Date}) - 7) AS prev_impr,
             sumIf(impressions, gsc_date >= toDate({to:Date}) - 6) AS recent_impr
      FROM gsc_raw
      WHERE site = {site:String}
        AND gsc_date BETWEEN toDate({to:Date}) - 27 AND {to:Date}
        AND page != {anon:String}
      GROUP BY page
      HAVING prev_impr >= 50 AND recent_impr < prev_impr * 0.5
      ORDER BY prev_impr DESC
      LIMIT 50
    `, {site: this.site, to: lastDate, anon: ANONYMOUS_PAGE});

    const toCandidate = (row: Row) => ({url: String(row.url), clicks28d: toNumber(row.clicks)});
    return {topPages: top.map(toCandidate), droppingPages: dropping.map(toCandidate)};
  }
}
