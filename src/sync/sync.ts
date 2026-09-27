import {getConfig} from "../config";
import {insert} from "../db/clickhouse";
import {InsightsClient} from "../db/insights";
import {
  deleteDay,
  getLastDataDate,
  getLoadedDays,
  latestInspections,
  markDayLoaded,
  saveInspection,
  saveSites,
} from "../db/store";
import {selectUrlsForInspection} from "../analysis";
import {CredentialsError} from "../google/auth";
import {GscApiError} from "../google/errors";
import {inspectUrl, listSites, querySearchAnalytics, type GscSite} from "../google/gsc";
import {normalizeSiteRef} from "../google/property";
import {buildDayFacts} from "./day-facts";
import {isFinalEmptyDay, planDays} from "./plan";

export type SiteSyncState = {
  status: "idle" | "running" | "done" | "error";
  daysPlanned: number;
  daysDone: number;
  error: string | null;
  finishedAt: string | null;
  inspected: number;
};

type SyncState = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  sites: Map<string, SiteSyncState>;
};

export const syncState: SyncState = {running: false, startedAt: null, finishedAt: null, error: null, sites: new Map()};

const log = (message: string) => console.log(`[sync] ${message}`);

/** Unrecoverable for this run: retrying won't help until the user fixes access or the quota resets. */
function isFatal(error: unknown): boolean {
  if (error instanceof CredentialsError) return true;
  return error instanceof GscApiError
    && ["unauthorized", "insufficient_scope", "insufficient_permission", "quota_exceeded", "not_found"].includes(error.code);
}

async function withRetries<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const retryable = error instanceof GscApiError ? error.retryable : !isFatal(error);
      if (!retryable || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

/** Properties the service account can read, narrowed to GSC_SITES when it is set. */
export async function discoverSites(): Promise<GscSite[]> {
  const {sites: allowlist} = getConfig();
  const available = (await listSites()).filter((site) => site.permissionLevel !== "siteUnverifiedUser");
  const wanted = allowlist.map(normalizeSiteRef);
  const selected = allowlist.length
    ? available.filter((site) => allowlist.includes(site.siteUrl) || wanted.includes(normalizeSiteRef(site.siteUrl)))
    : available;
  await saveSites(selected);
  return selected;
}

export async function syncDay(site: string, day: string, today = new Date()): Promise<number> {
  const [totals, detailed] = await Promise.all([
    withRetries(() => querySearchAnalytics(site, day, ["country", "device"])),
    withRetries(() => querySearchAnalytics(site, day, ["query", "page", "country", "device"])),
  ]);
  const {facts, keywords} = buildDayFacts({site, date: day, totals, detailed});

  if (facts.length === 0) {
    if (isFinalEmptyDay(day, today)) await markDayLoaded(site, day, 0);
    return 0;
  }
  await deleteDay(site, day);
  await insert("dim_keyword", Array.from(keywords, ([kwId, query]) => ({site, kw_id: kwId, query})));
  // Insert in chunks to keep memory flat on large sites
  for (let index = 0; index < facts.length; index += 50_000) {
    await insert("gsc_raw", facts.slice(index, index + 50_000));
  }
  await markDayLoaded(site, day, facts.length);
  return facts.length;
}

async function syncSiteData(site: string, state: SiteSyncState): Promise<void> {
  const {historyMonths, syncConcurrency} = getConfig();
  const days = planDays({today: new Date(), historyMonths, loaded: await getLoadedDays(site)});
  state.daysPlanned = days.length;
  state.daysDone = 0;
  if (days.length) log(`${site}: importing ${days.length} day(s)`);

  let next = 0;
  let fatal: unknown = null;
  const worker = async () => {
    while (next < days.length && !fatal) {
      const day = days[next++];
      try {
        await syncDay(site, day);
        state.daysDone += 1;
      } catch (error) {
        if (isFatal(error)) {
          fatal = error;
          return;
        }
        log(`${site}: ${day} failed, will retry on the next sync: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  await Promise.all(Array.from({length: Math.min(syncConcurrency, Math.max(days.length, 1))}, worker));
  if (fatal) throw fatal;
}

/** Checks indexing of the most important pages with the URL Inspection API, within the daily budget. */
async function syncInspections(site: string, state: SiteSyncState): Promise<void> {
  const limit = getConfig().inspectionDailyLimit;
  if (limit <= 0) return;
  const lastDate = await getLastDataDate(site);
  if (!lastDate) return;

  const client = new InsightsClient(site);
  const {topPages, droppingPages} = await client.indexingCandidates(lastDate, Math.max(limit * 3, 100));
  const inspected = await latestInspections(site);
  const lastInspectedAt = new Map(inspected.map((item) => [item.url, new Date(`${item.inspectedAt.replace(" ", "T")}Z`)]));
  const targets = selectUrlsForInspection({topPages, droppingPages, lastInspectedAt, limit});

  for (const target of targets) {
    try {
      const inspection = await withRetries(() => inspectUrl(site, target.url), 3);
      await saveInspection(site, inspection, target.clicks28d);
      state.inspected += 1;
    } catch (error) {
      if (isFatal(error)) {
        log(`${site}: stopping URL inspection: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      log(`${site}: inspection failed for ${target.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export function describeSyncError(error: unknown): string {
  if (error instanceof GscApiError) {
    switch (error.code) {
      case "insufficient_permission":
      case "not_found":
        return "The service account has no access to this property. Add its email in Search Console → Settings → Users and permissions.";
      case "unauthorized":
        return "Google rejected the service account key. Create a new JSON key and upload it again.";
      case "insufficient_scope":
        return "The Search Console API is not enabled for the key's Google Cloud project.";
      case "quota_exceeded":
        return "Search Console API quota exceeded; the import continues on the next sync.";
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/** One full sync: discover properties, import missing days, check indexing. Concurrent calls are ignored. */
export async function runSync(options: {site?: string} = {}): Promise<void> {
  if (syncState.running) {
    log("a sync is already running");
    return;
  }
  syncState.running = true;
  syncState.startedAt = new Date().toISOString();
  syncState.error = null;
  try {
    const sites = await discoverSites();
    if (sites.length === 0) {
      syncState.error = "The service account doesn't have access to any Search Console property yet.";
      log(syncState.error);
      return;
    }
    const selected = options.site ? sites.filter((site) => site.siteUrl === options.site) : sites;
    for (const {siteUrl} of selected) {
      const state: SiteSyncState = {status: "running", daysPlanned: 0, daysDone: 0, error: null, finishedAt: null, inspected: 0};
      syncState.sites.set(siteUrl, state);
      try {
        await syncSiteData(siteUrl, state);
        await syncInspections(siteUrl, state);
        state.status = "done";
        log(`${siteUrl}: ${state.daysDone} day(s) imported, ${state.inspected} URL(s) inspected`);
      } catch (error) {
        state.status = "error";
        state.error = describeSyncError(error);
        log(`${siteUrl}: ${state.error}`);
      } finally {
        state.finishedAt = new Date().toISOString();
      }
    }
  } catch (error) {
    syncState.error = describeSyncError(error);
    log(`failed: ${syncState.error}`);
  } finally {
    syncState.running = false;
    syncState.finishedAt = new Date().toISOString();
  }
}

let timer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  const hours = getConfig().syncIntervalHours;
  void runSync();
  if (hours > 0) {
    timer = setInterval(() => void runSync(), hours * 60 * 60 * 1000);
    timer.unref();
  }
}
