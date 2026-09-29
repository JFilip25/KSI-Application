import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/openapply/api";
import { deadlineIn, OpenApplyClient, parseRateLimitReset, RateLimiter, retryDelayFor429, type RequestContext } from "@/lib/openapply/client";
import { readConfig } from "@/lib/openapply/config";
import { OpenApplyError } from "@/lib/openapply/errors";
import { FakeOpenApply } from "../fakes/fake-openapply";

function context(budgetMs = 50_000): RequestContext {
  return { deadline: deadlineIn(budgetMs), stats: { calls: 0, retries: 0, rateLimited: 0 }, redact: ["alex@example.com", "Alex"] };
}

function clientFor(fake: FakeOpenApply) {
  return new OpenApplyClient(readConfig(fake.env()), { fetch: fake.fetch });
}

/** Runs an async operation to completion under fake timers and returns its outcome. */
async function settle<T>(promise: Promise<T>) {
  const outcome = promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  await vi.runAllTimersAsync();
  return outcome;
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-09-29T10:00:00.000Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rate limit headers", () => {
  it("parses OpenApply's reset format", () => {
    expect(parseRateLimitReset("2026-09-29 10:29:03 UTC")).toBe(Date.UTC(2026, 8, 29, 10, 29, 3));
    expect(parseRateLimitReset("2026-09-29T10:29:03Z")).toBe(Date.UTC(2026, 8, 29, 10, 29, 3));
    expect(parseRateLimitReset("1790674143")).toBe(1_790_674_143_000);
    expect(parseRateLimitReset("soon")).toBeNull();
    expect(parseRateLimitReset(null)).toBeNull();
  });

  it("waits until the reset time and clamps odd values", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const now = Date.UTC(2026, 8, 29, 10, 29, 1, 400);
    const options = { limit: 5, windowMs: 2000, marginMs: 300, fallbackWaitMs: 2000, maxWaitMs: 5000 };
    expect(retryDelayFor429(new Headers({ "x-ratelimit-reset": "2026-09-29 10:29:03 UTC" }), now, options)).toBe(1700);
    expect(retryDelayFor429(new Headers({ "x-ratelimit-reset": "2026-09-29 10:28:00 UTC" }), now, options)).toBe(250);
    expect(retryDelayFor429(new Headers({ "x-ratelimit-reset": "2026-09-29 11:00:00 UTC" }), now, options)).toBe(5000);
    expect(retryDelayFor429(new Headers({ "x-ratelimit-period": "2" }), now, options)).toBe(2100);
    expect(retryDelayFor429(new Headers(), now, options)).toBe(2100);
  });
});

describe("RateLimiter", () => {
  it("allows five starts per 2.3 s window, in order", async () => {
    const limiter = new RateLimiter({ limit: 5, windowMs: 2000, marginMs: 300, fallbackWaitMs: 2000, maxWaitMs: 5000 });
    const deadline = deadlineIn(60_000);
    const started: number[] = [];
    const start = Date.now();
    const all = Promise.all(Array.from({ length: 11 }, (_, index) => limiter.acquire(deadline, "token").then(() => started.push(index))));
    await settle(all);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(Date.now() - start).toBe(4600);
  });

  it("holds every caller after a 429 and refuses waits past the deadline", async () => {
    const limiter = new RateLimiter({ limit: 5, windowMs: 2000, marginMs: 300, fallbackWaitMs: 2000, maxWaitMs: 5000 });
    limiter.block(Date.now() + 1500);
    const start = Date.now();
    await settle(limiter.acquire(deadlineIn(60_000), "token"));
    expect(Date.now() - start).toBe(1500);

    limiter.block(Date.now() + 10_000);
    const { error } = await settle(limiter.acquire(deadlineIn(5_000), "parent.search"));
    expect(error).toBeInstanceOf(OpenApplyError);
    expect((error as OpenApplyError).kind).toBe("budget");
  });
});

