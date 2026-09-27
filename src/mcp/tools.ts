import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {CallToolResult} from "@modelcontextprotocol/sdk/types.js";
import {z} from "zod";
import {addAnnotation, getDataStatus, setBrandNames} from "../db/store";
import {syncState} from "../sync/sync";
import {
  analyzePageForSite,
  explainTrafficChangeForSite,
  findCannibalizationForSite,
  findDecayingPagesForSite,
  findLowCtrForSite,
  findQueryChangesForSite,
  findStrikingDistanceForSite,
  generateSeoReportForSite,
  getIndexingIssuesForSite,
  getSiteOverview,
  getSitemapStatusForSite,
  getWeeklyActionPlanForSite,
  type InsightResult,
} from "./analysis";
import {listSites, resolveSite, ToolError} from "./context";

const siteArg = z.string().max(300).optional()
  .describe("Site to analyze: domain (example.com) or Search Console property (sc-domain:example.com, https://example.com/). Optional if only one site is available.");
const periodArgs = {
  period: z.enum(["last_7d", "last_28d", "last_3m"]).optional()
    .describe("Analysis period ending on the last day with Search Console data."),
  compare: z.enum(["previous_period", "previous_year"]).optional()
    .describe("What to compare with. Default: previous_period."),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Custom period start (YYYY-MM-DD); use with end."),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Custom period end (YYYY-MM-DD); use with start."),
};
const limitArg = z.number().int().min(1).max(100).optional().describe("Maximum number of items to return (default 20).");

// Common structuredContent shape: summary + evidence + actions
const insightOutputSchema = z.object({summary: z.string(), site: z.string().optional()}).passthrough();

const READ_ONLY = {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false} as const;
const LOCAL_WRITE = {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false} as const;

function toToolResult(result: InsightResult | {summary: string; [key: string]: unknown}, text?: string): CallToolResult {
  return {
    content: [{type: "text", text: text ?? `${result.summary}\n\n${JSON.stringify(result)}`}],
    structuredContent: result,
  };
}

function errorResult(message: string): CallToolResult {
  return {isError: true, content: [{type: "text", text: message}]};
}

