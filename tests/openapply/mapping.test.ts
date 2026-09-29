import { describe, expect, it, vi } from "vitest";
import snapshot from "../../scripts/openapply-tenant-snapshot.json";
import { COUNTRY_CODES, LANGUAGES } from "@/lib/options";
import { isDryRun, normalizeBaseUrl, readConfig } from "@/lib/openapply/config";
import { OPENAPPLY_COUNTRIES } from "@/lib/openapply/data/countries";
import { OPENAPPLY_LANGUAGES } from "@/lib/openapply/data/languages";
import {
  buildStudentSummary,
  buildSubmissionPlan,
  languageOption,
  mergeRelationships,
  mergeSummary,
  normalizeKey,
  relationshipRole,
  studentFieldValues,
  studentPayload,
  toCustomFields,
} from "@/lib/openapply/mapping";
import { RELATIONSHIP_ROLES, resolveFieldTargets } from "@/lib/openapply/tenant";
import { ParentSchema } from "@/lib/schema";
import { makeApplication, makeChild, makeParent } from "../support/application";

describe("config", () => {
  it("normalizes the tenant URL", () => {
    expect(normalizeBaseUrl("https://ksimontenegro.openapply.com")).toBe("https://ksimontenegro.openapply.com");
    expect(normalizeBaseUrl("ksimontenegro.openapply.com/")).toBe("https://ksimontenegro.openapply.com");
    expect(normalizeBaseUrl(" https://ksimontenegro.openapply.com/api/v3/ ")).toBe("https://ksimontenegro.openapply.com");
    expect(normalizeBaseUrl('"https://ksimontenegro.openapply.com/oauth/token"')).toBe("https://ksimontenegro.openapply.com");
    expect(normalizeBaseUrl("http://localhost:4010")).toBe("http://localhost:4010");
    expect(() => normalizeBaseUrl("http://ksimontenegro.openapply.com")).toThrow(/https/);
    expect(() => normalizeBaseUrl("")).toThrow(/not set/);
  });

  it("goes live only when OPENAPPLY_DRY_RUN is false", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(isDryRun({})).toBe(true);
    expect(isDryRun({ OPENAPPLY_DRY_RUN: "true" })).toBe(true);
    expect(isDryRun({ OPENAPPLY_DRY_RUN: "0" })).toBe(true);
    expect(isDryRun({ OPENAPPLY_DRY_RUN: "false" })).toBe(false);
    expect(isDryRun({ OPENAPPLY_DRY_RUN: " FALSE " })).toBe(false);
    expect(isDryRun({ OPENAPPLY_DRY_RUN: '"false"' })).toBe(false);
    // A whole .env line pasted into Vercel's value box.
    expect(isDryRun({ OPENAPPLY_DRY_RUN: "OPENAPPLY_DRY_RUN=false" })).toBe(false);
  });

  it("requires credentials for live mode", () => {
    expect(() => readConfig({ OPENAPPLY_BASE_URL: "https://x.openapply.com" })).toThrow(/CLIENT_ID/);
    expect(readConfig({ OPENAPPLY_BASE_URL: "x.openapply.com", OPENAPPLY_CLIENT_ID: " id ", OPENAPPLY_CLIENT_SECRET: "secret" })).toEqual({
      baseUrl: "https://x.openapply.com",
      clientId: "id",
      clientSecret: "secret",
    });
  });
});

