import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import {timingSafeEqual} from "node:crypto";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {getConfig} from "../config";
import {saveServiceAccountKey} from "../google/auth";
import {createMcpServer} from "../mcp/server";
import {runSync, syncState} from "../sync/sync";
import {getStatusReport, renderStatusPage} from "./status";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {"Content-Type": "application/json"});
  res.end(JSON.stringify(body));
}

/** With MCP_AUTH_TOKEN set, /mcp and the write endpoints require "Authorization: Bearer <token>". */
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (!token) return true;
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1].trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    // Stateless server: no server-initiated streams and no sessions to delete
    res.writeHead(405, {"Content-Type": "application/json", Allow: "POST"});
    res.end(JSON.stringify({jsonrpc: "2.0", error: {code: -32000, message: "Method not allowed."}, id: null}));
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    sendJson(res, 400, {jsonrpc: "2.0", error: {code: -32700, message: "Parse error"}, id: null});
    return;
  }
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const {authToken} = getConfig();
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (path === "/healthz") {
    sendJson(res, 200, {ok: true});
    return;
  }

  if (path === "/mcp") {
    if (!isAuthorized(req.headers.authorization, authToken)) {
      res.writeHead(401, {"Content-Type": "application/json", "WWW-Authenticate": "Bearer"});
      res.end(JSON.stringify({error: "unauthorized"}));
      return;
    }
    await handleMcp(req, res);
    return;
  }

  if (path === "/" && req.method === "GET") {
    res.writeHead(200, {"Content-Type": "text/html; charset=utf-8"});
    res.end(renderStatusPage(await getStatusReport()));
    return;
  }

  if (path === "/api/status" && req.method === "GET") {
    sendJson(res, 200, await getStatusReport());
    return;
  }

  if (path.startsWith("/api/") && req.method === "POST") {
    if (!isAuthorized(req.headers.authorization, authToken)) {
      sendJson(res, 401, {error: "Unauthorized: pass MCP_AUTH_TOKEN."});
      return;
    }
    if (path === "/api/credentials") {
      try {
        const key = await saveServiceAccountKey(await readBody(req));
        void runSync();
        sendJson(res, 200, {ok: true, clientEmail: key.client_email});
      } catch (error) {
        if (error instanceof HttpError) throw error;
        sendJson(res, 400, {error: error instanceof Error ? error.message : String(error)});
      }
      return;
    }
    if (path === "/api/sync") {
      if (syncState.running) {
        sendJson(res, 409, {error: "A sync is already running."});
        return;
      }
      void runSync();
      sendJson(res, 202, {ok: true});
      return;
    }
  }

  sendJson(res, 404, {error: "not_found"});
}

export function startHttpServer(): Promise<void> {
  const {port, host, publicUrl} = getConfig();
  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(`[http] ${req.method} ${req.url} failed:`, error);
      if (!res.headersSent) sendJson(res, status, {error: error instanceof Error ? error.message : "Internal error"});
      else res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`[http] status page ${publicUrl}  ·  MCP endpoint ${publicUrl}/mcp`);
      resolve();
    });
  });
}
