import type { OpenApplyConfig } from "./config";
import { extractApiErrors, OpenApplyError, type OpenApplyStep } from "./errors";

/**
 * OpenApply allows 5 requests per 2 seconds per client and answers 429 with
 * `x-ratelimit-limit`, `x-ratelimit-period` and `x-ratelimit-reset: YYYY-MM-DD HH:MM:SS UTC`.
 * Requests are paced below that (the margin absorbs network jitter) and a 429 pauses every
 * queued request until the reset time.
 */
export type RateLimitOptions = {
  limit: number;
  windowMs: number;
  marginMs: number;
  /** Wait after a 429 that carries no usable reset header. */
  fallbackWaitMs: number;
  maxWaitMs: number;
};

export const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  limit: 5,
  windowMs: 2000,
  marginMs: 300,
  fallbackWaitMs: 2000,
  maxWaitMs: 5000,
};

export type Deadline = { readonly at: number };

export function deadlineIn(ms: number): Deadline {
  return { at: Date.now() + ms };
}

export type RequestStats = { calls: number; retries: number; rateLimited: number };

export type RequestContext = {
  deadline: Deadline;
  stats: RequestStats;
  /** Submitted values that must never appear in logged OpenApply messages. */
  redact: readonly string[];
};

export type RequestSpec = {
  step: OpenApplyStep;
  method: "GET" | "POST" | "PUT" | "PATCH";
  /** Path including any query string. */
  path: string;
  /** Path template used in errors and logs. */
  template: string;
  body?: unknown;
  /** Safe to resend after a timeout or 5xx (reads and full-state writes). Creates are not. */
  idempotent: boolean;
};

export type ClientOptions = {
  fetch?: typeof fetch;
  rateLimit?: Partial<RateLimitOptions>;
  timeoutMs?: number;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class TimeoutError extends Error {}

export function parseRateLimitReset(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{9,11}$/.test(trimmed)) return Number(trimmed) * 1000;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?\s*(?:UTC|Z|GMT|\+00:?00)?$/i.exec(trimmed);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    fraction ? Math.round(Number(fraction) * 1000) : 0,
  );
}

export function retryDelayFor429(headers: Headers, now: number, options: RateLimitOptions) {
  const jitter = 100 + Math.floor(Math.random() * 300);
  const reset = parseRateLimitReset(headers.get("x-ratelimit-reset"));
  let wait: number;
  if (reset !== null) {
    wait = reset - now + jitter;
  } else {
    const retryAfter = Number(headers.get("retry-after"));
    const period = Number(headers.get("x-ratelimit-period"));
    const base = retryAfter > 0 ? retryAfter * 1000 : period > 0 ? period * 1000 : options.fallbackWaitMs;
    wait = base + jitter;
  }
  return Math.min(Math.max(wait, 250), options.maxWaitMs);
}

/** FIFO sliding-log limiter shared by every request made through one client (one server instance). */
export class RateLimiter {
  private starts: number[] = [];
  private blockedUntil = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: RateLimitOptions) {}

  acquire(deadline: Deadline, step: OpenApplyStep): Promise<void> {
    const turn = this.tail.then(() => this.waitForSlot(deadline, step));
    this.tail = turn.catch(() => undefined);
    return turn;
  }

  /** Holds every queued request until `until` (epoch ms), e.g. after a 429. */
  block(until: number) {
    this.blockedUntil = Math.max(this.blockedUntil, until);
  }

  private async waitForSlot(deadline: Deadline, step: OpenApplyStep) {
    const horizon = this.options.windowMs + this.options.marginMs;
    for (;;) {
      const now = Date.now();
      this.starts = this.starts.filter((start) => now - start < horizon);
      let readyAt = this.blockedUntil;
      if (this.starts.length >= this.options.limit) {
        readyAt = Math.max(readyAt, this.starts[this.starts.length - this.options.limit] + horizon);
      }
      if (readyAt <= now) {
        this.starts.push(now);
        return;
      }
      if (readyAt > deadline.at) {
        throw new OpenApplyError("budget", "Ran out of time waiting for the OpenApply rate limit.", { step });
      }
      await sleep(readyAt - now);
    }
  }
}