describe("tenant option tables", () => {
  it("maps every selectable country to a distinct OpenApply country and a nationality", () => {
    const countryNames = new Set(snapshot.countries.map(([, name]) => name));
    const nationalities = new Map(snapshot.nationalities.map(([id, name]) => [id, name]));
    const seen = new Set<number>();
    for (const code of COUNTRY_CODES) {
      const entry = OPENAPPLY_COUNTRIES[code];
      expect(entry, code).toBeDefined();
      expect(countryNames.has(entry.country), code).toBe(true);
      expect(seen.has(entry.countryId), code).toBe(false);
      seen.add(entry.countryId);
      expect(entry.nationalityId, code).not.toBeNull();
      expect(nationalities.get(entry.nationalityId!), code).toBe(entry.nationality);
    }
  });

  it("pairs countries with the right nationality", () => {
    expect(OPENAPPLY_COUNTRIES.ME).toMatchObject({ countryId: 145, country: "Montenegro", nationality: "Montenegrin" });
    expect(OPENAPPLY_COUNTRIES.GB.nationality).toBe("British");
    expect(OPENAPPLY_COUNTRIES.RS.nationality).toBe("Serbian");
    expect(OPENAPPLY_COUNTRIES.BA.nationality).toBe("Bosnian and Herzegovinian");
    expect(OPENAPPLY_COUNTRIES.XK.nationality).toBe("Kosovan");
    expect(OPENAPPLY_COUNTRIES.NG.nationality).toBe("Nigerian (Nigeria)");
    expect(OPENAPPLY_COUNTRIES.SS.nationality).toBe("South Sudanese");
    expect(OPENAPPLY_COUNTRIES.CZ.country).toBe("Czech Republic");
    expect(OPENAPPLY_COUNTRIES.TR.country).toBe("Turkey");
  });

  it("uses the same name normalization as the generator", () => {
    for (const [id, name] of snapshot.languages) expect(OPENAPPLY_LANGUAGES[normalizeKey(String(name))]?.id).toBe(id);
  });

  it("resolves every listed home language and free-text answers", () => {
    for (const language of LANGUAGES.filter((value) => value !== "Other / not listed")) {
      expect(languageOption({ homeLanguage: language, otherHomeLanguage: "" }), language).not.toBeNull();
    }
    expect(languageOption({ homeLanguage: "Mandarin Chinese", otherHomeLanguage: "" })?.name).toBe("Mandarin");
    expect(languageOption({ homeLanguage: "Montenegrin", otherHomeLanguage: "" })?.id).toBe(530);
    expect(languageOption({ homeLanguage: "Other / not listed", otherHomeLanguage: " farsi " })?.name).toBe("Persian");
    expect(languageOption({ homeLanguage: "Other / not listed", otherHomeLanguage: "Tagalog" })?.name).toBe("Tagalog");
    expect(languageOption({ homeLanguage: "Other / not listed", otherHomeLanguage: "Klingon" })).toBeNull();
  });

  it("maps every relationship to a role OpenApply accepts", () => {
    for (const relationship of ParentSchema.shape.relationship.options) {
      expect(RELATIONSHIP_ROLES).toContain(relationshipRole(relationship));
    }
    expect(relationshipRole("legal-guardian")).toBe("legal guardian");
    expect(relationshipRole("stepfather")).toBe("stepfather");
  });
});

describe("student mapping", () => {
  it("builds the create payload OpenApply stores", () => {
    const application = makeApplication({ academicYear: "2027-2028", parent1: makeParent({ country: "RS" }) });
    const child = makeChild({ firstName: "  Đorđe ", lastName: "Šćekić-O'Neil", preferredName: "", gender: "male", dateOfBirth: "2018-10-12" });
    expect(studentPayload(child, application)).toEqual({
      first_name: "Đorđe",
      last_name: "Šćekić-O'Neil",
      birth_date: "2018-10-12",
      gender: "Male",
      grade: "Year 4",
      enrollment_year: 2027,
      status: "pending",
      country_id: 192,
    });
  });

  it("omits values OpenApply cannot store", () => {
    const application = makeApplication();
    const payload = studentPayload(makeChild({ gender: "nonbinary", dateOfBirth: "2025-01-01", preferredName: "Sammy" }), application);
    expect(payload).not.toHaveProperty("gender");
    expect(payload).not.toHaveProperty("grade");
    expect(payload.preferred_name).toBe("Sammy");
  });

  it("translates answers into KSI option IDs", () => {
    const application = makeApplication({ familySituation: "divorced", declarations: { accuracy: true, authority: true, privacy: true, googleEducation: true, marketingConsent: "no" } });
    const values = studentFieldValues(
      makeChild({
        englishLevel: "developing",
        learningNeeds: ["English as an Additional Language", "Literacy or dyslexia support"],
        learningPlan: "current-plan",
        medicalNeeds: ["Allergy or anaphylaxis"],
        medicalAction: "emergency-plan",
        attendance: "some-concern",
        repeatedGrade: "yes",
        seriousDiscipline: "yes-previous-school",
      }),
      application,
    );
    expect(values).toMatchObject({
      nationality: "145",
      language: "530",
      englishLevel: "484345",
      priorSchool: "Example Primary",
      currentGrade: "Year 3",
      familySituation: "484313",
      repeatedGrade: "1",
      attendedRegularly: "0",
      attendanceDetails: "Some concern",
      discipline: "1",
      disciplineDetails: "Yes, previous school",
      learningEvaluated: "1",
      eal: "1",
      medical: "1",
      photoConsent: "0",
      googleConsent: "1",
    });
    expect(values.learningDetails).toContain("Current plan / assessment");
    expect(values.learningDetails).toContain("Literacy or dyslexia support");
    expect(values.medicalDetails).toBe("Allergy or anaphylaxis — School planning: Emergency plan");
  });

  it("answers No where the family reported nothing", () => {
    const values = studentFieldValues(makeChild({ englishLevel: "not-yet-assessed", currentSchool: "", currentGrade: "" }), makeApplication({ familySituation: "sole-parent" }));
    expect(values).toMatchObject({ repeatedGrade: "0", attendedRegularly: "1", discipline: "0", learningEvaluated: "0", eal: "0", medical: "0", photoConsent: "1" });
    for (const key of ["englishLevel", "familySituation", "priorSchool", "currentGrade", "attendanceDetails", "disciplineDetails", "learningDetails", "medicalDetails"]) {
      expect(values).not.toHaveProperty(key);
    }
  });

  it("sends a detail only alongside a Yes answer", () => {
    const values = studentFieldValues(makeChild({ learningNeeds: ["Speech and language support"], learningPlan: "none" }), makeApplication());
    expect(values.learningEvaluated).toBe("0");
    expect(values).not.toHaveProperty("learningDetails");
  });

  it("keys custom fields by numeric field ID", () => {
    const targets = resolveFieldTargets(undefined);
    expect(toCustomFields({ nationality: "145", summary: "text", repeatedGrade: "0" }, targets.student)).toEqual({
      "30": "145",
      "124870": "text",
      "357781": "0",
    });
  });
});

