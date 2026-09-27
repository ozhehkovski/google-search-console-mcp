import {createClient, type ClickHouseClient} from "@clickhouse/client";
import {getConfig} from "../config";
import {SCHEMA} from "./schema";

const QUERY_TIMEOUT_SECONDS = 30;

let client: ClickHouseClient | null = null;

export function ch(): ClickHouseClient {
  if (!client) {
    const {clickhouse} = getConfig();
    client = createClient({
      url: clickhouse.url,
      username: clickhouse.username,
      password: clickhouse.password,
      database: clickhouse.database,
      request_timeout: 120_000,
    });
  }
  return client;
}

export type Row = Record<string, unknown>;

export async function query<T extends Row>(sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const result = await ch().query({
    query: sql,
    query_params: params,
    format: "JSONEachRow",
    clickhouse_settings: {max_execution_time: QUERY_TIMEOUT_SECONDS},
  });
  return result.json<T>();
}

export async function command(sql: string, params: Record<string, unknown> = {}): Promise<void> {
  await ch().command({query: sql, query_params: params});
}

export async function insert<T extends Row>(table: string, values: T[]): Promise<void> {
  if (values.length === 0) return;
  await ch().insert({table, values, format: "JSONEachRow"});
}

export function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Creates the database and tables. Safe to run on every start. */
export async function migrate(): Promise<void> {
  const {clickhouse} = getConfig();
  const bootstrap = createClient({url: clickhouse.url, username: clickhouse.username, password: clickhouse.password});
  try {
    await bootstrap.command({query: `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(clickhouse.database)}`});
  } finally {
    await bootstrap.close();
  }
  for (const statement of SCHEMA) {
    await command(statement);
  }
}

/** Waits until ClickHouse answers, so the app can start together with the database container. */
export async function waitForClickhouse(timeoutMs = 60_000): Promise<void> {
  const {clickhouse} = getConfig();
  const probe = createClient({url: clickhouse.url, username: clickhouse.username, password: clickhouse.password});
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const {success} = await probe.ping();
      if (success) return;
      if (Date.now() > deadline) throw new Error(`ClickHouse is not reachable at ${clickhouse.url}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    await probe.close();
  }
}

function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid ClickHouse database name: ${name}`);
  }
  return name;
}
