import {randomUUID} from "node:crypto";
import type {Inspection} from "../google/gsc";
import {command, insert, query, toNumber} from "./clickhouse";

/* ─────────────────────────────── Sites ─────────────────────────────── */

export type StoredSite = {siteUrl: string; permissionLevel: string};

export async function saveSites(sites: StoredSite[]): Promise<void> {
  await insert("sites", sites.map((site) => ({site_url: site.siteUrl, permission_level: site.permissionLevel})));
}

export async function listStoredSites(): Promise<StoredSite[]> {
  const rows = await query<{site_url: string; permission_level: string}>(
    "SELECT site_url, argMax(permission_level, updated_at) AS permission_level FROM sites GROUP BY site_url ORDER BY site_url",
  );
  return rows.map((row) => ({siteUrl: row.site_url, permissionLevel: row.permission_level}));
}

export async function getBrandNames(site: string): Promise<string[] | null> {
  const rows = await query<{brand_names: string[]}>(
    "SELECT argMax(brand_names, updated_at) AS brand_names FROM site_settings WHERE site = {site:String} GROUP BY site",
    {site},
  );
  return rows[0]?.brand_names ?? null;
}

export async function setBrandNames(site: string, brandNames: string[]): Promise<void> {
  await insert("site_settings", [{site, brand_names: brandNames}]);
}

/* ─────────────────────────────── Load log ─────────────────────────────── */

export type SiteDataStatus = {
  daysLoaded: number;
  firstDate: string | null;
  lastDate: string | null;
  lastLoadedAt: string | null;
};

export async function getDataStatus(): Promise<Map<string, SiteDataStatus>> {
  const rows = await query<{site: string; days: string; first_date: string; last_date: string; loaded_at: string}>(`
    SELECT site,
           countIf(row_count > 0) AS days,
           toString(minIf(load_date, row_count > 0)) AS first_date,
           toString(maxIf(load_date, row_count > 0)) AS last_date,
           toString(max(loaded_at)) AS loaded_at
    FROM gsc_load_log FINAL
    GROUP BY site
  `);
  return new Map(rows.map((row) => {
    const days = toNumber(row.days);
    return [row.site, {
      daysLoaded: days,
      firstDate: days ? row.first_date : null,
      lastDate: days ? row.last_date : null,
      lastLoadedAt: row.loaded_at,
    }];
  }));
}

/** Last day that has Search Console data for the site. */
export async function getLastDataDate(site: string): Promise<string | null> {
  const [row] = await query<{last_date: string; days: string}>(
    "SELECT toString(max(load_date)) AS last_date, count() AS days FROM gsc_load_log FINAL WHERE site = {site:String} AND row_count > 0",
    {site},
  );
  return row && toNumber(row.days) > 0 ? row.last_date : null;
}

/** Days already imported (days without data are remembered too, so they aren't requested again). */
export async function getLoadedDays(site: string): Promise<Set<string>> {
  const rows = await query<{day: string}>(
    "SELECT toString(load_date) AS day FROM gsc_load_log FINAL WHERE site = {site:String}",
    {site},
  );
  return new Set(rows.map((row) => row.day));
}

export async function markDayLoaded(site: string, date: string, rowCount: number): Promise<void> {
  await insert("gsc_load_log", [{site, load_date: date, row_count: rowCount}]);
}

/** Removes partially written rows of a day before it is imported again. */
export async function deleteDay(site: string, date: string): Promise<void> {
  const [row] = await query<{rows: string}>(
    "SELECT count() AS rows FROM gsc_raw WHERE site = {site:String} AND gsc_date = {date:Date}",
    {site, date},
  );
  if (toNumber(row?.rows) > 0) {
    await command("ALTER TABLE gsc_raw DELETE WHERE site = {site:String} AND gsc_date = {date:Date} SETTINGS mutations_sync = 1", {site, date});
  }
}

/* ─────────────────────────────── Annotations ─────────────────────────────── */

export type Annotation = {id: string; date: string; title: string; description: string};

export async function addAnnotation(site: string, date: string, title: string, description: string): Promise<Annotation> {
  const id = randomUUID();
  await insert("annotations", [{id, site, event_date: date, title, description}]);
  return {id, date, title, description};
}

export async function listAnnotations(site: string, start: string, end: string): Promise<Annotation[]> {
  const rows = await query<{id: string; date: string; title: string; description: string}>(`
    SELECT toString(id) AS id, toString(event_date) AS date, title, description
    FROM annotations
    WHERE site = {site:String} AND event_date BETWEEN {start:Date} AND {end:Date}
    ORDER BY event_date
  `, {site, start, end});
  return rows;
}

/* ─────────────────────────────── URL Inspection ─────────────────────────────── */

function toDateTime(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 19).replace("T", " ") : null;
}

export async function saveInspection(site: string, inspection: Inspection, clicks28d: number): Promise<void> {
  await insert("url_inspections", [{
    site,
    url: inspection.url,
    inspected_at: toDateTime(new Date()),
    verdict: inspection.verdict,
    coverage_state: inspection.coverageState,
    indexing_state: inspection.indexingState,
    robots_txt_state: inspection.robotsTxtState,
    page_fetch_state: inspection.pageFetchState,
    google_canonical: inspection.googleCanonical,
    user_canonical: inspection.userCanonical,
    last_crawl_time: toDateTime(inspection.lastCrawlTime),
    clicks28d: Math.max(0, Math.round(clicks28d)),
    inspection_link: inspection.inspectionLink,
  }]);
}

export type StoredInspection = {
  url: string;
  inspectedAt: string;
  verdict: string;
  coverageState: string | null;
  indexingState: string | null;
  robotsTxtState: string | null;
  pageFetchState: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  lastCrawlTime: string | null;
  clicks28d: number;
  inspectionLink: string | null;
};

/** Latest inspection per URL (optionally only for the given URLs). */
export async function latestInspections(site: string, urls?: string[]): Promise<StoredInspection[]> {
  const rows = await query<Record<string, string | null>>(`
    SELECT url,
           toString(max(inspected_at)) AS last_inspected_at,
           argMax(verdict, inspected_at) AS verdict,
           argMax(coverage_state, inspected_at) AS coverage_state,
           argMax(indexing_state, inspected_at) AS indexing_state,
           argMax(robots_txt_state, inspected_at) AS robots_txt_state,
           argMax(page_fetch_state, inspected_at) AS page_fetch_state,
           argMax(google_canonical, inspected_at) AS google_canonical,
           argMax(user_canonical, inspected_at) AS user_canonical,
           toString(argMax(last_crawl_time, inspected_at)) AS last_crawl_time,
           argMax(clicks28d, inspected_at) AS clicks28d,
           argMax(inspection_link, inspected_at) AS inspection_link
    FROM url_inspections
    WHERE site = {site:String} ${urls ? "AND url IN {urls:Array(String)}" : ""}
    GROUP BY url
  `, {site, urls: urls ?? []});
  return rows.map((row) => ({
    url: String(row.url),
    inspectedAt: String(row.last_inspected_at),
    verdict: String(row.verdict),
    coverageState: row.coverage_state,
    indexingState: row.indexing_state,
    robotsTxtState: row.robots_txt_state,
    pageFetchState: row.page_fetch_state,
    googleCanonical: row.google_canonical,
    userCanonical: row.user_canonical,
    lastCrawlTime: row.last_crawl_time && row.last_crawl_time !== "\\N" ? row.last_crawl_time : null,
    clicks28d: toNumber(row.clicks28d),
    inspectionLink: row.inspection_link,
  }));
}