/** Turns expected errors into readable tool errors and logs unexpected ones. */
function guarded<Args>(tool: string, handler: (args: Args) => Promise<CallToolResult>): (args: Args) => Promise<CallToolResult> {
  return async (args: Args) => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof ToolError) return errorResult(error.message);
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[mcp] tool ${tool} failed: ${message}`);
      return errorResult(`The request failed: ${message}`);
    }
  };
}

export function registerTools(server: McpServer): void {
  server.registerTool("list_sites", {
    title: "List Search Console sites",
    description: "Lists the Search Console properties available to this server with their import status. Call first when the user has several sites or doesn't name one.",
    inputSchema: {},
    outputSchema: insightOutputSchema,
    annotations: READ_ONLY,
  }, guarded("list_sites", async () => {
    const [sites, status] = await Promise.all([listSites(), getDataStatus()]);
    return toToolResult({
      summary: sites.length
        ? `${sites.length} site(s) available: ${sites.map((site) => site.displayName).join(", ")}.`
        : "No sites yet. Add the service account email as a user to your Search Console property and wait for the sync.",
      items: sites.map((site) => {
        const data = status.get(site.siteUrl);
        const sync = syncState.sites.get(site.siteUrl);
        return {
          site: site.displayName,
          searchConsoleProperty: site.siteUrl,
          permissionLevel: site.permissionLevel,
          dataReady: site.dataReady,
          daysLoaded: data?.daysLoaded ?? 0,
          firstDate: data?.firstDate ?? null,
          lastDate: data?.lastDate ?? null,
          importInProgress: sync?.status === "running",
          brandNames: site.brandNames,
        };
      }),
    });
  }));

  server.registerTool("get_site_overview", {
    title: "Site performance overview",
    description: "Clicks, impressions, CTR and average position for a period vs the previous period and a year ago, plus the top growing and declining pages. Use for 'How is my site doing?'.",
    inputSchema: {site: siteArg, ...periodArgs},
    outputSchema: insightOutputSchema,
    annotations: READ_ONLY,
  }, guarded("get_site_overview", async (args) => toToolResult(await getSiteOverview(await resolveSite(args.site), args))));

  server.registerTool("explain_traffic_change", {
    title: "Explain a traffic change",
    description: "Answers 'Why did my organic traffic drop (or grow)?'. Finds when the change started, which pages, queries, devices, countries and branded/non-branded traffic drove it, " +
      "whether the cause is rankings, search demand or CTR, checks seasonality against last year, annotations and indexing of the declining pages. Default period: last 7 days vs the previous 7.",
    inputSchema: {site: siteArg, ...periodArgs},
    outputSchema: insightOutputSchema,
    annotations: READ_ONLY,
  }, guarded("explain_traffic_change", async (args) =>
    toToolResult(await explainTrafficChangeForSite(await resolveSite(args.site), args))));

  server.registerTool("find_decaying_pages", {
    title: "Find pages losing clicks",
    description: "Pages whose weekly clicks dropped over the last weeks, classified as sudden_drop, gradual_decay or seasonal (a similar drop last year), sorted by lost clicks per week.",
    inputSchema: {
      site: siteArg,
      weeks: z.number().int().min(8).max(26).optional().describe("How many weeks of history to analyze (default 12)."),
      limit: limitArg,
    },
    outputSchema: insightOutputSchema,
    annotations: READ_ONLY,
  }, guarded("find_decaying_pages", async (args) =>
    toToolResult(await findDecayingPagesForSite(await resolveSite(args.site), args))));

  server.registerTool("find_striking_distance", {
    title: "Find keywords close to the top 3",
    description: "Queries ranking on positions 4–15 (configurable) with real demand, ranked by the extra clicks the top 3 would bring. Includes the ranking page for each query.",
    inputSchema: {
      site: siteArg,
      ...periodArgs,
      min_position: z.number().min(2).max(50).optional().describe("Lowest position to include (default 4)."),
      max_position: z.number().min(2).max(100).optional().describe("Highest position to include (default 15)."),
      limit: limitArg,
    },
    outputSchema: insightOutputSchema,
    annotations: READ_ONLY,
  }, guarded("find_striking_distance", async (args) =>
    toToolResult(await findStrikingDistanceForSite(await resolveSite(args.site), {
      ...args,
      minPosition: args.min_position,
      maxPosition: args.max_position,
    }))));

  server.registerTool("find_cannibalization", {
    title: "Find keyword cannibalization",
    description: "Queries where several pages of the site split impressions, with the winning page, how often the ranking page flip-flops day to day, severity and a recommendation (consolidate, differentiate, canonical).",
    inputSchema: {site: siteArg, ...periodArgs, limit: limitArg},
    outputSchema: insightOutputSchema,
    annotations: READ_ONLY,
  }, guarded("find_cannibalization", async (args) =>
    toToolResult(await findCannibalizationForSite(await resolveSite(args.site), args))));

  server.registerTool("find_low_ctr_pages", {
    title: "Find top rankings with low CTR",
    description: "Top-5 rankings whose click-through rate is far below what this site normally gets at that position — candidates for rewriting titles and meta descriptions or signs of SERP features / AI Overviews.",
    inputSchema: {site: siteArg, ...periodArgs, limit: limitArg},
    outputSchema: insightOutputSchema,
    annotations: READ_ONLY,
  }, guarded("find_low_ctr_pages", async (args) =>
    toToolResult(await findLowCtrForSite(await resolveSite(args.site), args))));

  server.registerTool("find_query_changes", {
    title: "Find new or lost queries",
    description: "type=new: queries that started getting impressions in the period (emerging topics). type=lost: queries that lost at least 80% of their clicks.",
    inputSchema: {site: siteArg, type: z.enum(["new", "lost"]), ...periodArgs, limit: limitArg},
    outputSchema: insightOutputSchema,
    annotations: READ_ONLY,
  }, guarded("find_query_changes", async (args) =>
    toToolResult(await findQueryChangesForSite(await resolveSite(args.site), args))));

  server.registerTool("analyze_page", {
    title: "Analyze a page",
    description: "Deep dive into one page: trend vs previous period, top queries, queries that lost clicks, striking-distance queries, cannibalization with other pages and the latest indexing status.",
    inputSchema: {
      site: siteArg,
      url: z.string().url().max(2048).describe("Full page URL as it appears in Search Console."),
      ...periodArgs,
    },
    outputSchema: insightOutputSchema,
    annotations: READ_ONLY,
  }, guarded("analyze_page", async (args) =>
    toToolResult(await analyzePageForSite(await resolveSite(args.site), args))));

  server.registerTool("get_weekly_action_plan", {
    title: "What to work on this week",
    description: "Answers 'What pages should I update this week?'. Combines indexing problems, decaying pages, striking-distance keywords, low-CTR snippets and cannibalization into a ranked task list with the expected clicks per week, why and what to do.",
    inputSchema: {
      site: siteArg,
      capacity: z.number().int().min(1).max(20).optional().describe("How many tasks to return (default 5)."),
    },
    outputSchema: insightOutputSchema,
    annotations: READ_ONLY,
  }, guarded("get_weekly_action_plan", async (args) =>
    toToolResult(await getWeeklyActionPlanForSite(await resolveSite(args.site), args))));

  server.registerTool("generate_seo_report", {
    title: "Generate an SEO report",
    description: "Creates a ready-to-share markdown SEO report: key metrics vs previous period and last year, what changed and why, biggest movers, indexing status and next week's plan. Default: last 7 days.",
    inputSchema: {
      site: siteArg,
      ...periodArgs,
      audience: z.enum(["owner", "seo"]).optional().describe("owner = short business summary (default); seo = adds the detailed change drivers table."),
    },
    outputSchema: insightOutputSchema,
    annotations: READ_ONLY,
  }, guarded("generate_seo_report", async (args) => {
    const result = await generateSeoReportForSite(await resolveSite(args.site), args);
    return toToolResult(result, String(result.markdown));
  }));

  server.registerTool("get_indexing_issues", {
    title: "Indexing issues",
    description: "Pages Google doesn't index and why (from URL Inspection checks of the most important pages), pages that lost traffic because of it first, with an explanation key per issue.",
    inputSchema: {site: siteArg, limit: limitArg},
    outputSchema: insightOutputSchema,
    annotations: READ_ONLY,
  }, guarded("get_indexing_issues", async (args) =>
    toToolResult(await getIndexingIssuesForSite(await resolveSite(args.site), args))));

  server.registerTool("get_sitemap_status", {
    title: "Sitemap status",
    description: "Sitemaps registered in Search Console with errors, warnings, when Google last read them and detected problems.",
    inputSchema: {site: siteArg},
    outputSchema: insightOutputSchema,
    annotations: {...READ_ONLY, openWorldHint: true},
  }, guarded("get_sitemap_status", async (args) =>
    toToolResult(await getSitemapStatusForSite(await resolveSite(args.site)))));

  server.registerTool("add_annotation", {
    title: "Add an annotation",
    description: "Records an event on the site timeline (e.g. 'Updated product page titles', 'Site migration') so later traffic analysis can take it into account. Stored locally, nothing is sent to Google.",
    inputSchema: {
      site: siteArg,
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Event date (YYYY-MM-DD)."),
      title: z.string().min(1).max(120),
      description: z.string().max(1000).optional(),
    },
    outputSchema: insightOutputSchema,
    annotations: LOCAL_WRITE,
  }, guarded("add_annotation", async (args) => {
    const site = await resolveSite(args.site);
    const annotation = await addAnnotation(site.siteUrl, args.date, args.title, args.description ?? "");
    return toToolResult({
      summary: `Annotation "${args.title}" added for ${site.displayName} on ${args.date}.`,
      site: site.displayName,
      annotationId: annotation.id,
    });
  }));

  server.registerTool("set_brand_names", {
    title: "Set brand names",
    description: "Sets the brand terms of a site (e.g. its name and common misspellings). explain_traffic_change and reports then split traffic into branded and non-branded. Stored locally.",
    inputSchema: {
      site: siteArg,
      brand_names: z.array(z.string().min(2).max(100)).max(20).describe("Brand terms, matched case-insensitively as substrings of queries."),
    },
    outputSchema: insightOutputSchema,
    annotations: {...LOCAL_WRITE, idempotentHint: true},
  }, guarded("set_brand_names", async (args) => {
    const site = await resolveSite(args.site);
    const brandNames = Array.from(new Set(args.brand_names.map((name) => name.trim().toLowerCase()).filter(Boolean)));
    await setBrandNames(site.siteUrl, brandNames);
    return toToolResult({
      summary: brandNames.length
        ? `Brand names for ${site.displayName}: ${brandNames.join(", ")}.`
        : `Brand names for ${site.displayName} cleared.`,
      site: site.displayName,
      brandNames,
    });
  }));
}
