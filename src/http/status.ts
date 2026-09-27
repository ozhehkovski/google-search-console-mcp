import {getConfig} from "../config";
import {getDataStatus, listStoredSites, type SiteDataStatus} from "../db/store";
import {getCredentialsStatus, type CredentialsStatus} from "../google/auth";
import {displayName} from "../google/property";
import {syncState, type SiteSyncState} from "../sync/sync";

export type StatusReport = {
  credentials: CredentialsStatus;
  mcpUrl: string;
  authRequired: boolean;
  sync: {running: boolean; startedAt: string | null; finishedAt: string | null; error: string | null};
  sites: Array<{
    siteUrl: string;
    name: string;
    permissionLevel: string;
    data: SiteDataStatus | null;
    sync: SiteSyncState | null;
  }>;
};

export async function getStatusReport(): Promise<StatusReport> {
  const config = getConfig();
  const [credentials, sites, data] = await Promise.all([getCredentialsStatus(), listStoredSites(), getDataStatus()]);
  return {
    credentials,
    mcpUrl: `${config.publicUrl}/mcp`,
    authRequired: Boolean(config.authToken),
    sync: {running: syncState.running, startedAt: syncState.startedAt, finishedAt: syncState.finishedAt, error: syncState.error},
    sites: sites.map((site) => ({
      siteUrl: site.siteUrl,
      name: displayName(site.siteUrl),
      permissionLevel: site.permissionLevel,
      data: data.get(site.siteUrl) ?? null,
      sync: syncState.sites.get(site.siteUrl) ?? null,
    })),
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[char]!);
}

function siteRow(site: StatusReport["sites"][number]): string {
  const sync = site.sync;
  const progress = sync?.status === "running"
    ? `Importing… ${sync.daysDone}/${sync.daysPlanned} days`
    : sync?.status === "error" ? `Error: ${sync.error ?? "unknown"}` : site.data ? "Up to date" : "Waiting for sync";
  const badge = sync?.status === "error" ? "bad" : sync?.status === "running" ? "warn" : site.data ? "ok" : "warn";
  return `<tr>
    <td><strong>${escapeHtml(site.name)}</strong><div class="muted mono">${escapeHtml(site.siteUrl)}</div></td>
    <td>${site.data ? `${site.data.daysLoaded}` : "0"}</td>
    <td class="mono">${site.data?.firstDate ? `${escapeHtml(site.data.firstDate)} → ${escapeHtml(site.data.lastDate ?? "")}` : "—"}</td>
    <td><span class="badge ${badge}">${escapeHtml(progress)}</span></td>
  </tr>`;
}

