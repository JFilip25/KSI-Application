import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenApplyClient } from "@/lib/openapply/client";
import { readConfig } from "@/lib/openapply/config";
import { pushApplication, resetPushState, type AppliedEvent, type PushOptions } from "@/lib/openapply/push";
import type { ApplicationData } from "@/lib/schema";
import { makeApplication, makeChild } from "../support/application";
import { FakeOpenApply } from "../fakes/fake-openapply";

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-09-29T10:00:00.000Z") });
  for (const level of ["info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

function instance(fake: FakeOpenApply) {
  return new OpenApplyClient(readConfig(fake.env()), { fetch: fake.fetch });
}

async function push(fake: FakeOpenApply, application: ApplicationData, options: PushOptions = {}) {
  const outcome = pushApplication(application, { client: instance(fake), env: fake.env(), ...options }).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  await vi.runAllTimersAsync();
  return outcome;
}

function hook() {
  return vi.fn(async (event: AppliedEvent): Promise<"sent" | "skipped"> => {
    void event;
    return "sent";
  });
}

describe("confirmation email hook", () => {
  it("runs once for a new family with the linked parents and every child's OpenApply ID", async () => {
    const fake = new FakeOpenApply();
    const onApplied = hook();
    const application = makeApplication({ children: [makeChild({ firstName: "Mila" }), makeChild({ firstName: "Luka", dateOfBirth: "2013-05-20" })] });
    const { value } = await push(fake, application, { onApplied });
    expect(value?.confirmationEmail).toBe("sent");
    expect(onApplied).toHaveBeenCalledTimes(1);
    const event = onApplied.mock.calls[0][0];
    expect(event.reference).toBe(application.applicationReference);
    expect(event.parents).toEqual([
      { email: "alex.example@example.com", firstName: "Alex", lastName: "Example" },
      { email: "jordan.example@example.com", firstName: "Jordan", lastName: "Example" },
    ]);
    expect(event.children.map((child) => [child.child.firstName, child.studentId])).toEqual([
      ["Mila", value?.studentIds[0]],
      ["Luka", value?.studentIds[1]],
    ]);
    // The email goes out only once the students are Applied and linked.
    for (const id of value!.studentIds) expect(fake.students.get(id)?.status).toBe("applied");
  });

  it("does not email again when the same application is resubmitted from another instance", async () => {
    const fake = new FakeOpenApply();
    const application = makeApplication();
    await push(fake, application, { onApplied: hook() });
    resetPushState();
    const second = hook();
    const { value } = await push(fake, application, { onApplied: second });
    expect(second).not.toHaveBeenCalled();
    expect(value?.confirmationEmail).toBe("not-needed");
  });

  it("emails once when the same family double-submits on one instance", async () => {
    const fake = new FakeOpenApply();
    const onApplied = hook();
    const client = instance(fake);
    const application = makeApplication();
    const both = Promise.all([
      pushApplication(application, { client, env: fake.env(), onApplied }),
      pushApplication(application, { client, env: fake.env(), onApplied }),
    ]);
    await vi.runAllTimersAsync();
    const [a, b] = await both;
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(a.confirmationEmail).toBe("sent");
    expect(b.confirmationEmail).toBe("sent");
  });

  it("emails after a retry that completes an earlier failed attempt, once", async () => {
    const fake = new FakeOpenApply();
    fake.fail({ method: "PUT", path: /relationships/, respond: 500, times: 3 });
    const application = makeApplication();
    const first = hook();
    expect((await push(fake, application, { onApplied: first })).error).toBeDefined();
    expect(first).not.toHaveBeenCalled();
    resetPushState();
    const second = hook();
    const { value } = await push(fake, application, { onApplied: second });
    expect(second).toHaveBeenCalledTimes(1);
    expect(value?.confirmationEmail).toBe("sent");
  });

  it("leaves parent 2 out of the email when a court restriction was declared", async () => {
    const fake = new FakeOpenApply();
    const onApplied = hook();
    await push(fake, makeApplication({ courtRestrictions: "yes-admissions-follow-up" }), { onApplied });
    expect(onApplied.mock.calls[0][0].parents.map((parent) => parent.email)).toEqual(["alex.example@example.com"]);
  });

  it("never fails a submission because the email failed", async () => {
    const fake = new FakeOpenApply();
    const onApplied = vi.fn(async (): Promise<"sent" | "skipped"> => {
      throw new Error("Brevo rejected the email (401)");
    });
    const { value, error } = await push(fake, makeApplication(), { onApplied });
    expect(error).toBeUndefined();
    expect(value?.confirmationEmail).toBe("failed");
    expect(value?.warnings).toContain("confirmation_email_failed");
    expect(fake.students.size).toBe(1);
  });

  it("reports skipped when no email step was given, and never emails in test mode", async () => {
    const fake = new FakeOpenApply();
    expect((await push(fake, makeApplication())).value?.confirmationEmail).toBe("skipped");
    const onApplied = hook();
    const { value } = await push(fake, makeApplication(), { onApplied, env: fake.env({ OPENAPPLY_DRY_RUN: "true" }) });
    expect(value?.confirmationEmail).toBe("skipped");
    expect(onApplied).not.toHaveBeenCalled();
  });
});
