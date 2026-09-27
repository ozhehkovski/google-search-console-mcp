import {readFile, stat, writeFile, mkdir} from "node:fs/promises";
import {dirname} from "node:path";
import {google} from "googleapis";
import {getConfig} from "../config";

// Read-only access is enough for Search Analytics, sitemaps and URL Inspection.
export const GSC_SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];

export type ServiceAccountKey = {
  type: "service_account";
  project_id?: string;
  client_email: string;
  private_key: string;
};

export type CredentialsStatus =
  | {ok: true; clientEmail: string; projectId: string | null}
  | {ok: false; reason: "missing" | "invalid"; message: string};

export type GoogleAuth = InstanceType<typeof google.auth.GoogleAuth>;

/** Validates the JSON key downloaded from Google Cloud Console → IAM → Service accounts → Keys. */
export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  const key = data as Partial<ServiceAccountKey> & {type?: string; installed?: unknown; web?: unknown};
  if (key.installed || key.web) {
    throw new Error("This is an OAuth client file. Create a service account key instead (IAM → Service accounts → Keys → Add key → JSON).");
  }
  if (key.type !== "service_account" || typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    throw new Error('Expected a service account key with "type": "service_account", "client_email" and "private_key".');
  }
  return {type: "service_account", project_id: key.project_id, client_email: key.client_email, private_key: key.private_key};
}

let cache: {mtimeMs: number; auth: GoogleAuth; key: ServiceAccountKey} | null = null;

async function loadKey(): Promise<{auth: GoogleAuth; key: ServiceAccountKey}> {
  const path = getConfig().credentialsPath;
  const info = await stat(path);
  // Re-read the key when it is replaced (e.g. uploaded from the status page)
  if (cache && cache.mtimeMs === info.mtimeMs) return cache;
  const key = parseServiceAccountKey(await readFile(path, "utf8"));
  const auth = new google.auth.GoogleAuth({
    credentials: {client_email: key.client_email, private_key: key.private_key},
    scopes: GSC_SCOPES,
  });
  cache = {mtimeMs: info.mtimeMs, auth, key};
  return cache;
}

export async function getGoogleAuth(): Promise<GoogleAuth> {
  try {
    return (await loadKey()).auth;
  } catch (error) {
    throw new CredentialsError(await describeCredentialsProblem(error));
  }
}

export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsError";
  }
}

async function describeCredentialsProblem(error: unknown): Promise<string> {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") {
    return `Google service account key not found at ${getConfig().credentialsPath}. Put the JSON key there or upload it at ${getConfig().publicUrl}.`;
  }
  return `Google service account key is invalid: ${error instanceof Error ? error.message : String(error)}`;
}

export async function getCredentialsStatus(): Promise<CredentialsStatus> {
  try {
    const {key} = await loadKey();
    return {ok: true, clientEmail: key.client_email, projectId: key.project_id ?? null};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === "ENOENT"
      ? {ok: false, reason: "missing", message: await describeCredentialsProblem(error)}
      : {ok: false, reason: "invalid", message: await describeCredentialsProblem(error)};
  }
}

/** Validates and stores an uploaded key; returns the service account email to add in Search Console. */
export async function saveServiceAccountKey(raw: string): Promise<ServiceAccountKey> {
  const key = parseServiceAccountKey(raw);
  const path = getConfig().credentialsPath;
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, JSON.stringify(key, null, 2), {mode: 0o600});
  cache = null;
  return key;
}
