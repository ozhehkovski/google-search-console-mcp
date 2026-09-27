# Google Search Console MCP Server — SEO analysis for Claude, ChatGPT & Cursor

[![CI](https://github.com/ozhehkovski/google-search-console-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ozhehkovski/google-search-console-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-server-6E56CF)](https://modelcontextprotocol.io)
[![Docker](https://img.shields.io/badge/Docker-compose-2496ED?logo=docker&logoColor=white)](docker-compose.yml)

**Self-hosted [MCP](https://modelcontextprotocol.io) server for Google Search Console.** It syncs your
Search Console performance data (clicks, impressions, CTR, positions by query, page, country and device)
into a local ClickHouse database and gives AI agents — **Claude Code, Claude Desktop, ChatGPT, Cursor,
VS Code Copilot, Windsurf** — ready-made SEO analysis tools: traffic drop diagnosis, decaying pages,
striking-distance keywords, keyword cannibalization, low-CTR snippets, indexing issues and weekly SEO reports.

Run it locally with Docker, upload a Google service account JSON key, and ask your AI:

> *"Why did my organic traffic drop last week?"* · *"Find keywords ranking 4–15 I can push into the top 3."* ·
> *"Which pages are losing clicks?"* · *"Find keyword cannibalization."* · *"Create my weekly SEO report."*

> [!TIP]
> **Don't want to self-host?** Use the free hosted Search Console MCP server at **[my.topify.pro](https://my.topify.pro)** —
> sign in with Google, pick your sites and connect Claude or ChatGPT in one click.
> Free, **up to 10 sites per user**, no Docker or Google Cloud setup. MCP endpoint: `https://my.topify.pro/api/mcp`.

---

## Contents

- [Why this Search Console MCP server](#why-this-search-console-mcp-server)
- [Quick start (Docker)](#quick-start-docker)
- [Connect Claude, ChatGPT, Cursor and other AI agents](#connect-your-ai-agent)
- [MCP tools](#mcp-tools) and [prompts](#mcp-prompts)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Hosted version (free, 10 sites)](#hosted-version)
- [FAQ](#faq)

## Why this Search Console MCP server

Most Search Console MCP servers are thin wrappers over the Search Console API: the model gets raw rows,
hits the 25,000-row and 16-month limits, and has to do the math itself — slowly and often wrongly.
This server does the analysis **before** the model sees the data:

- **Answers, not rows.** Every tool returns a summary, the evidence and prioritized actions. The model
  retells deterministic results computed in SQL instead of inventing numbers.
- **All your data, locally.** Daily import at the finest grain (date × query × page × country × device),
  including a reconciled row for anonymized queries so totals match Search Console exactly.
- **History beyond 16 months.** Search Console forgets data after 16 months; your local copy doesn't.
- **Fast.** ClickHouse answers year-over-year comparisons across millions of rows in milliseconds.
- **Private.** Your data never leaves your machine except for the calls to Google's API and to the AI you choose.
- **Works with every MCP client.** Streamable HTTP (`http://localhost:3333/mcp`) and stdio.

## Quick start (Docker)

Requirements: [Docker](https://docs.docker.com/get-docker/) with Compose, a Google account with access to Search Console.

```bash
git clone https://github.com/ozhehkovski/google-search-console-mcp.git
cd google-search-console-mcp
docker compose up -d
```

1. **Create a service account key** — [step-by-step guide](docs/service-account.md) (5 minutes, free):
   enable the Search Console API in Google Cloud, create a service account and download its JSON key.
2. **Upload the key** at **http://localhost:3333** (or save it as `credentials/service-account.json`).
3. **Add the service account email** shown on that page as a user in
   [Search Console → Settings → Users and permissions](https://search.google.com/search-console/users)
   for each site (the *Restricted* permission is enough), then click **Sync now**.
4. **Connect your AI agent** (below) and ask a question. The latest weeks are imported first, so answers
   are available within minutes while the rest of the 16-month history keeps loading.

Want to try it without a Google key? Load a synthetic demo site:

```bash
docker compose exec gsc-mcp node dist/index.js demo
```

## Connect your AI agent

The MCP endpoint is `http://localhost:3333/mcp` (Streamable HTTP). The status page at
http://localhost:3333 shows ready-to-copy snippets.

**Claude Code**

```bash
claude mcp add --transport http search-console http://localhost:3333/mcp
```

**Cursor** — `~/.cursor/mcp.json`, **Windsurf** — `~/.codeium/windsurf/mcp_config.json` (use `serverUrl`):

```json
{
  "mcpServers": {
    "search-console": { "url": "http://localhost:3333/mcp" }
  }
}
```

**VS Code (GitHub Copilot)** — `.vscode/mcp.json`:

```json
{
  "servers": {
    "search-console": { "type": "http", "url": "http://localhost:3333/mcp" }
  }
}
```

**Claude Desktop** — `claude_desktop_config.json` (stdio through the running container):

```json
{
  "mcpServers": {
    "search-console": {
      "command": "docker",
      "args": ["exec", "-i", "gsc-mcp", "node", "dist/index.js", "stdio"]
    }
  }
}
```

**Claude.ai and ChatGPT (web)** connect only to public HTTPS servers with OAuth. Use the
[hosted version](#hosted-version), or put this server behind your own HTTPS reverse proxy.

If you expose the server beyond localhost, set `MCP_AUTH_TOKEN` and send `Authorization: Bearer <token>`
(for Claude Code: `--header "Authorization: Bearer <token>"`).

## MCP tools

| Tool | Answers the question |
|---|---|
| `list_sites` | Which Search Console properties are available and how much data is imported? |
| `get_site_overview` | How is my site doing? Clicks, impressions, CTR, position vs previous period and last year, top movers. |
| `explain_traffic_change` | **Why did my organic traffic drop (or grow)?** When it started, which pages / queries / devices / countries / branded traffic drove it, and whether the cause is rankings, search demand or CTR. Checks seasonality, annotations and indexing. |
| `find_decaying_pages` | Which pages are losing clicks? `sudden_drop`, `gradual_decay` or `seasonal`. |
| `find_striking_distance` | Which keywords ranking 4–15 can reach the top 3, and how many clicks would that bring? |
| `find_cannibalization` | Which queries are split between several pages, which page should win, does Google flip-flop between them? |
| `find_low_ctr_pages` | Which top-5 rankings get far fewer clicks than expected (title/meta rewrite, SERP features, AI Overviews)? |
| `find_query_changes` | New queries (emerging topics) and lost queries. |
| `analyze_page` | Deep dive into one URL: trend, top and lost queries, striking distance, cannibalization, indexing. |
| `get_weekly_action_plan` | **What should I work on this week?** Ranked tasks with expected clicks per week. |
| `generate_seo_report` | Ready-to-share markdown SEO report (owner or SEO-specialist audience). |
| `get_indexing_issues` | Pages Google doesn't index and why (URL Inspection API), traffic-losing pages first. |
| `get_sitemap_status` | Sitemap errors, warnings and freshness from Search Console. |
| `add_annotation` | Mark an event (release, migration, title changes) so later analysis takes it into account. |
| `set_brand_names` | Brand terms to split branded vs non-branded traffic. |

CTR expectations are calibrated on **your site's own data** (median CTR by position), falling back to an
industry curve where there isn't enough volume.

## MCP prompts

Ready-made workflows your MCP client shows as commands: `weekly_seo_report`, `investigate_traffic_drop`,
`striking_distance_sprint`, `cannibalization_cleanup`, `content_refresh_plan`, `indexing_audit`.

## Configuration

Copy `.env.example` to `.env`; every variable is optional.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3333` | Port of the status page and `/mcp` endpoint (bound to `127.0.0.1`). |
| `MCP_AUTH_TOKEN` | — | Require `Authorization: Bearer <token>` for `/mcp` and uploads. |
| `GSC_SITES` | all | Comma-separated properties to sync, e.g. `sc-domain:example.com,https://blog.example.com/`. |
| `BRAND_NAMES` | — | Brand terms for all sites (per site: `set_brand_names` tool). |
| `SYNC_INTERVAL_HOURS` | `6` | How often to pull fresh data; `0` = only at start. |
| `HISTORY_MONTHS` | `16` | History to import on the first run (Search Console keeps 16). |
| `SYNC_CONCURRENCY` | `4` | Days fetched in parallel from the API. |
| `INSPECTION_DAILY_LIMIT` | `100` | URL Inspection checks per site per sync (Google allows 2,000/day); `0` disables. |
| `PUBLIC_URL` | `http://localhost:3333` | URL shown in snippets when running behind a proxy. |

Useful commands:

```bash
docker compose exec gsc-mcp node dist/index.js sites   # properties the service account can read
curl -X POST http://localhost:3333/api/sync            # import missing days now (same as "Sync now")
docker compose logs -f gsc-mcp                         # sync progress
```

## How it works

```
Google Search Console API ──(service account, read-only)──► sync (every 6 h)
                                                               │  date × query × page × country × device
                                                               ▼
AI agent ──MCP (HTTP / stdio)──► tools ──SQL──► ClickHouse ◄───┘
               ▲                   │
               └─ summary + evidence + actions (analysis in TypeScript, unit-tested)
```

- `src/sync` — incremental import: only missing days are requested, newest first; an interrupted day is cleaned up and imported again.
- `src/db` — ClickHouse schema and parameterized analytical queries.
- `src/analysis` — pure, tested SEO logic: change-point detection, cause attribution, CTR curve calibration,
  decay classification, cannibalization and flip-flops, action plan scoring, report rendering.
- `src/mcp` — MCP tools and prompts.

Local development:

```bash
pnpm install
pnpm test          # unit tests
pnpm typecheck
docker compose up -d clickhouse   # add `ports: ["127.0.0.1:8123:8123"]` to the clickhouse service first
CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_USER=gsc CLICKHOUSE_PASSWORD=gsc-local-password pnpm dev
```

## Hosted version

**[my.topify.pro](https://my.topify.pro)** runs the same analysis as a managed MCP server:

- **Free, up to 10 sites per user.**
- Sign in with Google — no Google Cloud project, service account or Docker.
- Works with **Claude.ai, Claude Desktop, ChatGPT** (OAuth connectors) and API keys for Claude Code, Cursor and VS Code.
- MCP endpoint: `https://my.topify.pro/api/mcp`.

## FAQ

**Is this an official Google product?** No. It uses the public
[Search Console API](https://developers.google.com/webmaster-tools) with read-only access.

**Which Search Console data is available?** Search performance (Search Analytics) by query, page, country
and device; URL Inspection results for the most important pages; sitemaps. Search Console reports data with a
2–3 day delay, and every analysis period ends on the last day with data.

**Why a service account instead of "Sign in with Google"?** It runs unattended on your machine, needs no
OAuth app verification and only gets the properties you explicitly share with it.

**How much data can it handle?** ClickHouse comfortably handles tens of millions of rows on a laptop.
The import follows Search Console API quotas; very large sites take longer on the first run.

**Does my data leave my computer?** Only the tool results you ask your AI agent about are sent to that AI provider.

**Can I use it with ChatGPT?** ChatGPT connectors need a public HTTPS URL with OAuth — use the
[hosted version](#hosted-version) or your own HTTPS proxy.

## License

[MIT](LICENSE) © Topify. Contributions welcome — open an issue or a pull request.

<sub>Keywords: Google Search Console MCP, GSC MCP server, Search Console API, SEO MCP server, Model Context Protocol,
Claude SEO, ChatGPT SEO, Cursor MCP, AI SEO agent, organic traffic drop analysis, keyword cannibalization,
striking distance keywords, self-hosted SEO analytics, ClickHouse, Docker.</sub>
