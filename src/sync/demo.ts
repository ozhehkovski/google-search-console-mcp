/**
 * Demo data: a synthetic site with 16 months of realistic Search Console rows, so the MCP tools
 * can be tried (and developed) without a Google key. Contains a ranking drop, a slowly decaying page,
 * striking-distance queries, a low-CTR snippet, cannibalization and seasonality.
 */
import {insert} from "../db/clickhouse";
import {deleteDay, markDayLoaded, saveInspection, saveSites} from "../db/store";
import {expectedCtr, defaultCtrCurve} from "../analysis";
import {addDays, daysBetween, toIsoDate} from "../mcp/periods";
import type {SearchAnalyticsRow} from "../google/gsc";
import {buildDayFacts} from "./day-facts";

export const DEMO_SITE = "sc-domain:demo-store.example";
const ORIGIN = "https://demo-store.example";

type Series = {
  query: string;
  page: string;
  impressions: number;
  position: number;
  // position and impressions as a function of "days ago"
  positionAt?: (daysAgo: number) => number;
  impressionsAt?: (daysAgo: number) => number;
  ctrFactor?: number;
  startsDaysAgo?: number;
};

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const page = (slug: string) => `${ORIGIN}/${slug}`;

function demoSeries(): Series[] {
  return [
    {query: "demo store", page: page(""), impressions: 900, position: 1.1},
    {query: "demo store coupon", page: page(""), impressions: 200, position: 1.4},
    // Ranking drop 9 days ago
    {query: "running shoes", page: page("running-shoes"), impressions: 1500, position: 3,
      positionAt: (daysAgo) => daysAgo < 9 ? 8.5 : 3},
    {query: "best running shoes", page: page("running-shoes"), impressions: 800, position: 4,
      positionAt: (daysAgo) => daysAgo < 9 ? 10 : 4},
    // Gradual decay over ~10 weeks
    {query: "winter jackets", page: page("winter-jackets"), impressions: 1200, position: 2.5,
      positionAt: (daysAgo) => daysAgo < 70 ? 2.5 + (70 - daysAgo) / 12 : 2.5},
    {query: "waterproof winter jacket", page: page("winter-jackets"), impressions: 500, position: 3,
      positionAt: (daysAgo) => daysAgo < 70 ? 3 + (70 - daysAgo) / 14 : 3},
    // Striking distance
    {query: "hiking boots", page: page("hiking-boots"), impressions: 2200, position: 6.5},
    {query: "lightweight hiking boots", page: page("hiking-boots"), impressions: 700, position: 8},
    {query: "trail running shoes women", page: page("trail-shoes"), impressions: 1100, position: 11},
    {query: "merino socks", page: page("merino-socks"), impressions: 900, position: 5.5},
    // Top position with a poor snippet
    {query: "running socks", page: page("running-socks"), impressions: 1600, position: 2, ctrFactor: 0.25},
    // Cannibalization: two pages alternate for the same queries
    {query: "trail shoes", page: page("trail-shoes"), impressions: 700, position: 6,
      impressionsAt: (daysAgo) => daysAgo % 3 === 0 ? 700 : 300},
    {query: "trail shoes", page: page("running-shoes"), impressions: 600, position: 7,
      impressionsAt: (daysAgo) => daysAgo % 3 === 0 ? 250 : 650},
    {query: "trail running shoes", page: page("trail-shoes"), impressions: 500, position: 5},
    {query: "trail running shoes", page: page("blog/trail-running-guide"), impressions: 450, position: 6},
    // Blog content
    {query: "how to choose running shoes", page: page("blog/choose-running-shoes"), impressions: 1300, position: 4.5},
    {query: "running shoe size guide", page: page("blog/choose-running-shoes"), impressions: 400, position: 3.5},
    {query: "trail running tips", page: page("blog/trail-running-guide"), impressions: 600, position: 7},
    // New queries in the last 3 weeks
    {query: "carbon plate running shoes", page: page("running-shoes"), impressions: 500, position: 9, startsDaysAgo: 20},
    {query: "vegan hiking boots", page: page("hiking-boots"), impressions: 300, position: 12, startsDaysAgo: 15},
  ];
}

