import {getConfig} from "../config";
import {getBrandNames, getDataStatus, listStoredSites} from "../db/store";
import {displayName, normalizeSiteRef} from "../google/property";

export type SiteContext = {
  siteUrl: string;
  displayName: string;
  brandNames: string[];
  permissionLevel: string;
  dataReady: boolean;
  dashboardUrl: string;
};

export type ToolErrorCode = "site_not_found" | "site_required" | "data_not_ready" | "invalid_argument" | "google_error";

/** Expected tool error: the message is returned to the agent as is. */
export class ToolError extends Error {
  constructor(public readonly code: ToolErrorCode, message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export async function listSites(): Promise<SiteContext[]> {
  const [sites, status] = await Promise.all([listStoredSites(), getDataStatus()]);
  const {publicUrl, brandNames} = getConfig();
  return Promise.all(sites.map(async (site) => ({
    siteUrl: site.siteUrl,
    displayName: displayName(site.siteUrl),
    brandNames: (await getBrandNames(site.siteUrl)) ?? brandNames,
    permissionLevel: site.permissionLevel,
    dataReady: (status.get(site.siteUrl)?.daysLoaded ?? 0) > 0,
    dashboardUrl: publicUrl,
  })));
}

/** Finds a site by Search Console property or domain; with a single site the argument is optional. */
export async function resolveSite(site?: string): Promise<SiteContext> {
  const sites = await listSites();
  if (sites.length === 0) {
    throw new ToolError("site_not_found",
      `No Search Console properties are available yet. Add the service account email as a user in Search Console and wait for the first sync (status: ${getConfig().publicUrl}).`);
  }
  if (!site) {
    if (sites.length === 1) return sites[0];
    throw new ToolError("site_required",
      `Several sites are available; pass the "site" argument. Available: ${sites.map((item) => item.displayName).join(", ")}.`);
  }

  const reference = site.trim();
  const normalized = normalizeSiteRef(reference);
  const exact = sites.find((item) => item.siteUrl === reference);
  // A domain property and a URL-prefix property can share a host — prefer the domain one
  const byName = sites
    .filter((item) => normalizeSiteRef(item.siteUrl) === normalized)
    .sort((a, b) => Number(b.siteUrl.startsWith("sc-domain:")) - Number(a.siteUrl.startsWith("sc-domain:")));
  const match = exact ?? byName[0];
  if (!match) {
    throw new ToolError("site_not_found",
      `Site "${site}" is not available. Available: ${sites.map((item) => item.displayName).join(", ")}.`);
  }
  return match;
}