type JsonResult = { ok: true; value: unknown } | { ok: false };

function parseJson(text: string): JsonResult {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

const MAX_TRANSIENT_RETRIES = 2;
const MAX_RATE_LIMIT_RETRIES = 8;

function backoffMs(failures: number) {
  return (failures === 1 ? 500 : 1500) + Math.floor(Math.random() * 250);
}

export class OpenApplyClient {
  readonly limiter: RateLimiter;
  private readonly rateLimit: RateLimitOptions;
  private token: { value: string; expiresAt: number } | null = null;
  private tokenRequest: Promise<string> | null = null;

  constructor(
    readonly config: OpenApplyConfig,
    private readonly options: ClientOptions = {},
  ) {
    this.rateLimit = { ...DEFAULT_RATE_LIMIT, ...options.rateLimit };
    this.limiter = new RateLimiter(this.rateLimit);
  }

  async request<T = unknown>(spec: RequestSpec, ctx: RequestContext): Promise<T> {
    let failures = 0;
    let rateLimited = 0;
    let refreshedToken = false;
    for (;;) {
      const token = await this.accessToken(ctx);
      await this.limiter.acquire(ctx.deadline, spec.step);
      ctx.stats.calls += 1;

      let response: Response;
      try {
        response = await this.send(
          `${this.config.baseUrl}${spec.path}`,
          {
            method: spec.method,
            headers: {
              accept: "application/json",
              authorization: `Bearer ${token}`,
              ...(spec.body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
          },
          ctx,
          spec.method === "POST" ? 15_000 : 10_000,
        );
      } catch (error) {
        const kind = error instanceof TimeoutError ? "timeout" : "network";
        if (spec.idempotent && failures < MAX_TRANSIENT_RETRIES && this.hasTime(ctx, backoffMs(failures + 1))) {
          failures += 1;
          ctx.stats.retries += 1;
          await sleep(backoffMs(failures));
          continue;
        }
        throw new OpenApplyError(kind, kind === "timeout" ? "OpenApply did not respond in time." : "Could not reach OpenApply.", {
          step: spec.step,
          method: spec.method,
          path: spec.template,
          ambiguous: !spec.idempotent,
        });
      }

      const text = await response.text().catch(() => "");
      const requestId = response.headers.get("x-request-id") ?? undefined;

      if (response.status === 429) {
        rateLimited += 1;
        ctx.stats.rateLimited += 1;
        const wait = retryDelayFor429(response.headers, Date.now(), this.rateLimit);
        this.limiter.block(Date.now() + wait);
        // A throttled request is rejected before OpenApply acts on it, so even creates can be resent.
        if (rateLimited > MAX_RATE_LIMIT_RETRIES || Date.now() + wait > ctx.deadline.at) {
          throw new OpenApplyError("rate_limited", "OpenApply kept rate-limiting requests.", {
            step: spec.step,
            method: spec.method,
            path: spec.template,
            status: 429,
            requestId,
          });
        }
        continue;
      }

      if (response.status === 401 && !refreshedToken) {
        refreshedToken = true;
        ctx.stats.retries += 1;
        this.invalidateToken(token);
        continue;
      }

      const body = parseJson(text);

      if (response.status >= 500) {
        if (spec.idempotent && failures < MAX_TRANSIENT_RETRIES && this.hasTime(ctx, backoffMs(failures + 1))) {
          failures += 1;
          ctx.stats.retries += 1;
          await sleep(backoffMs(failures));
          continue;
        }
        throw new OpenApplyError("server", `OpenApply returned ${response.status}.`, {
          step: spec.step,
          method: spec.method,
          path: spec.template,
          status: response.status,
          requestId,
          ambiguous: !spec.idempotent,
          errors: body.ok ? extractApiErrors(body.value, ctx.redact) : [],
        });
      }

      if (!response.ok) {
        throw new OpenApplyError(
          response.status === 401 || response.status === 403 ? "auth" : "rejected",
          `OpenApply rejected the request (${response.status}).`,
          {
            step: spec.step,
            method: spec.method,
            path: spec.template,
            status: response.status,
            requestId,
            errors: body.ok ? extractApiErrors(body.value, ctx.redact) : [],
          },
        );
      }

      if (!body.ok) {
        throw new OpenApplyError("invalid_response", "OpenApply returned a response that is not JSON.", {
          step: spec.step,
          method: spec.method,
          path: spec.template,
          status: response.status,
          requestId,
          ambiguous: !spec.idempotent,
        });
      }
      return body.value as T;
    }
  }

  private hasTime(ctx: RequestContext, waitMs: number) {
    return Date.now() + waitMs + 1_000 < ctx.deadline.at;
  }

  private async send(url: string, init: RequestInit, ctx: RequestContext, timeoutMs: number) {
    const remaining = ctx.deadline.at - Date.now() - 250;
    if (remaining <= 0) throw new TimeoutError("deadline");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining));
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    try {
      return await fetchImpl(url, { ...init, cache: "no-store", signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new TimeoutError("timeout");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private invalidateToken(value: string) {
    if (this.token?.value === value) this.token = null;
  }

  private accessToken(ctx: RequestContext): Promise<string> {
    if (this.token && this.token.expiresAt - 5 * 60_000 > Date.now()) return Promise.resolve(this.token.value);
    if (!this.tokenRequest) {
      this.tokenRequest = this.fetchToken(ctx).finally(() => {
        this.tokenRequest = null;
      });
    }
    return this.tokenRequest;
  }

  private async fetchToken(ctx: RequestContext): Promise<string> {
    const secrets = [this.config.clientId, this.config.clientSecret];
    let failures = 0;
    let rateLimited = 0;
    for (;;) {
      await this.limiter.acquire(ctx.deadline, "token");
      ctx.stats.calls += 1;
      let response: Response;
      try {
        response = await this.send(
          `${this.config.baseUrl}/oauth/token`,
          {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "client_credentials",
              client_id: this.config.clientId,
              client_secret: this.config.clientSecret,
            }).toString(),
          },
          ctx,
          10_000,
        );
      } catch (error) {
        if (failures < MAX_TRANSIENT_RETRIES && this.hasTime(ctx, backoffMs(failures + 1))) {
          failures += 1;
          ctx.stats.retries += 1;
          await sleep(backoffMs(failures));
          continue;
        }
        const kind = error instanceof TimeoutError ? "timeout" : "network";
        throw new OpenApplyError(kind, "Could not reach OpenApply to authenticate.", { step: "token", method: "POST", path: "/oauth/token" });
      }

      const text = await response.text().catch(() => "");
      if (response.status === 429) {
        rateLimited += 1;
        ctx.stats.rateLimited += 1;
        const wait = retryDelayFor429(response.headers, Date.now(), this.rateLimit);
        this.limiter.block(Date.now() + wait);
        if (rateLimited > MAX_RATE_LIMIT_RETRIES || Date.now() + wait > ctx.deadline.at) {
          throw new OpenApplyError("rate_limited", "OpenApply kept rate-limiting authentication.", { step: "token", status: 429 });
        }
        continue;
      }
      if (response.status >= 500 && failures < MAX_TRANSIENT_RETRIES && this.hasTime(ctx, backoffMs(failures + 1))) {
        failures += 1;
        ctx.stats.retries += 1;
        await sleep(backoffMs(failures));
        continue;
      }
      const body = parseJson(text);
      if (!response.ok) {
        throw new OpenApplyError(response.status >= 500 ? "server" : "auth", `OpenApply authentication failed (${response.status}).`, {
          step: "token",
          method: "POST",
          path: "/oauth/token",
          status: response.status,
          errors: body.ok ? extractApiErrors(body.value, secrets) : [],
        });
      }
      const payload = body.ok && body.value && typeof body.value === "object" ? (body.value as Record<string, unknown>) : {};
      if (typeof payload.access_token !== "string" || !payload.access_token) {
        throw new OpenApplyError("invalid_response", "OpenApply returned no access token.", { step: "token", status: response.status });
      }
      const expiresIn = Number(payload.expires_in) > 0 ? Number(payload.expires_in) : 3600;
      this.token = { value: payload.access_token, expiresAt: Date.now() + expiresIn * 1000 };
      return payload.access_token;
    }
  }
}