const SPLITS: Array<{country: string; device: string; share: number}> = [
  {country: "usa", device: "MOBILE", share: 0.45},
  {country: "usa", device: "DESKTOP", share: 0.25},
  {country: "gbr", device: "MOBILE", share: 0.18},
  {country: "deu", device: "DESKTOP", share: 0.12},
];

export function demoDayRows(date: string, today: string): {totals: SearchAnalyticsRow[]; detailed: SearchAnalyticsRow[]} {
  const daysAgo = daysBetween(date, today) - 1;
  const next = random(daysAgo + 7);
  const dayOfYear = daysBetween(`${date.slice(0, 4)}-01-01`, date);
  // Outdoor store: stronger in autumn and winter
  const season = 1 + 0.25 * Math.cos(((dayOfYear - 330) / 365) * 2 * Math.PI);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const weekly = weekday === 0 || weekday === 6 ? 0.85 : 1.05;
  const curve = defaultCtrCurve();

  const detailed: SearchAnalyticsRow[] = [];
  const totals = new Map<string, SearchAnalyticsRow>();
  for (const series of demoSeries()) {
    if (series.startsDaysAgo !== undefined && daysAgo > series.startsDaysAgo) continue;
    const baseImpressions = (series.impressionsAt?.(daysAgo) ?? series.impressions) / 30;
    const position = Math.max(1, (series.positionAt?.(daysAgo) ?? series.position) + (next() - 0.5) * 0.6);
    for (const split of SPLITS) {
      const impressions = Math.round(baseImpressions * season * weekly * split.share * (0.85 + next() * 0.3));
      if (impressions <= 0) continue;
      const clicks = Math.round(impressions * expectedCtr(curve, position) * (series.ctrFactor ?? 1) * (0.8 + next() * 0.4));
      detailed.push({keys: [series.query, series.page, split.country, split.device], clicks, impressions, position});
      const key = `${split.country}|${split.device}`;
      const total = totals.get(key) ?? {keys: [split.country, split.device], clicks: 0, impressions: 0, position: 0};
      total.position = (total.position * total.impressions + position * impressions) / (total.impressions + impressions);
      total.clicks += clicks;
      total.impressions += impressions;
      totals.set(key, total);
    }
  }
  // Anonymized long-tail queries: ~15% extra on top of the detailed rows
  for (const total of totals.values()) {
    total.clicks = Math.round(total.clicks * 1.15);
    total.impressions = Math.round(total.impressions * 1.15);
  }
  return {totals: Array.from(totals.values()), detailed};
}

export async function loadDemoData(options: {months?: number} = {}): Promise<number> {
  const today = toIsoDate(new Date());
  const end = addDays(today, -3);
  const start = addDays(end, -Math.round((options.months ?? 16) * 30.4));
  await saveSites([{siteUrl: DEMO_SITE, permissionLevel: "siteOwner"}]);

  let rows = 0;
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const {totals, detailed} = demoDayRows(day, today);
    const {facts, keywords} = buildDayFacts({site: DEMO_SITE, date: day, totals, detailed});
    await deleteDay(DEMO_SITE, day);
    await insert("dim_keyword", Array.from(keywords, ([kwId, query]) => ({site: DEMO_SITE, kw_id: kwId, query})));
    await insert("gsc_raw", facts);
    await markDayLoaded(DEMO_SITE, day, facts.length);
    rows += facts.length;
  }

  await saveInspection(DEMO_SITE, {
    url: page("winter-jackets"), verdict: "NEUTRAL", coverageState: "Crawled - currently not indexed",
    indexingState: "INDEXING_ALLOWED", robotsTxtState: "ALLOWED", pageFetchState: "SUCCESSFUL",
    googleCanonical: null, userCanonical: page("winter-jackets"), lastCrawlTime: new Date(), inspectionLink: null,
  }, 120);
  await saveInspection(DEMO_SITE, {
    url: page("hiking-boots"), verdict: "PASS", coverageState: "Submitted and indexed",
    indexingState: "INDEXING_ALLOWED", robotsTxtState: "ALLOWED", pageFetchState: "SUCCESSFUL",
    googleCanonical: page("hiking-boots"), userCanonical: page("hiking-boots"), lastCrawlTime: new Date(), inspectionLink: null,
  }, 300);
  return rows;
}