describe("submission plan", () => {
  it("keeps parent 2 in the summary when they share parent 1's email", () => {
    const application = makeApplication({ parent2: makeParent({ firstName: "Jordan", email: "ALEX.example@example.com " }) });
    const plan = buildSubmissionPlan(application);
    expect(plan.parent2).toBeNull();
    expect(plan.parent2Skipped).toBe("same-email");
  });

  it("does not link parent 2 automatically when a court restriction is declared", () => {
    const plan = buildSubmissionPlan(makeApplication({ courtRestrictions: "yes-admissions-follow-up" }));
    expect(plan.parent2).toBeNull();
    expect(plan.parent2Skipped).toBe("court-restriction");
  });

  it("ignores a child entered twice", () => {
    const child = makeChild();
    const plan = buildSubmissionPlan(makeApplication({ children: [child, { ...child, id: crypto.randomUUID(), firstName: " sam " }] }));
    expect(plan.children).toHaveLength(1);
    expect(plan.duplicateChildren).toBe(1);
  });

  it("collects submitted values that must never be logged", () => {
    const plan = buildSubmissionPlan(makeApplication());
    expect(plan.redact).toEqual(expect.arrayContaining(["alex.example@example.com", "+382 67 000 000", "Sam", "2018-10-12"]));
  });

  it("summarises every answer for Admissions", () => {
    const application = makeApplication({
      children: [
        makeChild({ gender: "nonbinary", homeLanguage: "Other / not listed", otherHomeLanguage: "Tagalog", disclosureNote: "Needs an EpiPen." }),
        makeChild({ firstName: "Mia", dateOfBirth: "2021-02-03" }),
      ],
      parent2Consent: "secure-request",
    });
    const plan = buildSubmissionPlan(application, new Date("2026-09-29T10:15:00Z"));
    const summary = buildStudentSummary(plan, plan.children[0], ["Note: example"]);
    expect(summary.split("\n")[0]).toBe(`KSI Montenegro online application · ref ${plan.shortReference} · submitted 2026-09-29 10:15 UTC`);
    for (const text of [
      "Suggested year group: Year 3",
      "Gender: Non-binary",
      "Nationality: Montenegrin",
      "Home language: Other: Tagalog",
      "Family's note: Needs an EpiPen.",
      "Separate consent needed",
      "Parent/guardian 1: Alex Example (Mother) · alex.example@example.com · +382 67 000 000 · lives in Montenegro",
      "Parent/guardian 2: Jordan Example (Father)",
      "Marketing (photo/video) — Yes",
      "Siblings in this application: Mia Example",
      "Note: example",
      `Full reference: ${plan.reference}`,
    ]) {
      expect(summary).toContain(text);
    }
    expect(summary.length).toBeLessThan(2500);
  });
});