describe("OpenApplyClient", () => {
  it("paces a burst so the real limit is never hit", async () => {
    const fake = new FakeOpenApply();
    const client = clientFor(fake);
    const ctx = context();
    await settle(Promise.all(Array.from({ length: 20 }, (_, index) => api.searchParentsByEmail(client, ctx, `p${index}@example.com`))));
    expect(ctx.stats.rateLimited).toBe(0);
    expect(fake.log.filter((entry) => entry.status === 429)).toHaveLength(0);
    expect(fake.maxAcceptedInWindow()).toBeLessThanOrEqual(5);
    expect(fake.requestsTo("POST", /oauth\/token/)).toHaveLength(1);
  });

  it("resends a create after a 429 and creates exactly one record", async () => {
    const fake = new FakeOpenApply();
    fake.fail({
      method: "POST",
      path: /^\/api\/v3\/parents$/,
      respond: { status: 429, body: { error: "Rate limit exceeded" } },
    });
    const client = clientFor(fake);
    const ctx = context();
    const { value, error } = await settle(api.createParent(client, ctx, { first_name: "Alex", last_name: "Example", email: "alex@example.com" }));
    expect(error).toBeUndefined();
    expect(value?.id).toBeGreaterThan(0);
    expect(fake.parents.size).toBe(1);
    expect(ctx.stats.rateLimited).toBe(1);
  });

  it("recovers from 429s when other instances share the limit", async () => {
    const fake = new FakeOpenApply({ rateLimit: { limit: 2, periodMs: 2000 } });
    const client = clientFor(fake);
    const ctx = context();
    const { error } = await settle(Promise.all(Array.from({ length: 8 }, (_, index) => api.searchParentsByEmail(client, ctx, `p${index}@example.com`))));
    expect(error).toBeUndefined();
    expect(ctx.stats.rateLimited).toBeGreaterThan(0);
  });

  it("refreshes an expired token once", async () => {
    const fake = new FakeOpenApply();
    const client = clientFor(fake);
    await settle(api.searchParentsByEmail(client, context(), "a@example.com"));
    fake.expireTokens();
    const ctx = context();
    const { error } = await settle(api.searchParentsByEmail(client, ctx, "a@example.com"));
    expect(error).toBeUndefined();
    expect(fake.requestsTo("POST", /oauth\/token/)).toHaveLength(2);
    expect(ctx.stats.retries).toBe(1);
  });

  it("reports bad credentials as an auth error without leaking them", async () => {
    const fake = new FakeOpenApply();
    const client = new OpenApplyClient(readConfig(fake.env({ OPENAPPLY_CLIENT_SECRET: "wrong-secret" })), { fetch: fake.fetch });
    const { error } = await settle(api.searchParentsByEmail(client, context(), "a@example.com"));
    expect(error).toBeInstanceOf(OpenApplyError);
    expect((error as OpenApplyError).kind).toBe("auth");
    expect(JSON.stringify((error as OpenApplyError).toLog())).not.toContain("wrong-secret");
  });

  it("retries reads on server errors but never blindly resends a create", async () => {
    const fake = new FakeOpenApply();
    fake.fail({ method: "GET", path: /parents\/search/, respond: 503, times: 2 });
    const client = clientFor(fake);
    const ctx = context();
    expect((await settle(api.searchParentsByEmail(client, ctx, "a@example.com"))).error).toBeUndefined();
    expect(ctx.stats.retries).toBe(2);

    fake.fail({ method: "POST", path: /^\/api\/v3\/students$/, respond: "commit-then-500" });
    const { error } = await settle(api.createStudent(client, context(), { first_name: "Sam", last_name: "Example", birth_date: "2018-10-12", enrollment_year: 2026, status: "pending" }));
    expect(error).toBeInstanceOf(OpenApplyError);
    expect((error as OpenApplyError).info.ambiguous).toBe(true);
    expect(fake.requestsTo("POST", /^\/api\/v3\/students$/)).toHaveLength(1);
  });

  it("turns HTML error pages and bad JSON into clear errors", async () => {
    const fake = new FakeOpenApply();
    const client = clientFor(fake);
    fake.fail({ path: /parents\/search/, respond: "html-502", times: 3 });
    const htmlError = (await settle(api.searchParentsByEmail(client, context(), "a@example.com"))).error as OpenApplyError;
    expect(htmlError).toBeInstanceOf(OpenApplyError);
    expect(htmlError.kind).toBe("server");
    expect(htmlError.info.status).toBe(502);

    fake.fail({ path: /parents\/search/, respond: "invalid-json" });
    const jsonError = (await settle(api.searchParentsByEmail(client, context(), "a@example.com"))).error as OpenApplyError;
    expect(jsonError.kind).toBe("invalid_response");
  });

  it("times out a request that never answers", async () => {
    const fake = new FakeOpenApply();
    const client = clientFor(fake);
    fake.fail({ method: "POST", path: /^\/api\/v3\/parents$/, respond: "timeout" });
    const { error } = await settle(api.createParent(client, context(), { first_name: "A", last_name: "B", email: "a@example.com" }));
    expect((error as OpenApplyError).kind).toBe("timeout");
    expect((error as OpenApplyError).info.ambiguous).toBe(true);
  });

  it("redacts submitted values from OpenApply validation messages", async () => {
    const fake = new FakeOpenApply();
    const client = clientFor(fake);
    fake.fail({ method: "POST", path: /^\/api\/v3\/parents$/, respond: { status: 422, body: { errors: ["Email alex@example.com is invalid for Alex"] } } });
    const { error } = await settle(api.createParent(client, context(), { first_name: "Alex", last_name: "Example", email: "alex@example.com" }));
    expect((error as OpenApplyError).info.errors).toEqual(["Email [email] is invalid for [redacted]"]);
  });
});
