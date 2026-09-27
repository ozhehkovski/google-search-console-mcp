import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {registerPrompts} from "./prompts";
import {registerTools} from "./tools";

export const SERVER_NAME = "google-search-console";
export const SERVER_VERSION = "1.0.0";

const INSTRUCTIONS = `This server answers SEO questions using the user's Google Search Console data, synced into a local database.
Prefer the specific tools over general reasoning: explain_traffic_change for drops, find_decaying_pages, find_striking_distance,
find_cannibalization, find_low_ctr_pages, get_weekly_action_plan, generate_seo_report. Every result contains a summary, the evidence
(items) and often actions — base your answer on them and never invent numbers. Search Console data has a 2–3 day delay.`;

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {name: SERVER_NAME, title: "Google Search Console", version: SERVER_VERSION},
    {instructions: INSTRUCTIONS, capabilities: {tools: {}, prompts: {}}},
  );
  registerTools(server);
  registerPrompts(server);
  return server;
}