describe("mergeSummary", () => {
  it("writes, replaces its own block, appends to other content and skips unchanged text", () => {
    expect(mergeSummary(null, "KSI … ref AAAA1111 · new", "AAAA1111")).toBe("KSI … ref AAAA1111 · new");
    expect(mergeSummary("KSI … ref AAAA1111 · new", "KSI … ref AAAA1111 · new", "AAAA1111")).toBeNull();
    expect(mergeSummary("Written by Admissions", "KSI … ref AAAA1111 · new", "AAAA1111")).toBe(
      "Written by Admissions\n\n---\nKSI … ref AAAA1111 · new",
    );
    expect(mergeSummary("Admissions\n\n---\nKSI … ref AAAA1111 · old", "KSI … ref AAAA1111 · new", "AAAA1111")).toBe(
      "Admissions\n\n---\nKSI … ref AAAA1111 · new",
    );
  });

  it("drops the oldest blocks rather than growing without bound", () => {
    const merged = mergeSummary(`${"x".repeat(11_000)}\n\n---\n${"y".repeat(900)}`, `KSI ref BBBB2222 ${"z".repeat(900)}`, "BBBB2222");
    expect(merged?.startsWith("y")).toBe(true);
    expect(merged?.length).toBeLessThanOrEqual(12_000);
  });
});

describe("mergeRelationships", () => {
  it("keeps existing children and roles and adds new ones", () => {
    expect(
      mergeRelationships(
        [{ student_id: 1, relationship: "father" }],
        [
          { student_id: 1, relationship: "mother" },
          { student_id: 2, relationship: "mother" },
        ],
      ),
    ).toEqual({
      relationships: [
        { student_id: 1, relationship: "father" },
        { student_id: 2, relationship: "mother" },
      ],
      changed: true,
    });
    expect(mergeRelationships([{ student_id: 1, relationship: "father" }], [{ student_id: 1 }]).changed).toBe(false);
  });
});

describe("OPENAPPLY_CUSTOM_FIELD_MAP overrides", () => {
  it("uses the built-in KSI fields by default", () => {
    const targets = resolveFieldTargets("{}");
    expect(targets.student.summary).toEqual({ id: 124870, slug: "additional_information" });
    expect(targets.parent.mobile).toEqual({ id: 75, slug: "mobile_phone" });
    expect(targets.warnings).toEqual([]);
  });

  it("retargets text fields, disables fields and ignores unsafe entries", () => {
    const targets = resolveFieldTargets(
      JSON.stringify({
        student: { summary: "999001", photoConsent: null, englishLevel: 123, academic_year: "12345" },
        parent: { mobile: null },
        other: {},
      }),
    );
    expect(targets.student.summary).toEqual({ id: 999001, slug: null });
    expect(targets.student.photoConsent).toBeNull();
    expect(targets.student.englishLevel).toEqual({ id: 357797, slug: "english_level" });
    expect(targets.parent.mobile).toBeNull();
    expect(targets.warnings).toHaveLength(3);
  });

  it("falls back to the defaults on invalid JSON", () => {
    const targets = resolveFieldTargets("{not json");
    expect(targets.student.nationality).toEqual({ id: 30, slug: "nationality" });
    expect(targets.warnings[0]).toMatch(/not valid JSON/);
  });
});

describe("summary documents", () => {
  it("records the documents requested and the vaccination answer for each child", () => {
    const application = makeApplication({
      familySituation: "separated",
      children: [
        makeChild({ firstName: "Mila", dateOfBirth: "2022-03-10", vaccinationRecords: "not-available", vaccinationAcknowledgement: true }),
        makeChild({ firstName: "Luka", dateOfBirth: "2013-05-20" }),
      ],
    });
    const plan = buildSubmissionPlan(application);
    const mila = buildStudentSummary(plan, plan.children[0]);
    expect(mila).toContain("Vaccination records: NOT PROVIDED — the parent acknowledged that they have not provided the school with vaccination records");
    expect(mila).toContain(
      [
        "Documents requested (the family uploads them in OpenApply):",
        "- Passport copy — Alex Example",
        "- Passport copy — Jordan Example",
        "- Signed consent to this application from the other parent",
        "- Mila Example: Passport copy",
        "- Mila Example: Birth certificate",
        "- Mila Example: Vaccination records — not provided (acknowledged)",
      ].join("\n"),
    );
    expect(mila).not.toContain("Luka Example: Passport copy");

    const luka = buildStudentSummary(plan, plan.children[1]);
    expect(luka).toContain("- Luka Example: School reports / transcripts from the last two school years");
    expect(luka).not.toContain("Vaccination records:");
  });

  it("notes when vaccination records will be uploaded", () => {
    const plan = buildSubmissionPlan(makeApplication({ children: [makeChild({ dateOfBirth: "2023-01-10" })] }));
    expect(buildStudentSummary(plan, plan.children[0])).toContain("Vaccination records: to be uploaded in OpenApply");
  });
});
