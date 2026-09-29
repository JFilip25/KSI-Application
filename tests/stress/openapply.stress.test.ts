import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationData } from "@/lib/schema";
import { makeApplication, makeChild, makeParent } from "../support/application";
import { FakeOpenApply } from "../fakes/fake-openapply";

/**
 * Burst test against the simulated tenant (real 5 requests / 2 s limit, 150 ms latency):
 * 50 families submit at the same moment through 3 independent server instances, about 5% of
 * requests fail (503s and creates that succeed without a response), and families retry when
 * told to. Afterwards every family must exist exactly once and be fully linked.
 *
 *   npm run test:stress
 */
const enabled = process.env.OPENAPPLY_STRESS === "1";

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

type Instance = {
  push: (application: ApplicationData, options: Record<string, unknown>) => Promise<{ parentIds: number[]; studentIds: number[] }>;
  client: unknown;
};

afterEach(() => {
  vi.useRealTimers();
});

describe.runIf(enabled)("OpenApply stress", () => {
  it("writes 50 simultaneous families across 3 instances without duplicates", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-29T10:00:00.000Z") });
    for (const level of ["info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
    const rng = random(20260929);
    const fake = new FakeOpenApply({ latencyMs: 150 });

    let injected = 0;
    const faultyFetch: typeof fetch = async (input, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const url = String(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
      if (!url.endsWith("/oauth/token") && rng() < 0.05) {
        injected += 1;
        if (method === "POST") {
          await fake.fetch(input, init);
          return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
        }
        return new Response("<html>503</html>", { status: 503 });
      }
      return fake.fetch(input, init);
    };

    const instances: Instance[] = [];
    for (let index = 0; index < 3; index += 1) {
      vi.resetModules();
      const { pushApplication } = await import("@/lib/openapply/push");
      const { OpenApplyClient } = await import("@/lib/openapply/client");
      const { readConfig } = await import("@/lib/openapply/config");
      instances.push({ push: pushApplication as Instance["push"], client: new OpenApplyClient(readConfig(fake.env()), { fetch: faultyFetch }) });
    }

    const names = ["Ana", "Luka", "Mila", "Nikola", "Sara", "Petar", "Iva", "Marko", "Lena", "Vuk"];
    const applications: ApplicationData[] = [];
    for (let family = 0; family < 50; family += 1) {
      const surname = `Family${family}`;
      const childCount = 1 + Math.floor(rng() * 5);
      const children = Array.from({ length: childCount }, (_, index) =>
        makeChild({ firstName: names[(family + index) % names.length], lastName: surname, dateOfBirth: `201${index + 1}-0${(family % 9) + 1}-1${index}` }),
      );
      const joint = rng() < 0.6;
      const email = `parent${family}@example.com`;
      if (family < 10) {
        // Returning families: the parent and an older child already exist in OpenApply.
        const parent = fake.seedParent({ email, first_name: "Existing", last_name: surname });
        const older = fake.seedStudent({ first_name: "Older", last_name: surname, birth_date: "2009-05-05", status: "enrolled" });
        fake.link(parent.id, older.id, "mother");
      }
      applications.push(
        makeApplication({
          academicYear: family % 2 ? "2027-2028" : "2026-2027",
          children,
          parent1: makeParent({ email, lastName: surname }),
          ...(joint
            ? { legalResponsibility: "joint" as const, parent2: makeParent({ firstName: "Second", lastName: surname, relationship: "father", email: `second${family}@example.com` }), parent2Consent: "signing-now" as const }
            : { legalResponsibility: "sole-parent-1" as const, parent2: undefined, parent2Consent: "evidence-exception" as const }),
        }),
      );
    }

    const outcomes = new Map<string, "ok" | "retryable" | "final">();
    const durations: number[] = [];
    let attempts = 0;
    let busy = 0;
    const submit = (application: ApplicationData, instance: Instance) => {
      attempts += 1;
      const started = Date.now();
      return instance.push(application, { client: instance.client, env: fake.env() }).then(
        () => {
          durations.push(Date.now() - started);
          outcomes.set(application.applicationReference, "ok");
        },
        (error: { name?: string; kind?: string; retryable?: boolean }) => {
          if (error.kind === "busy") busy += 1;
          outcomes.set(application.applicationReference, error.name === "OpenApplyError" && error.retryable ? "retryable" : "final");
        },
      );
    };

    // Everyone at once, plus three double-clicks landing on the same instance.
    const burst = applications.map((application, index) => submit(application, instances[index % 3]));
    for (const index of [3, 17, 31]) burst.push(submit(applications[index], instances[index % 3]));
    await vi.runAllTimersAsync();
    await Promise.all(burst);
    const firstRoundOk = [...outcomes.values()].filter((value) => value === "ok").length;

    // Families whose submission failed try again a minute later, as the page tells them to.
    for (let round = 0; round < 10 && [...outcomes.values()].some((value) => value !== "ok"); round += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      const retries = applications
        .filter((application) => outcomes.get(application.applicationReference) !== "ok")
        .map((application, index) => submit(application, instances[(index + round) % 3]));
      await vi.runAllTimersAsync();
      await Promise.all(retries);
    }

    expect([...outcomes.values()].every((value) => value === "ok")).toBe(true);

    // Exactly one parent per email and one student per child, fully linked.
    const emails = [...fake.parents.values()].map((parent) => parent.email);
    expect(new Set(emails).size).toBe(emails.length);
    const identities = [...fake.students.values()].map((student) => `${student.first_name}|${student.last_name}|${student.birth_date}|${student.enrollment_year}`);
    expect(new Set(identities).size).toBe(identities.length);
    for (const application of applications) {
      const parentEmails = [application.parent1.email, application.parent2?.email].filter(Boolean) as string[];
      for (const child of application.children) {
        const student = [...fake.students.values()].find(
          (candidate) => candidate.first_name === child.firstName && candidate.last_name === child.lastName && candidate.birth_date === child.dateOfBirth,
        );
        expect(student?.status, `${child.firstName} ${child.lastName}`).toBe("applied");
        const linked = fake.parentIdsOf(student!.id).map((id) => fake.parents.get(id)!.email);
        expect(linked.sort()).toEqual([...parentEmails].sort());
      }
    }
    for (let family = 0; family < 10; family += 1) {
      const older = [...fake.students.values()].find((student) => student.first_name === "Older" && student.last_name === `Family${family}`)!;
      expect(fake.parentIdsOf(older.id)).toHaveLength(1);
      expect(older.status).toBe("enrolled");
    }
    // OpenApply counts fixed 2-second windows; none may have accepted more than 5 requests.
    const perWindow = new Map<number, number>();
    for (const entry of fake.log.filter((item) => item.status !== 429)) {
      const window = Math.floor(entry.at / 2000);
      perWindow.set(window, (perWindow.get(window) ?? 0) + 1);
    }
    expect(Math.max(...perWindow.values())).toBeLessThanOrEqual(5);

    durations.sort((a, b) => a - b);
    const percentile = (p: number) => Math.round(durations[Math.min(durations.length - 1, Math.floor((p / 100) * durations.length))] / 1000);
    process.stdout.write(
      `\nStress: ${applications.length} families (${fake.students.size - 10} new students), ${attempts} submission attempts, ` +
        `${firstRoundOk}/${outcomes.size} succeeded in the first burst, ${busy} turned away as busy before writing, ` +
        `${injected} injected faults, ${fake.log.length} requests (${fake.log.filter((entry) => entry.status === 429).length} × 429), ` +
        `successful submission time p50 ${percentile(50)} s / p95 ${percentile(95)} s (simulated clock).\n`,
    );
  }, 120_000);

  it("gets a realistic peak (8 families within a minute, 2 instances) through on the first attempt", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-29T10:00:00.000Z") });
    for (const level of ["info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
    const fake = new FakeOpenApply({ latencyMs: 250 });
    const instances: Instance[] = [];
    for (let index = 0; index < 2; index += 1) {
      vi.resetModules();
      const { pushApplication } = await import("@/lib/openapply/push");
      const { OpenApplyClient } = await import("@/lib/openapply/client");
      const { readConfig } = await import("@/lib/openapply/config");
      instances.push({ push: pushApplication as Instance["push"], client: new OpenApplyClient(readConfig(fake.env()), { fetch: fake.fetch }) });
    }
    const durations: number[] = [];
    const runs: Promise<void>[] = [];
    for (let family = 0; family < 8; family += 1) {
      const application = makeApplication({
        children: Array.from({ length: 1 + (family % 3) }, (_, index) => makeChild({ firstName: `Child${index}`, lastName: `Peak${family}`, dateOfBirth: `201${index + 3}-04-0${index + 1}` })),
        parent1: makeParent({ email: `peak${family}@example.com` }),
        parent2: makeParent({ firstName: "Second", relationship: "father", email: `peak-second${family}@example.com` }),
      });
      const instance = instances[family % 2];
      runs.push(
        new Promise<void>((resolve) => setTimeout(resolve, family * 7_000)).then(async () => {
          const started = Date.now();
          await instance.push(application, { client: instance.client, env: fake.env() });
          durations.push(Date.now() - started);
        }),
      );
    }
    await vi.runAllTimersAsync();
    await Promise.all(runs);
    expect(durations).toHaveLength(8);
    expect(Math.max(...durations)).toBeLessThan(40_000);
    process.stdout.write(
      `\nPeak: 8 families in 49 s over 2 instances, all written first time; slowest ${Math.round(Math.max(...durations) / 1000)} s, ` +
        `${fake.log.filter((entry) => entry.status === 429).length} × 429 absorbed.\n`,
    );
  }, 120_000);
});
