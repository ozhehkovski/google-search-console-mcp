import {google, type searchconsole_v1, type webmasters_v3} from "googleapis";
import {CredentialsError, getGoogleAuth} from "./auth";
import {toGscApiError} from "./errors";

/** Keeps credential problems readable; everything else becomes a GscApiError. */
function apiError(error: unknown, operation: string): Error {
  return error instanceof CredentialsError ? error : toGscApiError(error, operation);
}

export type GscSite = {siteUrl: string; permissionLevel: string};

/** Properties the service account was added to (Search Console → Settings → Users and permissions). */
export async function listSites(): Promise<GscSite[]> {
  try {
    const webmasters = google.webmasters({version: "v3", auth: await getGoogleAuth()});
    const res = await webmasters.sites.list();
    return (res.data.siteEntry ?? []).flatMap((entry) => entry.siteUrl ? [{
      siteUrl: entry.siteUrl,
      permissionLevel: entry.permissionLevel ?? "unknown",
    }] : []);
  } catch (error) {
    throw apiError(error, "sites.list");
  }
}

export type SearchAnalyticsRow = {keys: string[]; clicks: number; impressions: number; position: number};

const ROW_LIMIT = 25_000;

/** All rows for one day and set of dimensions, following pagination. */
export async function querySearchAnalytics(siteUrl: string, date: string, dimensions: string[]): Promise<SearchAnalyticsRow[]> {
  const webmasters = google.webmasters({version: "v3", auth: await getGoogleAuth()});
  const rows: SearchAnalyticsRow[] = [];
  let startRow = 0;
  while (true) {
    let data: webmasters_v3.Schema$SearchAnalyticsQueryResponse;
    try {
      ({data} = await webmasters.searchanalytics.query({
        siteUrl,
        requestBody: {startDate: date, endDate: date, dimensions, rowLimit: ROW_LIMIT, startRow, dataState: "final"},
      }));
    } catch (error) {
      throw apiError(error, "searchanalytics.query");
    }
    const page = data.rows ?? [];
    for (const row of page) {
      rows.push({keys: row.keys ?? [], clicks: row.clicks ?? 0, impressions: row.impressions ?? 0, position: row.position ?? 0});
    }
    if (page.length < ROW_LIMIT) return rows;
    startRow += page.length;
  }
}

export type Sitemap = {
  path: string;
  type: string | null;
  isSitemapsIndex: boolean;
  isPending: boolean;
  lastSubmitted: string | null;
  lastDownloaded: string | null;
  errors: number;
  warnings: number;
  submittedUrls: number;
};

function toNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeSitemap(sitemap: webmasters_v3.Schema$WmxSitemap): Sitemap {
  return {
    path: sitemap.path ?? "",
    type: sitemap.type ?? null,
    isSitemapsIndex: Boolean(sitemap.isSitemapsIndex),
    isPending: Boolean(sitemap.isPending),
    lastSubmitted: sitemap.lastSubmitted ?? null,
    lastDownloaded: sitemap.lastDownloaded ?? null,
    errors: toNumber(sitemap.errors),
    warnings: toNumber(sitemap.warnings),
    submittedUrls: (sitemap.contents ?? []).reduce((sum, content) => sum + toNumber(content.submitted), 0),
  };
}

export async function listSitemaps(siteUrl: string): Promise<Sitemap[]> {
  try {
    const webmasters = google.webmasters({version: "v3", auth: await getGoogleAuth()});
    const res = await webmasters.sitemaps.list({siteUrl});
    return (res.data.sitemap ?? []).map(normalizeSitemap).filter((sitemap) => sitemap.path);
  } catch (error) {
    throw apiError(error, "sitemaps.list");
  }
}

export type Inspection = {
  url: string;
  verdict: string;
  coverageState: string | null;
  indexingState: string | null;
  robotsTxtState: string | null;
  pageFetchState: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  lastCrawlTime: Date | null;
  inspectionLink: string | null;
};

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  // Google returns 1970-01-01 for pages it never crawled
  return Number.isNaN(date.getTime()) || date.getTime() <= 0 ? null : date;
}

export function normalizeInspection(url: string, response: searchconsole_v1.Schema$InspectUrlIndexResponse): Inspection {
  const result = response.inspectionResult ?? {};
  const index = result.indexStatusResult ?? {};
  return {
    url,
    verdict: index.verdict ?? "VERDICT_UNSPECIFIED",
    coverageState: index.coverageState ?? null,
    indexingState: index.indexingState ?? null,
    robotsTxtState: index.robotsTxtState ?? null,
    pageFetchState: index.pageFetchState ?? null,
    googleCanonical: index.googleCanonical ?? null,
    userCanonical: index.userCanonical ?? null,
    lastCrawlTime: toDate(index.lastCrawlTime),
    inspectionLink: result.inspectionResultLink ?? null,
  };
}

/** URL Inspection API. Google quota: 2000 per day and 600 per minute per property. */
export async function inspectUrl(siteUrl: string, url: string): Promise<Inspection> {
  try {
    const searchconsole = google.searchconsole({version: "v1", auth: await getGoogleAuth()});
    const res = await searchconsole.urlInspection.index.inspect({
      requestBody: {siteUrl, inspectionUrl: url, languageCode: "en-US"},
    });
    return normalizeInspection(url, res.data);
  } catch (error) {
    throw apiError(error, "urlInspection.index.inspect");
  }
}
