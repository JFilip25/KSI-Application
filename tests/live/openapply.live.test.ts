import { appendFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/applications/route";
import * as api from "@/lib/openapply/api";
import { deadlineIn, OpenApplyClient, type RequestContext } from "@/lib/openapply/client";
import { normalizeBaseUrl, readConfig } from "@/lib/openapply/config";
import { resetPushState } from "@/lib/openapply/push";
import { OPTION, STUDENT_FIELDS } from "@/lib/openapply/tenant";
import type { ApplicationData } from "@/lib/schema";
import { makeApplication, makeChild, makeParent } from "../support/application";

/**
 * Live regression against a real OpenApply tenant. It creates clearly marked test records
 * (surname ZZTEST…, @example.com emails) that must be deleted in OpenApply afterwards; the
 * API has no delete endpoint. Created IDs are printed and appended to OPENAPPLY_LIVE_IDS_FILE.
 *
 *   OPENAPPLY_LIVE_TEST=1 OPENAPPLY_LIVE_CONFIRM_HOST=<tenant host> OPENAPPLY_DRY_RUN=false \
 *   OPENAPPLY_BASE_URL=… OPENAPPLY_CLIENT_ID=… OPENAPPLY_CLIENT_SECRET=… npm run test:live
 */
const live = process.env.OPENAPPLY_LIVE_TEST === "1";
const run = process.env.OPENAPPLY_LIVE_RUN ?? new Date().toISOString().replace(/\D/g, "").slice(0, 12);
const email = (tag: string) => `ksi-oa-test+${run}-${tag}@example.com`;

const created = { parents: new Set<number>(), students: new Set<number>() };
let client: OpenApplyClient;
const ctx = (): RequestContext => ({ deadline: deadlineIn(60_000), stats: { calls: 0, retries: 0, rateLimited: 0 }, redact: [] });

async function submit(application: ApplicationData) {
  const response = await POST(
    new Request("http://localhost/api/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(application),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function parentByEmail(address: string) {
  const parents = (await api.searchParentsByEmail(client, ctx(), address)).filter((parent) => parent.email === address);
  expect(parents, address).toHaveLength(1);
  created.parents.add(parents[0].id);
  return parents[0];
}

async function studentsOf(parentId: number) {
  const students = await api.listStudentsOfParent(client, ctx(), parentId, "additional_information");
  students.forEach((student) => created.students.add(student.id));
  return students;
}

async function studentDetail(id: number) {
  const body = await client.request<{ student: Record<string, unknown> & { custom_fields: Record<string, unknown> } }>(
    {
      step: "student.list",
      method: "GET",
      path: `/api/v3/students/${id}?fields=id,first_name,last_name,birth_date,gender,grade,enrollment_year,status,country,parent_ids,custom_fields(${Object.values(STUDENT_FIELDS)
        .map((field) => field.slug)
        .join(",")})`,
      template: "/api/v3/students/:id",
      idempotent: true,
    },
    ctx(),
  );
  return body.student;
}

async function roles(parentId: number) {
  return Object.fromEntries((await api.getParentRelationships(client, ctx(), parentId)).map((link) => [link.student_id, link.relationship]));
}

const sole = { legalResponsibility: "sole-parent-1" as const, parent2: undefined, parent2Consent: "evidence-exception" as const, familySituation: "sole-parent" as const };

describe.runIf(live)("live OpenApply regression (ZZTEST records)", () => {
  const f1 = makeApplication({
    academicYear: "2026-2027",
    children: [makeChild({ firstName: "Fone", lastName: "ZZTEST", dateOfBirth: "2018-10-12", gender: "female", nationality: "ME", homeLanguage: "Montenegrin" })],
    parent1: makeParent({ firstName: "Fone", lastName: "ZZTEST", relationship: "mother", email: email("f1-mother") }),
    parent2: makeParent({ firstName: "Fone", lastName: "ZZTEST", relationship: "father", email: email("f1-father"), mobile: "+382 69 111 222", country: "RS" }),
  });
  const f2 = makeApplication({
    academicYear: "2027-2028",
    ...sole,
    parent1: makeParent({ firstName: "Ftwo", lastName: "ZZTEST-Šćekić", relationship: "legal-guardian", email: email("f2-guardian"), country: "GB" }),
    familySituation: "divorced",
    declarations: { accuracy: true, authority: true, privacy: true, googleEducation: true, marketingConsent: "no" },
    children: [
      makeChild({ firstName: "Đorđe", lastName: "ZZTEST-Šćekić", dateOfBirth: "2012-02-29", gender: "male", nationality: "RS", homeLanguage: "Serbian", englishLevel: "developing", learningNeeds: ["English as an Additional Language", "Literacy or dyslexia support"], learningPlan: "current-plan", repeatedGrade: "yes", disclosureNote: "Test record — please ignore. O'Neil “quotes” & more." }),
      makeChild({ firstName: "Mila", lastName: "ZZTEST-Šćekić", dateOfBirth: "2016-11-30", gender: "prefer-not-to-say", nationality: "GB", homeLanguage: "Other / not listed", otherHomeLanguage: "Tagalog", medicalNeeds: ["Allergy or anaphylaxis"], medicalAction: "emergency-plan", attendance: "some-concern" }),
      makeChild({ firstName: "Vuk", lastName: "ZZTEST-Šćekić", dateOfBirth: "2023-08-31", gender: "nonbinary", nationality: "XK", homeLanguage: "Albanian", currentSchool: "", currentGrade: "", englishLevel: "not-yet-assessed", seriousDiscipline: "no" }),
    ],
  });
  const f3 = makeApplication({
    academicYear: "2027-2028",
    ...sole,
    parent1: makeParent({ firstName: "Fone", lastName: "ZZTEST", relationship: "mother", email: email("f1-mother"), mobile: "+382 67 555 555" }),
    children: [makeChild({ firstName: "Fthree", lastName: "ZZTEST", dateOfBirth: "2021-01-15", gender: "male" })],
  });
  const f5 = makeApplication({
    academicYear: "2027-2028",
    ...sole,
    parent1: makeParent({ firstName: "Ffive", lastName: "ZZTEST", relationship: "stepfather", email: email("f5-stepfather"), country: "HR" }),
    children: [makeChild({ firstName: "Ffive", lastName: "ZZTEST", dateOfBirth: "2019-06-01", nationality: "HR", homeLanguage: "Croatian" })],
  });

  beforeAll(() => {
    const config = readConfig();
    const host = new URL(normalizeBaseUrl(process.env.OPENAPPLY_BASE_URL)).host;
    if (process.env.OPENAPPLY_LIVE_CONFIRM_HOST !== host) {
      throw new Error(`Set OPENAPPLY_LIVE_CONFIRM_HOST=${host} to confirm writing test records to this tenant.`);
    }
    if (process.env.OPENAPPLY_DRY_RUN?.trim().toLowerCase() !== "false") throw new Error("Set OPENAPPLY_DRY_RUN=false for the live suite.");
    // The test families use undeliverable @example.com addresses; never send them confirmation emails.
    process.env.BREVO_API_KEY = "";
    client = new OpenApplyClient(config);
    return () => {
      const ids = { run, parents: [...created.parents], students: [...created.students] };
      process.stdout.write(`\nZZTEST records for run ${run}: ${JSON.stringify(ids)}\n`);
      if (process.env.OPENAPPLY_LIVE_IDS_FILE) appendFileSync(process.env.OPENAPPLY_LIVE_IDS_FILE, `${JSON.stringify(ids)}\n`);
    };
  });

  it("F1: new family with two parents", async () => {
    const response = await submit(f1);
    expect(response).toEqual({ status: 201, body: { reference: f1.applicationReference, dryRun: false } });

    const mother = await parentByEmail(f1.parent1.email);
    const father = await parentByEmail(f1.parent2!.email);
    const [child] = await studentsOf(mother.id);
    const student = await studentDetail(child.id);
    expect(student).toMatchObject({
      first_name: "Fone",
      last_name: "ZZTEST",
      birth_date: "2018-10-12",
      gender: "Female",
      grade: "Year 3",
      enrollment_year: 2026,
      status: "applied",
      country: "Montenegro",
    });
    expect(student.custom_fields).toMatchObject({
      nationality: "Montenegrin",
      language: "Montenegrin",
      english_level: "Proficient",
      prior_school: "Example Primary",
      family_situation: "Parents Married/Living Together",
      grade_repeat_y_n: "No",
      attended_school_regularly_y_n: "Yes",
      discipline_y_n: "No",
      eal_programme_y_n: "No",
      medical_conditions_y_n: "No",
      photo_video_permissions_y_n: "Yes",
      google_edu_services: true,
    });
    expect(String(student.custom_fields.additional_information)).toContain(`ref ${f1.applicationReference.split("-")[0].toUpperCase()}`);
    expect(await roles(mother.id)).toEqual({ [child.id]: "mother" });
    expect(await roles(father.id)).toEqual({ [child.id]: "father" });
    expect(mother.custom_fields.mobile_phone).toBe(f1.parent1.mobile);
    expect(father.custom_fields.mobile_phone).toBe(f1.parent2!.mobile);
  }, 120_000);

  it("F2: sole guardian, three siblings, diacritics and support needs", async () => {
    const response = await submit(f2);
    expect(response.status).toBe(201);
    const guardian = await parentByEmail(f2.parent1.email);
    const students = await studentsOf(guardian.id);
    expect(students.map((student) => student.first_name).sort()).toEqual(["Mila", "Vuk", "Đorđe"]);
    const details = Object.fromEntries(await Promise.all(students.map(async (student) => [student.first_name, await studentDetail(student.id)] as const)));

    expect(details["Đorđe"]).toMatchObject({ last_name: "ZZTEST-Šćekić", gender: "Male", grade: "Year 11", enrollment_year: 2027, status: "applied", country: "United Kingdom" });
    expect(details["Đorđe"].custom_fields).toMatchObject({
      nationality: "Serbian",
      language: "Serbian",
      english_level: "Basic",
      family_situation: "Parents Divorced/Separated",
      grade_repeat_y_n: "Yes",
      learning_disabilities_y_n: "Yes",
      eal_programme_y_n: "Yes",
      photo_video_permissions_y_n: "No",
    });
    expect(String(details["Đorđe"].custom_fields.additional_information)).toContain("O'Neil “quotes” & more.");
    expect(details.Mila).toMatchObject({ gender: null, grade: "Year 6" });
    expect(details.Mila.custom_fields).toMatchObject({ nationality: "British", language: "Tagalog", medical_conditions_y_n: "Yes", attended_school_regularly_y_n: "No" });
    expect(String(details.Mila.custom_fields.medical_conditions_details)).toContain("Allergy or anaphylaxis");
    expect(details.Vuk).toMatchObject({ gender: null, grade: "Reception" });
    expect(details.Vuk.custom_fields).toMatchObject({ nationality: "Kosovan", language: "Albanian", english_level: null });
    expect(String(details.Vuk.custom_fields.additional_information)).toContain("Gender: Non-binary");
    expect(Object.values(await roles(guardian.id))).toEqual(["legal guardian", "legal guardian", "legal guardian"]);
  }, 180_000);

  it("F3 and F5 at the same time: returning family plus a new family", async () => {
    resetPushState();
    const [returning, fresh] = await Promise.all([submit(f3), submit(f5)]);
    expect(returning.status).toBe(201);
    expect(fresh.status).toBe(201);

    const mother = await parentByEmail(f1.parent1.email);
    const children = await studentsOf(mother.id);
    expect(children.map((student) => student.first_name).sort()).toEqual(["Fone", "Fthree"]);
    const motherRoles = await roles(mother.id);
    expect(Object.values(motherRoles)).toEqual(["mother", "mother"]);
    // The number Admissions already holds is kept.
    const [motherRecord] = await api.searchParentsByEmail(client, ctx(), f1.parent1.email);
    expect(motherRecord.custom_fields.mobile_phone).toBe(f1.parent1.mobile);

    const stepfather = await parentByEmail(f5.parent1.email);
    const [child] = await studentsOf(stepfather.id);
    expect(await roles(stepfather.id)).toEqual({ [child.id]: "stepfather" });
    expect((await studentDetail(child.id)).custom_fields).toMatchObject({ nationality: "Croatian", language: "Croatian" });
  }, 180_000);

  it("F4: resubmitting F2 from another instance adds nothing", async () => {
    resetPushState();
    const guardian = await parentByEmail(f2.parent1.email);
    const before = await studentsOf(guardian.id);
    const response = await submit(f2);
    expect(response.status).toBe(201);
    const after = await studentsOf(guardian.id);
    expect(after.map((student) => student.id).sort()).toEqual(before.map((student) => student.id).sort());
    expect((await api.searchParentsByEmail(client, ctx(), f2.parent1.email)).length).toBe(1);
  }, 180_000);

  it("the tenant still has the fields and options this app writes", async () => {
    const detail = async (id: number) =>
      (await client.request<{ field: { slug: string; options?: { id: number }[] } }>(
        { step: "field.get", method: "GET", path: `/api/v3/fields/${id}`, template: "/api/v3/fields/:id", idempotent: true },
        ctx(),
      )).field;
    for (const field of Object.values(STUDENT_FIELDS)) expect((await detail(field.id)).slug).toBe(field.slug);
    const optionIds = async (id: number) => ((await detail(id)).options ?? []).map((option) => String(option.id));
    expect(await optionIds(STUDENT_FIELDS.englishLevel.id)).toEqual(expect.arrayContaining(Object.values(OPTION.englishLevel)));
    expect(await optionIds(STUDENT_FIELDS.familySituation.id)).toEqual(expect.arrayContaining(Object.values(OPTION.familySituation)));
    expect(await optionIds(STUDENT_FIELDS.repeatedGrade.id)).toEqual(expect.arrayContaining([OPTION.yes, OPTION.no]));
  }, 180_000);
});
