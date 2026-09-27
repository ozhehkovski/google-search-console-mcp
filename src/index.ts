import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {migrate, waitForClickhouse} from "./db/clickhouse";
import {discoverSites, runSync, startScheduler, syncState} from "./sync/sync";
import {startHttpServer} from "./http/server";
import {createMcpServer} from "./mcp/server";
import {DEMO_SITE, loadDemoData} from "./sync/demo";

const USAGE = `Usage: node dist/index.js <command>

Commands:
  serve          HTTP MCP server on /mcp, status page on /, scheduled sync (default)
  stdio          MCP over stdin/stdout (for clients that launch the server as a process)
  sync [site]    Import missing Search Console data once and exit (while the server is stopped)
  sites          List the Search Console properties the service account can read
  demo           Load a synthetic demo site (no Google key needed) to try the tools`;

async function main(): Promise<void> {
  const [command = "serve", argument] = process.argv.slice(2);

  switch (command) {
    case "serve": {
      await waitForClickhouse();
      await migrate();
      await startHttpServer();
      startScheduler();
      return;
    }
    case "stdio": {
      // stdout is the protocol channel: send logs to stderr
      console.log = (...args: unknown[]) => console.error(...args);
      await waitForClickhouse();
      await migrate();
      const server = createMcpServer();
      await server.connect(new StdioServerTransport());
      return;
    }
    case "sync": {
      await waitForClickhouse();
      await migrate();
      await runSync({site: argument});
      if (syncState.error) throw new Error(syncState.error);
      process.exit(Array.from(syncState.sites.values()).some((site) => site.status === "error") ? 1 : 0);
      return;
    }
    case "sites": {
      await waitForClickhouse();
      await migrate();
      const sites = await discoverSites();
      for (const site of sites) console.log(`${site.siteUrl}\t${site.permissionLevel}`);
      if (sites.length === 0) console.log("No properties. Add the service account email as a user in Search Console.");
      process.exit(0);
      return;
    }
    case "demo": {
      await waitForClickhouse();
      await migrate();
      const rows = await loadDemoData();
      console.log(`Loaded ${rows} rows for ${DEMO_SITE}. Ask your agent about "demo-store.example".`);
      process.exit(0);
      return;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      process.exit(2);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
