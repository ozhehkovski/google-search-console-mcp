/** Runtime configuration, read once from environment variables. */

export type Config = {
  port: number;
  host: string;
  /** Optional bearer token required for /mcp and the credentials upload. Empty = no auth (localhost only). */
  authToken: string;
  credentialsPath: string;
  clickhouse: {url: string; username: string; password: string; database: string};
  /** Optional allowlist of Search Console properties; empty = every property the service account can read. */
  sites: string[];
  /** Brand terms used to split branded / non-branded traffic, applied to every site. */
  brandNames: string[];
  syncIntervalHours: number;
  /** How far back the first import goes (Search Console keeps 16 months). */
  historyMonths: number;
  syncConcurrency: number;
  /** URL Inspection checks per site per sync run; 0 disables indexing checks. */
  inspectionDailyLimit: number;
  publicUrl: string;
};

function intEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

function listEnv(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function loadConfig(): Config {
  const port = intEnv("PORT", 3333, 1);
  return {
    port,
    host: process.env.HOST ?? "0.0.0.0",
    authToken: process.env.MCP_AUTH_TOKEN ?? "",
    credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "./credentials/service-account.json",
    clickhouse: {
      url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
      username: process.env.CLICKHOUSE_USER ?? "default",
      password: process.env.CLICKHOUSE_PASSWORD ?? "",
      database: process.env.CLICKHOUSE_DB ?? "gsc",
    },
    sites: listEnv("GSC_SITES"),
    brandNames: listEnv("BRAND_NAMES"),
    syncIntervalHours: intEnv("SYNC_INTERVAL_HOURS", 6, 0),
    historyMonths: Math.min(intEnv("HISTORY_MONTHS", 16, 1), 16),
    syncConcurrency: intEnv("SYNC_CONCURRENCY", 4, 1),
    inspectionDailyLimit: Math.min(intEnv("INSPECTION_DAILY_LIMIT", 100, 0), 2000),
    publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
  };
}

let cached: Config | null = null;

export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}
