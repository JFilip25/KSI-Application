import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/applications/route";
import { makeApplication } from "../support/application";
import { FakeOpenApply } from "../fakes/fake-openapply";

function request(body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) {
  return new Request("http://localhost/api/applications", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function call(req: Request) {
  const pending = POST(req);
  await vi.runAllTimersAsync();
  const response = await pending;
  return { response, body: (await response.json()) as Record<string, unknown> };
}

let logs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-09-29T10:00:00.000Z") });
  logs = [];
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
});

function useFake(fake: FakeOpenApply, env: Record<string, string> = {}) {
  for (const [key, value] of Object.entries(fake.env(env))) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", fake.fetch);
}

describe("POST /api/applications", () => {
  it("rejects requests that are not JSON, too large or malformed", async () => {
    expect((await call(request("x", { "content-type": "text/plain" }))).response.status).toBe(415);
    expect((await call(request("{}", { "content-type": "application/json", "content-length": "200000" }))).response.status).toBe(413);
    expect((await call(request("{not json"))).response.status).toBe(400);
  });

  it("returns field errors for an invalid application", async () => {
    const { response, body } = await call(request({ ...makeApplication(), parent1: { email: "nope" } }));
    expect(response.status).toBe(400);
    expect(body.error).toBe("Please review the highlighted information.");
    expect(body.fields).toHaveProperty("parent1");
  });

  it("rejects bots", async () => {
    expect((await call(request({ ...makeApplication(), website: "spam" }))).response.status).toBe(400);
    expect((await call(request({ ...makeApplication(), startedAt: Date.now() }))).response.status).toBe(400);
  });

  it("accepts in test mode without contacting OpenApply", async () => {
    vi.stubEnv("OPENAPPLY_DRY_RUN", "true");
    const application = makeApplication();
    const { response, body } = await call(request(application));
    expect(response.status).toBe(201);
    expect(body).toEqual({ reference: application.applicationReference, dryRun: true, emailed: false });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("writes to OpenApply in live mode and returns only the reference", async () => {
    const fake = new FakeOpenApply();
    useFake(fake);
    const application = makeApplication();
    const { response, body } = await call(request(application));
    expect(response.status).toBe(201);
    expect(body).toEqual({ reference: application.applicationReference, dryRun: false, emailed: false });
    expect(fake.students.size).toBe(1);
    expect(fake.parents.size).toBe(2);
  });

  it("emails each parent through Brevo and tells the thank-you page", async () => {
    const fake = new FakeOpenApply();
    for (const [key, value] of Object.entries(fake.env({ BREVO_API_KEY: "test-key" }))) vi.stubEnv(key, value);
    const recipients: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      if (url.startsWith("https://api.brevo.com/")) {
        recipients.push(JSON.parse(String(init?.body)).to[0].email);
        return new Response(JSON.stringify({ messageId: "<m@smtp-relay.mailin.fr>" }), { status: 201 });
      }
      return fake.fetch(input, init);
    });
    const application = makeApplication();
    const { response, body } = await call(request(application));
    expect(response.status).toBe(201);
    expect(body).toEqual({ reference: application.applicationReference, dryRun: false, emailed: true });
    expect(recipients).toEqual(["alex.example@example.com", "jordan.example@example.com"]);

    // Submitting the same application again saves nothing new and sends no second email.
    const again = await call(request(application));
    expect(again.body.emailed).toBe(true);
    expect(recipients).toHaveLength(2);
  });

  it("asks the family to contact Admissions when OpenApply refuses the credentials", async () => {
    const fake = new FakeOpenApply();
    useFake(fake, { OPENAPPLY_CLIENT_SECRET: "rotated-elsewhere" });
    const application = makeApplication();
    const { response, body } = await call(request(application));
    expect(response.status).toBe(502);
    expect(String(body.error)).toContain(`quote reference ${application.applicationReference.split("-")[0].toUpperCase()}`);
  });

  it("asks the family to try again later when OpenApply is overloaded", async () => {
    const fake = new FakeOpenApply({ rateLimit: { limit: 0, periodMs: 2000 } });
    useFake(fake);
    const { response, body } = await call(request(makeApplication()));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(String(body.error)).toContain("try again in a minute");
    expect(fake.parents.size).toBe(0);
  });

  it("keeps the retry message for temporary OpenApply failures", async () => {
    const fake = new FakeOpenApply();
    useFake(fake);
    fake.fail({ path: /parents\/search/, respond: 503, times: 3 });
    const { response, body } = await call(request(makeApplication()));
    expect(response.status).toBe(502);
    expect(body.error).toBe("We could not submit the application. Your draft remains on this device; please try again.");
  });

  it("does not log personal details", async () => {
    const fake = new FakeOpenApply();
    useFake(fake);
    fake.fail({ path: /parents\/search/, respond: 503, times: 3 });
    const application = makeApplication();
    await call(request(application));
    const output = logs.join("\n");
    expect(output).toContain("openapply.push_failed");
    for (const value of [application.parent1.email, application.parent1.mobile, application.children[0].dateOfBirth]) {
      expect(output).not.toContain(value);
    }
  });
});
