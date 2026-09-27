import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {GetPromptResult} from "@modelcontextprotocol/sdk/types.js";
import {z} from "zod";

const siteArg = z.string().optional().describe("Site domain; optional when only one site is available.");

function siteHint(site?: string): string {
  return site ? ` Use site="${site}" in every tool call.` : " If several sites are available, call list_sites first and ask which one to use.";
}

function userPrompt(text: string): GetPromptResult {
  return {messages: [{role: "user", content: {type: "text", text}}]};
}

/** Ready-made workflows: MCP hosts show them as commands; every step is a tool call */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt("weekly_seo_report", {
    title: "Weekly SEO report",
    description: "A complete weekly report with what changed, why, and a plan for next week.",
    argsSchema: {site: siteArg},
  }, ({site}) => userPrompt(
    `Create my weekly SEO report.${siteHint(site)}\n` +
    "1. Call generate_seo_report (period last_7d, audience owner).\n" +
    "2. If traffic changed by more than 10%, call explain_traffic_change for the same period and add a short 'Why it changed' section.\n" +
    "3. Present the report markdown as is, then end with the top 3 tasks from its plan in plain language.\n" +
    "Don't invent numbers — only use values returned by the tools.",
  ));

  server.registerPrompt("investigate_traffic_drop", {
    title: "Investigate a traffic drop",
    description: "Find when organic traffic dropped, what was affected and the likely cause.",
    argsSchema: {site: siteArg, period: z.enum(["last_7d", "last_28d", "last_3m"]).optional().describe("Period to investigate (default last_7d).")},
  }, ({site, period}) => userPrompt(
    `Why did my organic traffic drop?${siteHint(site)}\n` +
    `1. Call explain_traffic_change with period=${period ?? "last_7d"}. Note the start date, primary cause and top drivers.\n` +
    "2. Call explain_traffic_change again with compare=previous_year to rule out seasonality.\n" +
    "3. For the two pages that lost the most clicks, call analyze_page.\n" +
    "4. Call get_indexing_issues and check whether the declining pages are affected.\n" +
    "Answer with: when it started, what was affected (pages / queries / devices / countries), the most likely cause with evidence, and 3 concrete actions.",
  ));

  server.registerPrompt("striking_distance_sprint", {
    title: "Top-3 sprint",
    description: "Pick keywords ranking 4–15 and plan how to push them into the top 3.",
    argsSchema: {site: siteArg},
  }, ({site}) => userPrompt(
    `Find keywords ranking 4–15 that I can push into the top 3.${siteHint(site)}\n` +
    "1. Call find_striking_distance (period last_28d).\n" +
    "2. For the 3 queries with the highest potentialExtraClicks call analyze_page on their pages.\n" +
    "3. For each: recommend title/H1 changes, content to add for the query intent, and which pages should link to it. Check that the page doesn't compete with another page (cannibalization section).\n" +
    "Output a table: query, page, position, extra clicks, what to change.",
  ));

  server.registerPrompt("cannibalization_cleanup", {
    title: "Cannibalization cleanup",
    description: "Find pages competing for the same keywords and decide what to merge or differentiate.",
    argsSchema: {site: siteArg},
  }, ({site}) => userPrompt(
    `Find keyword cannibalization and tell me how to fix it.${siteHint(site)}\n` +
    "1. Call find_cannibalization.\n" +
    "2. For each high-severity case explain which page should own the query and why (position, CTR, clicks), and apply its recommendation: consolidate (merge + 301), differentiate (separate intents) or canonical.\n" +
    "Output a prioritized list with the exact URLs to change.",
  ));

  server.registerPrompt("content_refresh_plan", {
    title: "Content refresh plan",
    description: "Pages losing clicks and snippets that under-perform, with a refresh brief for each.",
    argsSchema: {site: siteArg},
  }, ({site}) => userPrompt(
    `Which pages should I update this week and how?${siteHint(site)}\n` +
    "1. Call get_weekly_action_plan with capacity 5.\n" +
    "2. For each refresh_content or push_to_top3 task call analyze_page to get the lost and striking-distance queries.\n" +
    "3. Write a short brief per page: queries to cover, sections to add or update, title/meta suggestion, internal links to add.\n" +
    "Keep it actionable; don't invent metrics.",
  ));

  server.registerPrompt("indexing_audit", {
    title: "Indexing audit",
    description: "Pages Google doesn't index, sitemap health and what to fix first.",
    argsSchema: {site: siteArg},
  }, ({site}) => userPrompt(
    `Audit indexing of my site.${siteHint(site)}\n` +
    "1. Call get_indexing_issues.\n" +
    "2. Call get_sitemap_status.\n" +
    "3. Group problems: critical (not indexed pages that had traffic), canonical issues, blocked pages (noindex / robots.txt), low-priority exclusions, sitemap problems.\n" +
    "For each group give the pages and the fix.",
  ));
}
