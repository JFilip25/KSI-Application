import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenApplyClient } from "@/lib/openapply/client";
import { readConfig } from "@/lib/openapply/config";
import { OpenApplyError } from "@/lib/openapply/errors";
import { pushApplication, resetPushState, type PushOptions } from "@/lib/openapply/push";
import type { ApplicationData } from "@/lib/schema";
import { makeApplication, makeChild, makeParent } from "../support/application";
import { FakeOpenApply } from "../fakes/fake-openapply";

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

/** A fresh OpenApplyClient per call simulates a different serverless instance. */
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

async function pushOk(fake: FakeOpenApply, application: ApplicationData, options: PushOptions = {}) {
  const { value, error } = await push(fake, application, options);
  if (error) throw error;
  return value!;
}

describe("pushApplication", () => {
  it("creates a new family with linked parents, applied students and KSI fields", async () => {
    const fake = new FakeOpenApply();
    const application = makeApplication();
    const started = Date.now();
    const result = await pushOk(fake, application);

    expect(result.dryRun).toBe(false);
    expect(result.parentIds).toHaveLength(2);
    expect(result.studentIds).toHaveLength(1);
    expect(fake.parents.size).toBe(2);
    expect(fake.students.size).toBe(1);

    const [studentId] = result.studentIds;
    const student = fake.studentView(fake.students.get(studentId)!);
    expect(student).toMatchObject({
      first_name: "Sam",
      last_name: "Example",
      birth_date: "2018-10-12",
      gender: "Female",
      grade: "Year 3",
      enrollment_year: 2026,
      status: "applied",
      country: "Montenegro",
      parent_ids: result.parentIds,
    });
    expect(student.custom_fields).toMatchObject({
      nationality: "Montenegrin",
      language: "Montenegrin",
      english_level: "Proficient",
      prior_school: "Example Primary",
      current_grade: "Year 3",
      family_situation: "Parents Married/Living Together",
      grade_repeat_y_n: "No",
      attended_school_regularly_y_n: "Yes",
      discipline_y_n: "No",
      learning_disabilities_y_n: "No",
      eal_programme_y_n: "No",
      medical_conditions_y_n: "No",
      photo_video_permissions_y_n: "Yes",
      google_edu_services: true,
    });
    expect(String(student.custom_fields.additional_information)).toContain(`ref ${application.applicationReference.split("-")[0].toUpperCase()}`);

    const [motherId, fatherId] = result.parentIds;
    expect(fake.relationshipsOf(motherId)).toEqual({ [studentId]: "mother" });
    expect(fake.relationshipsOf(fatherId)).toEqual({ [studentId]: "father" });
    expect(fake.parents.get(motherId)?.custom_fields.mobile_phone).toBe("+382 67 000 000");
    expect(fake.parents.get(fatherId)?.custom_fields.mobile_phone).toBe("+382 69 111 222");

    expect(fake.log.filter((entry) => entry.status === 429)).toHaveLength(0);
    expect(fake.log.length).toBeLessThanOrEqual(16);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("writes five siblings for a sole parent well within the time budget", async () => {
    const fake = new FakeOpenApply();
    const children = ["Ana", "Luka", "Mila", "Nikola", "Sara"].map((firstName, index) =>
      makeChild({ firstName, dateOfBirth: `201${index + 2}-03-0${index + 1}` }),
    );
    const application = makeApplication({ children, legalResponsibility: "sole-parent-1", parent2: undefined, parent2Consent: "evidence-exception" });
    const started = Date.now();
    const result = await pushOk(fake, application);
    expect(result.studentIds).toHaveLength(5);
    expect(Object.keys(fake.relationshipsOf(result.parentIds[0]))).toHaveLength(5);
    expect([...fake.students.values()].every((student) => student.status === "applied")).toBe(true);
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it("adds a new child to a returning family without unlinking siblings or overwriting Admissions' data", async () => {
    const fake = new FakeOpenApply();
    const parent = fake.seedParent({ email: "alex.example@example.com", custom_fields: { mobile_phone: "+382 67 999 999" } });
    const older = fake.seedStudent({ first_name: "Older", last_name: "Example", birth_date: "2014-01-01", status: "enrolled", enrollment_year: 2024 });
    fake.link(parent.id, older.id, "legal guardian");

    const application = makeApplication({ legalResponsibility: "sole-parent-1", parent2: undefined, parent2Consent: "evidence-exception" });
    const result = await pushOk(fake, application);

    expect(result.parentIds).toEqual([parent.id]);
    expect(fake.parents.size).toBe(1);
    const newId = result.studentIds[0];
    expect(fake.relationshipsOf(parent.id)).toEqual({ [older.id]: "legal guardian", [newId]: "mother" });
    expect(fake.parents.get(parent.id)?.custom_fields.mobile_phone).toBe("+382 67 999 999");
    expect(fake.students.get(older.id)?.status).toBe("enrolled");
  });

  it("recovers from a failure part-way through without creating duplicates", async () => {
    const fake = new FakeOpenApply();
    fake.fail({ method: "PUT", path: /relationships/, respond: 500, times: 3 });
    const application = makeApplication();

    const first = await push(fake, application);
    expect(first.error).toBeInstanceOf(OpenApplyError);
    expect((first.error as OpenApplyError).kind).toBe("server");
    expect(fake.parents.size).toBe(2);
    expect(fake.students.size).toBe(1);

    resetPushState();
    const second = await pushOk(fake, application);
    expect(fake.parents.size).toBe(2);
    expect(fake.students.size).toBe(1);
    const [studentId] = second.studentIds;
    expect(fake.studentView(fake.students.get(studentId)!).parent_ids.sort()).toEqual([...second.parentIds].sort());
    expect(fake.students.get(studentId)?.status).toBe("applied");
  });

  it("treats an identical resubmission from another instance as the same application", async () => {
    const fake = new FakeOpenApply();
    const application = makeApplication();
    const first = await pushOk(fake, application);
    const summaryBefore = [...fake.students.values()][0].custom_fields.additional_information;

    resetPushState();
    const second = await pushOk(fake, application);
    expect(second.parentIds).toEqual(first.parentIds);
    expect(second.studentIds).toEqual(first.studentIds);
    expect(fake.parents.size).toBe(2);
    expect(fake.students.size).toBe(1);
    expect([...fake.students.values()][0].custom_fields.additional_information).toBe(summaryBefore);
  });

  it("returns the cached result for a duplicate submit on the same instance", async () => {
    const fake = new FakeOpenApply();
    const application = makeApplication();
    const client = instance(fake);
    const both = Promise.all([
      pushApplication(application, { client, env: fake.env() }),
      pushApplication(application, { client, env: fake.env() }),
    ]);
    await vi.runAllTimersAsync();
    const [a, b] = await both;
    expect(a).toBe(b);
    expect(fake.students.size).toBe(1);
    const requests = fake.log.length;
    const again = pushApplication(application, { client, env: fake.env() });
    await vi.runAllTimersAsync();
    expect(await again).toBe(a);
    expect(fake.log.length).toBe(requests);
  });

  it("uses one parent record when both parents share an email address", async () => {
    const fake = new FakeOpenApply();
    const application = makeApplication({ parent2: makeParent({ firstName: "Jordan", relationship: "father", email: "Alex.Example@example.com" }) });
    const result = await pushOk(fake, application);
    expect(result.parentIds).toHaveLength(1);
    expect(result.warnings).toContain("parent2_same_email");
    expect(String(fake.students.get(result.studentIds[0])?.custom_fields.additional_information)).toContain("same email address");
  });

  it("leaves parent 2 for Admissions when a court restriction is declared", async () => {
    const fake = new FakeOpenApply();
    const result = await pushOk(fake, makeApplication({ courtRestrictions: "yes-admissions-follow-up" }));
    expect(result.parentIds).toHaveLength(1);
    expect(fake.parents.size).toBe(1);
    const summary = String(fake.students.get(result.studentIds[0])?.custom_fields.additional_information);
    expect(summary).toContain("Parent/guardian 2: Jordan Example (Father)");
    expect(summary).toContain("court order or restriction was declared");
  });

  it("continues without parent 2 when OpenApply rejects that parent", async () => {
    const fake = new FakeOpenApply();
    const application = makeApplication();
    // The first POST /parents (parent 1) succeeds; the second (parent 2) is rejected.
    const original = fake.fetch;
    let parentCreates = 0;
    fake.fetch = async (input, init) => {
      const url = String(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
      if (init?.method === "POST" && url.endsWith("/api/v3/parents") && ++parentCreates === 2) {
        return new Response(JSON.stringify({ errors: ["Email is invalid"] }), { status: 422 });
      }
      return original(input, init);
    };
    const result = await pushOk(fake, application);
    expect(result.parentIds).toHaveLength(1);
    expect(result.warnings).toContain("parent2_rejected");
    expect(fake.students.get(result.studentIds[0])?.status).toBe("applied");
  });

  it("keeps free-text answers when OpenApply refuses an option value", async () => {
    const fake = new FakeOpenApply();
    fake.fail({ method: "PATCH", path: /students\/\d+\/custom_fields/, respond: { status: 422, body: { errors: ["Field 30 (nationality) value 145 is not a valid option value."] } } });
    const result = await pushOk(fake, makeApplication());
    expect(result.warnings).toContain("student_fields_partly_saved");
    const fields = fake.students.get(result.studentIds[0])!.custom_fields;
    expect(fields.nationality).toBeNull();
    expect(fields.prior_school).toBe("Example Primary");
    expect(String(fields.additional_information)).toContain("Nationality: Montenegrin");
  });

  it("finds the parent again when a parallel submission created it first", async () => {
    const fake = new FakeOpenApply();
    const existing = fake.seedParent({ email: "alex.example@example.com" });
    // The first search runs before the other submission's create became visible.
    fake.fail({ method: "GET", path: /parents\/search/, respond: { status: 200, body: { parents: [] } } });
    const result = await pushOk(fake, makeApplication());
    expect(result.parentIds[0]).toBe(existing.id);
    expect(fake.parents.size).toBe(2);
  });

  it("does not duplicate a student whose create succeeded without a response", async () => {
    const fake = new FakeOpenApply();
    fake.fail({ method: "POST", path: /^\/api\/v3\/students$/, respond: "commit-then-500" });
    const result = await pushOk(fake, makeApplication());
    expect(fake.students.size).toBe(1);
    expect(fake.students.get(result.studentIds[0])?.status).toBe("applied");
  });

  it("turns an existing enquiry into an application", async () => {
    const fake = new FakeOpenApply();
    const parent = fake.seedParent({ email: "alex.example@example.com" });
    const enquiry = fake.seedStudent({ first_name: "Sam", last_name: "Example", birth_date: "2018-10-12", enrollment_year: 2026, status: "pending" });
    fake.link(parent.id, enquiry.id, "mother");
    const result = await pushOk(fake, makeApplication({ legalResponsibility: "sole-parent-1", parent2: undefined, parent2Consent: "evidence-exception" }));
    expect(result.studentIds).toEqual([enquiry.id]);
    expect(fake.students.get(enquiry.id)?.status).toBe("applied");
    expect(fake.students.get(enquiry.id)?.custom_fields.english_level).toBe("Proficient");
  });

  it("does not touch a child who is already further along, but records the new answers", async () => {
    const fake = new FakeOpenApply();
    const parent = fake.seedParent({ email: "alex.example@example.com" });
    const admitted = fake.seedStudent({
      first_name: "Sam",
      last_name: "Example",
      birth_date: "2018-10-12",
      enrollment_year: 2026,
      status: "admitted",
      custom_fields: { english_level: "Fluent", additional_information: "Interview notes" },
    });
    fake.link(parent.id, admitted.id, "mother");
    const result = await pushOk(fake, makeApplication({ legalResponsibility: "sole-parent-1", parent2: undefined, parent2Consent: "evidence-exception" }));
    const student = fake.students.get(admitted.id)!;
    expect(result.studentIds).toEqual([admitted.id]);
    expect(student.status).toBe("admitted");
    expect(student.custom_fields.english_level).toBe("Fluent");
    expect(String(student.custom_fields.additional_information)).toMatch(/^Interview notes\n\n---\nKSI Montenegro online application/);
  });

  it("creates a new record rather than reviving a withdrawn one", async () => {
    const fake = new FakeOpenApply();
    const parent = fake.seedParent({ email: "alex.example@example.com" });
    const withdrawn = fake.seedStudent({ first_name: "Sam", last_name: "Example", birth_date: "2018-10-12", status: "withdrawn", archived: true });
    fake.link(parent.id, withdrawn.id, "mother");
    const result = await pushOk(fake, makeApplication({ legalResponsibility: "sole-parent-1", parent2: undefined, parent2Consent: "evidence-exception" }));
    expect(result.studentIds[0]).not.toBe(withdrawn.id);
    expect(fake.relationshipsOf(parent.id)).toEqual({ [withdrawn.id]: "mother", [result.studentIds[0]]: "mother" });
  });

  it("writes the summary to an office-use field when configured", async () => {
    const fake = new FakeOpenApply();
    const result = await pushOk(fake, makeApplication(), {
      env: fake.env({ OPENAPPLY_CUSTOM_FIELD_MAP: JSON.stringify({ student: { summary: 999001 } }) }),
    });
    const fields = fake.students.get(result.studentIds[0])!.custom_fields;
    expect(fields.additional_information).toBeNull();
    expect(String(fields.admissions_office_notes)).toContain("KSI Montenegro online application");
  });

  it("makes no requests in test mode", async () => {
    const fake = new FakeOpenApply();
    const result = await pushOk(fake, makeApplication(), { env: fake.env({ OPENAPPLY_DRY_RUN: "true" }) });
    expect(result).toMatchObject({ dryRun: true, parentIds: [], studentIds: [] });
    expect(fake.log).toHaveLength(0);
  });

  it("turns a submission away before writing anything when the queue is too long", async () => {
    const fake = new FakeOpenApply();
    const client = instance(fake);
    const first = pushApplication(makeApplication(), { client, env: fake.env() });
    const second = pushApplication(
      makeApplication({ parent1: makeParent({ email: "other@example.com" }), parent2: undefined, legalResponsibility: "sole-parent-1", parent2Consent: "evidence-exception" }),
      { client, env: fake.env(), budgetMs: 9_000 },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    await first;
    const error = await second;
    expect(error).toBeInstanceOf(OpenApplyError);
    expect((error as OpenApplyError).kind).toBe("busy");
    expect([...fake.parents.values()].some((parent) => parent.email === "other@example.com")).toBe(false);
  });

  it("never logs personal details", async () => {
    const fake = new FakeOpenApply();
    fake.fail({ method: "PUT", path: /relationships/, respond: { status: 422, body: { errors: ["Sam Example (2018-10-12) alex.example@example.com rejected"] } }, times: 2 });
    await push(fake, makeApplication());
    const output = logs.join("\n");
    expect(output).toContain("openapply.push");
    for (const value of ["alex.example@example.com", "jordan.example@example.com", "+382 67 000 000", "2018-10-12", "Sam Example"]) {
      expect(output).not.toContain(value);
    }
  });
});
