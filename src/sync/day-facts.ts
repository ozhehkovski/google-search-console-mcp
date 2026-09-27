import {createHash} from "node:crypto";
import type {SearchAnalyticsRow} from "../google/gsc";

export const ANONYMOUS_QUERY = "(anonymous)";
export const ANONYMOUS_PAGE = "(unknown)";

export type FactRow = {
  site: string;
  gsc_date: string;
  kw_id: number;
  page: string;
  country: string;
  device: string;
  clicks: number;
  impressions: number;
  position: number;
};

/** Stable 52-bit id of a query (fits a JS number and a ClickHouse UInt64). */
export function keywordId(query: string): number {
  return parseInt(createHash("sha256").update(query).digest("hex").slice(0, 13), 16);
}

type Bucket = {country: string; device: string; clicks: number; impressions: number; positionWeight: number};

/**
 * Builds the rows stored for one day.
 *
 * Search Console drops anonymized queries from query-level reports, so the detailed rows
 * (query × page × country × device) add up to less than the site totals. The totals by
 * country × device are fetched separately and whatever the detailed rows don't cover is stored
 * as an "(anonymous)" row — site-level clicks and impressions then match Search Console exactly.
 */
export function buildDayFacts(options: {
  site: string;
  date: string;
  totals: SearchAnalyticsRow[];
  detailed: SearchAnalyticsRow[];
}): {facts: FactRow[]; keywords: Map<number, string>} {
  const {site, date} = options;
  const buckets = new Map<string, Bucket>();
  const bucketKey = (country: string, device: string) => `${country}|${device}`;

  for (const row of options.totals) {
    const [country = "", device = ""] = row.keys;
    const key = bucketKey(country, device);
    const bucket = buckets.get(key) ?? {country, device, clicks: 0, impressions: 0, positionWeight: 0};
    bucket.clicks += row.clicks;
    bucket.impressions += row.impressions;
    bucket.positionWeight += row.position * row.impressions;
    buckets.set(key, bucket);
  }

  const facts: FactRow[] = [];
  const keywords = new Map<number, string>();

  for (const row of options.detailed) {
    const [query = ANONYMOUS_QUERY, page = ANONYMOUS_PAGE, country = "", device = ""] = row.keys;
    const kwId = keywordId(query);
    keywords.set(kwId, query);
    facts.push({
      site, gsc_date: date, kw_id: kwId, page, country, device,
      clicks: row.clicks, impressions: row.impressions, position: row.position,
    });

    const bucket = buckets.get(bucketKey(country, device));
    if (bucket) {
      bucket.clicks -= row.clicks;
      bucket.impressions -= row.impressions;
      bucket.positionWeight -= row.position * row.impressions;
    }
  }

  const anonymousId = keywordId(ANONYMOUS_QUERY);
  for (const bucket of buckets.values()) {
    const clicks = Math.max(0, Math.round(bucket.clicks));
    const impressions = Math.max(0, Math.round(bucket.impressions));
    if (clicks === 0 && impressions === 0) continue;
    keywords.set(anonymousId, ANONYMOUS_QUERY);
    facts.push({
      site, gsc_date: date, kw_id: anonymousId, page: ANONYMOUS_PAGE,
      country: bucket.country, device: bucket.device, clicks, impressions,
      position: impressions > 0 ? Math.max(1, bucket.positionWeight / impressions) : 0,
    });
  }

  return {facts, keywords};
}