/** Local status page: key upload, sync progress and client setup snippets. */
export function renderStatusPage(report: StatusReport): string {
  const {credentials} = report;
  const tokenHeader = report.authRequired ? ` --header "Authorization: Bearer YOUR_MCP_AUTH_TOKEN"` : "";
  const credentialsBlock = credentials.ok
    ? `<p><span class="badge ok">Key loaded</span> Service account: <code>${escapeHtml(credentials.clientEmail)}</code></p>
       <p class="muted">Add this email as a user (Restricted is enough) in <a href="https://search.google.com/search-console/users" target="_blank" rel="noopener">Search Console → Settings → Users and permissions</a> for every property you want to analyze, then click “Sync now”.</p>`
    : `<p><span class="badge bad">${credentials.reason === "missing" ? "No key yet" : "Invalid key"}</span> ${escapeHtml(credentials.message)}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Search Console MCP</title>
<style>
  :root { --bg:#f7f7f5; --card:#fff; --text:#1c1c1a; --muted:#6b6b66; --border:#e4e4df; --accent:#1a73e8; --ok:#1e8e3e; --warn:#b06000; --bad:#c5221f; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161615; --card:#1f1f1d; --text:#ececea; --muted:#9a9a94; --border:#33332f; --accent:#8ab4f8; --ok:#81c995; --warn:#fdd663; --bad:#f28b82; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:900px; margin:0 auto; padding:32px 16px 64px; display:flex; flex-direction:column; gap:20px; }
  h1 { font-size:26px; margin:0; } h2 { font-size:17px; margin:0 0 12px; }
  section { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:20px; }
  .muted { color:var(--muted); font-size:13px; } .mono, code, pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
  code { background:var(--bg); padding:1px 5px; border-radius:4px; word-break:break-all; }
  pre { background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:12px; overflow-x:auto; margin:6px 0 14px; }
  table { width:100%; border-collapse:collapse; } th, td { text-align:left; padding:10px 8px; border-top:1px solid var(--border); vertical-align:top; }
  th { font-size:12px; color:var(--muted); font-weight:600; border-top:none; }
  .badge { display:inline-block; font-size:12px; font-weight:600; padding:2px 8px; border-radius:999px; border:1px solid currentColor; }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); }
  button { background:var(--accent); color:#fff; border:0; border-radius:8px; padding:9px 16px; font-weight:600; cursor:pointer; }
  @media (prefers-color-scheme: dark) { button { color:#161615; } }
  input[type=file], input[type=password] { font:inherit; color:inherit; }
  input[type=password] { background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:8px; width:100%; max-width:360px; }
  .row { display:flex; flex-wrap:wrap; gap:12px; align-items:center; }
  .table-wrap { overflow-x:auto; }
  #message { min-height:1.5em; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Google Search Console MCP</h1>
    <p class="muted">Self-hosted MCP server for your Search Console data. MCP endpoint: <code>${escapeHtml(report.mcpUrl)}</code></p>
  </header>

  <section>
    <h2>1. Google service account key</h2>
    ${credentialsBlock}
    <div class="row">
      <input type="file" id="key" accept="application/json,.json">
      ${report.authRequired ? `<input type="password" id="token" placeholder="MCP_AUTH_TOKEN">` : ""}
      <button id="upload">Upload JSON key</button>
    </div>
    <p id="message" class="muted"></p>
  </section>

  <section>
    <h2>2. Data sync</h2>
    <div class="row">
      <span class="badge ${report.sync.running ? "warn" : report.sync.error ? "bad" : "ok"}">${report.sync.running ? "Sync running" : report.sync.error ? "Sync problem" : "Idle"}</span>
      <span class="muted">${report.sync.finishedAt ? `Last run finished ${escapeHtml(report.sync.finishedAt)}` : "No finished runs yet"}</span>
      <button id="sync">Sync now</button>
    </div>
    ${report.sync.error ? `<p class="bad">${escapeHtml(report.sync.error)}</p>` : ""}
    <div class="table-wrap">
    <table>
      <thead><tr><th>Site</th><th>Days</th><th>Range</th><th>Status</th></tr></thead>
      <tbody>${report.sites.length ? report.sites.map(siteRow).join("") : `<tr><td colspan="4" class="muted">No properties yet. Upload the key and add the service account email to Search Console.</td></tr>`}</tbody>
    </table>
    </div>
  </section>

  <section>
    <h2>3. Connect your AI agent</h2>
    <p class="muted">Claude Code</p>
    <pre>claude mcp add --transport http search-console ${escapeHtml(report.mcpUrl)}${escapeHtml(tokenHeader)}</pre>
    <p class="muted">Cursor / VS Code / Windsurf / Claude Desktop (mcp.json)</p>
    <pre>${escapeHtml(JSON.stringify({mcpServers: {"search-console": {url: report.mcpUrl, ...(report.authRequired ? {headers: {Authorization: "Bearer YOUR_MCP_AUTH_TOKEN"}} : {})}}}, null, 2))}</pre>
    <p class="muted">Then ask: “Why did my organic traffic drop last week?”, “Find keywords ranking 4–15 I can push into the top 3”, “Create my weekly SEO report”.</p>
  </section>

  <p class="muted">Don't want to self-host? Use the free hosted server at <a href="https://my.topify.pro" target="_blank" rel="noopener">my.topify.pro</a> — up to 10 sites per user.</p>
</main>
<script>
  const message = document.getElementById("message");
  const token = () => document.getElementById("token")?.value ?? "";
  const headers = (extra = {}) => ({...extra, ...(token() ? {Authorization: "Bearer " + token()} : {})});
  document.getElementById("upload").addEventListener("click", async () => {
    const file = document.getElementById("key").files[0];
    if (!file) { message.textContent = "Choose the JSON key file first."; return; }
    message.textContent = "Uploading…";
    const response = await fetch("/api/credentials", {method: "POST", headers: headers({"Content-Type": "application/json"}), body: await file.text()});
    const result = await response.json().catch(() => ({}));
    message.textContent = response.ok ? "Saved. Service account: " + result.clientEmail + ". Sync started." : (result.error || "Upload failed.");
    if (response.ok) setTimeout(() => location.reload(), 1500);
  });
  document.getElementById("sync").addEventListener("click", async () => {
    const response = await fetch("/api/sync", {method: "POST", headers: headers()});
    if (response.ok) location.reload(); else alert((await response.json().catch(() => ({}))).error || "Failed to start sync");
  });
  ${report.sync.running ? "setTimeout(() => location.reload(), 10000);" : ""}
</script>
</body>
</html>`;
}
