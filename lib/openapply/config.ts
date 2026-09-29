import { OpenApplyError } from "./errors";

export type OpenApplyConfig = {
  /** Tenant origin, e.g. https://ksimontenegro.openapply.com */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
};

type Env = Record<string, string | undefined>;

function unquote(value: string) {
  return value.trim().replace(/^["']|["']$/g, "").trim();
}

function dryRunValue(env: Env) {
  const raw = env.OPENAPPLY_DRY_RUN;
  if (raw === undefined) return undefined;
  // Tolerate a whole `.env` line pasted into the value box ("OPENAPPLY_DRY_RUN=false").
  return unquote(unquote(raw).replace(/^OPENAPPLY_DRY_RUN\s*=\s*/i, "")).toLowerCase();
}

let warnedAboutDryRun = false;

/** Live submissions happen only when OPENAPPLY_DRY_RUN is exactly "false" (case-insensitive). */
export function isDryRun(env: Env = process.env) {
  const value = dryRunValue(env);
  const dryRun = value !== "false";
  if (dryRun && value !== undefined && value !== "true" && !warnedAboutDryRun) {
    warnedAboutDryRun = true;
    console.warn(
      JSON.stringify({
        evt: "openapply.config",
        message: 'OPENAPPLY_DRY_RUN is set but is not "false", so submissions run in test mode.',
        value: value.slice(0, 40),
      }),
    );
  }
  return dryRun;
}

/** Accepts the tenant root with or without scheme, trailing slash, /api/v3 or /oauth/token. */
export function normalizeBaseUrl(raw: string | undefined) {
  const value = raw ? unquote(raw) : "";
  if (!value) throw new OpenApplyError("config", "OPENAPPLY_BASE_URL is not set.", { step: "config" });
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new OpenApplyError("config", "OPENAPPLY_BASE_URL is not a valid URL.", { step: "config" });
  }
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new OpenApplyError("config", "OPENAPPLY_BASE_URL must use https.", { step: "config" });
  }
  const path = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/(api\/v3|oauth\/token)$/i, "")
    .replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

export function readConfig(env: Env = process.env): OpenApplyConfig {
  const baseUrl = normalizeBaseUrl(env.OPENAPPLY_BASE_URL);
  const clientId = env.OPENAPPLY_CLIENT_ID ? unquote(env.OPENAPPLY_CLIENT_ID) : "";
  const clientSecret = env.OPENAPPLY_CLIENT_SECRET ? unquote(env.OPENAPPLY_CLIENT_SECRET) : "";
  if (!clientId || !clientSecret) {
    throw new OpenApplyError("config", "OPENAPPLY_CLIENT_ID and OPENAPPLY_CLIENT_SECRET must be set.", { step: "config" });
  }
  return { baseUrl, clientId, clientSecret };
}
