import { describe, expect, it } from "vitest";
import { ApplicationSchema } from "../lib/schema";

function validApplication() {
  const parent = {
    firstName: "Alex",
    lastName: "Example",
    relationship: "mother",
    email: "alex@example.com",
    mobile: "+382 67 000 000",
    country: "ME",
  } as const;

  return {
    academicYear: "2027-2028",
    children: [{
      id: "bd6f20e1-4fd2-4aee-a0a9-6689f16a0be4",
      firstName: "Sam",
      lastName: "Example",
      preferredName: "",
      dateOfBirth: "2018-10-12",
      gender: "prefer-not-to-say",
      nationality: "ME",
      currentSchool: "Example School",
      currentGrade: "Year 3",
      entryTiming: "start-of-year",
      homeLanguage: "English",
      otherHomeLanguage: "",
      englishLevel: "fluent",
      learningNeeds: ["No known learning support needs"],
      learningPlan: "none",
      medicalNeeds: ["No condition the school needs to plan for"],
      medicalAction: "none",
      attendance: "regular",
      repeatedGrade: "no",
      seriousDiscipline: "no",
      disclosureNote: "",
    }],
    parent1: parent,
    parent2: { ...parent, email: "parent2@example.com", relationship: "father" },
    familySituation: "together",
    legalResponsibility: "joint",
    parent2Consent: "signing-now",
    courtRestrictions: "none",
    declarations: {
      accuracy: true,
      authority: true,
      privacy: true,
      googleEducation: true,
      marketingConsent: "no",
    },
    applicationReference: "7f83283e-4042-4eb7-9706-0bf901f14045",
    startedAt: 1_700_000_000_000,
    website: "",
  };
}

describe("ApplicationSchema", () => {
  it("accepts a complete sibling-ready application", () => {
    expect(ApplicationSchema.safeParse(validApplication()).success).toBe(true);
  });

  it("requires the second parent for joint responsibility", () => {
    const application = validApplication();
    delete (application as { parent2?: unknown }).parent2;
    expect(ApplicationSchema.safeParse(application).success).toBe(false);
  });

  it("allows a verified exception route without parent 2 details", () => {
    const application = validApplication();
    delete (application as { parent2?: unknown }).parent2;
    return expect(ApplicationSchema.safeParse({
      ...application,
      legalResponsibility: "sole-parent-1",
      parent2Consent: "evidence-exception",
    }).success).toBe(true);
  });

  it("requires Google Education consent and a marketing choice", () => {
    const application = validApplication();
    expect(ApplicationSchema.safeParse({
      ...application,
      declarations: {
        ...application.declarations,
        googleEducation: false,
        marketingConsent: "",
      },
    }).success).toBe(false);
  });
});
