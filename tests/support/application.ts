import { randomUUID } from "node:crypto";
import type { ApplicationData } from "@/lib/schema";

type Child = ApplicationData["children"][number];
type Parent = ApplicationData["parent1"];

export function makeChild(overrides: Partial<Child> = {}): Child {
  return {
    id: randomUUID(),
    firstName: "Sam",
    lastName: "Example",
    preferredName: "",
    dateOfBirth: "2018-10-12",
    gender: "female",
    nationality: "ME",
    currentSchool: "Example Primary",
    currentGrade: "Year 3",
    entryTiming: "start-of-year",
    homeLanguage: "Montenegrin",
    otherHomeLanguage: "",
    englishLevel: "proficient",
    learningNeeds: ["No known learning support needs"],
    learningPlan: "none",
    medicalNeeds: ["No condition the school needs to plan for"],
    medicalAction: "none",
    attendance: "regular",
    repeatedGrade: "no",
    seriousDiscipline: "no",
    disclosureNote: "",
    ...overrides,
  };
}

export function makeParent(overrides: Partial<Parent> = {}): Parent {
  return {
    firstName: "Alex",
    lastName: "Example",
    relationship: "mother",
    email: "alex.example@example.com",
    mobile: "+382 67 000 000",
    country: "ME",
    ...overrides,
  };
}

export function makeApplication(overrides: Partial<ApplicationData> = {}): ApplicationData {
  return {
    academicYear: "2026-2027",
    children: [makeChild()],
    parent1: makeParent(),
    familySituation: "together",
    legalResponsibility: "joint",
    parent2: makeParent({ firstName: "Jordan", relationship: "father", email: "jordan.example@example.com", mobile: "+382 69 111 222" }),
    parent2Consent: "signing-now",
    courtRestrictions: "none",
    declarations: { accuracy: true, authority: true, privacy: true, googleEducation: true, marketingConsent: "yes" },
    applicationReference: randomUUID(),
    startedAt: Date.now() - 60_000,
    website: "",
    ...overrides,
  };
}
