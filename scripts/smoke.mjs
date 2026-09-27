// Smoke test against a running server: node scripts/smoke.mjs [url] [tool] [jsonArgs]
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2] ?? "http://localhost:3333/mcp";
const token = process.env.MCP_AUTH_TOKEN;
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: token ? {headers: {Authorization: `Bearer ${token}`}} : undefined,
});
const client = new Client({name: "smoke", version: "1.0.0"});
await client.connect(transport);

const {tools} = await client.listTools();
const {prompts} = await client.listPrompts();
console.log(`tools (${tools.length}): ${tools.map((tool) => tool.name).join(", ")}`);
console.log(`prompts (${prompts.length}): ${prompts.map((prompt) => prompt.name).join(", ")}`);

const toolName = process.argv[3] ?? "list_sites";
const args = process.argv[4] ? JSON.parse(process.argv[4]) : {};
const result = await client.callTool({name: toolName, arguments: args});
console.log(`\n${toolName}${result.isError ? " (error)" : ""}:`);
console.log(result.content?.[0]?.text?.slice(0, 3000));
await client.close();
if (result.isError) process.exit(1);
