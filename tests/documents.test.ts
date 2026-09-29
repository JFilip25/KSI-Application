import { describe, expect, it } from "vitest";
import { documentLines, needsTranscripts, needsVaccinationRecords, requiredDocuments } from "@/lib/documents";
import { ApplicationSchema } from "@/lib/schema";
import { makeApplication, makeChild, makeParent } from "./support/application";

const labels = (items: { label: string }[]) => items.map((item) => item.label);
const sole = { legalResponsibility: "sole-parent-1" as const, parent2: undefined, parent2Consent: "evidence-exception" as const };

describe("requiredDocuments", () => {
  it("asks every family for parent 1's passport and each child's passport and birth certificate", () => {
    const documents = requiredDocuments(makeApplication({ ...sole, familySituation: "sole-parent", children: [makeChild({ firstName: "Sam" })] }));
    expect(labels(documents.family)).toEqual(["Passport copy — Alex Example"]);
    expect(documents.children).toEqual([
      {
        name: "Sam Example",
        items: [
          { key: "child0-passport", label: "Passport copy", status: "required" },
          { key: "child0-birth-certificate", label: "Birth certificate", status: "required" },
        ],
      },
    ]);
  });

  it("asks for parent 2's passport only when their details were given and no restriction was declared", () => {
    expect(labels(requiredDocuments(makeApplication()).family)).toContain("Passport copy — Jordan Example");
    expect(labels(requiredDocuments(makeApplication({ courtRestrictions: "yes-admissions-follow-up" })).family)).not.toContain("Passport copy — Jordan Example");
    expect(requiredDocuments(makeApplication(sole)).family).toHaveLength(1);
  });

  it("asks separated or divorced parents for the other parent's consent", () => {
    const consent = "Signed consent to this application from the other parent";
    expect(labels(requiredDocuments(makeApplication({ familySituation: "separated" })).family)).toContain(consent);
    expect(labels(requiredDocuments(makeApplication({ familySituation: "divorced" })).family)).toContain(consent);
    for (const familySituation of ["together", "sole-parent", "widowed", "other"] as const) {
      expect(labels(requiredDocuments(makeApplication({ familySituation })).family)).not.toContain(consent);
    }
  });

  it("asks for vaccination records for Nursery, Reception and Year 1 only", () => {
    // 2026–27 cohorts: Nursery 2022-09..2023-08, Reception 2021-09..2022-08, Year 1 2020-09..2021-08, Year 2 2019-09..2020-08.
    for (const [dateOfBirth, expected] of [
      ["2023-01-10", true],
      ["2022-03-10", true],
      ["2020-09-01", true],
      ["2020-08-31", false],
      ["2025-01-01", false],
    ] as const) {
      expect(needsVaccinationRecords(dateOfBirth, "2026-2027"), dateOfBirth).toBe(expected);
    }
    const documents = requiredDocuments(
      makeApplication({
        children: [
          makeChild({ firstName: "Mila", dateOfBirth: "2022-03-10" }),
          makeChild({ firstName: "Iva", dateOfBirth: "2022-05-01", vaccinationRecords: "not-available", vaccinationAcknowledgement: true }),
        ],
      }),
    );
    expect(documents.children[0].items).toContainEqual({ key: "child0-vaccinations", label: "Vaccination records", status: "required" });
    expect(documents.children[1].items).toContainEqual({
      key: "child1-vaccinations",
      label: "Vaccination records — not provided (acknowledged)",
      status: "acknowledged-missing",
    });
  });

  it("asks students aged 12 or older on 1 September for their last two years of reports", () => {
    expect(needsTranscripts("2014-09-01", "2026-2027")).toBe(true);
    expect(needsTranscripts("2014-09-02", "2026-2027")).toBe(false);
    expect(needsTranscripts("2014-09-02", "2027-2028")).toBe(true);
    // Older than the placement table still counts.
    expect(needsTranscripts("2007-01-01", "2026-2027")).toBe(true);
    const documents = requiredDocuments(makeApplication({ children: [makeChild({ dateOfBirth: "2013-05-20" })] }));
    expect(labels(documents.children[0].items)).toContain("School reports / transcripts from the last two school years");
  });

  it("formats plain-text lines for the whole family or one child", () => {
    const documents = requiredDocuments(
      makeApplication({ ...sole, children: [makeChild({ firstName: "Mila" }), makeChild({ firstName: "Luka", dateOfBirth: "2013-05-20" })] }),
    );
    expect(documentLines(documents, 1)).toEqual([
      "- Passport copy — Alex Example",
      "- Luka Example: Passport copy",
      "- Luka Example: Birth certificate",
      "- Luka Example: School reports / transcripts from the last two school years",
    ]);
    expect(documentLines(documents)).toHaveLength(1 + 2 + 3);
  });
});

describe("vaccination acknowledgement", () => {
  const reception = (overrides = {}) => makeApplication({ children: [makeChild({ dateOfBirth: "2022-03-10", ...overrides })] });

  it("is required when a Reception child's records can't be provided", () => {
    const missing = ApplicationSchema.safeParse(reception({ vaccinationRecords: "not-available", vaccinationAcknowledgement: false }));
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0].path).toEqual(["children", 0, "vaccinationAcknowledgement"]);
    expect(ApplicationSchema.safeParse(reception({ vaccinationRecords: "not-available", vaccinationAcknowledgement: true })).success).toBe(true);
    expect(ApplicationSchema.safeParse(reception({ vaccinationRecords: "will-provide" })).success).toBe(true);
  });

  it("is not required for older children", () => {
    const application = makeApplication({ children: [makeChild({ dateOfBirth: "2018-10-12", vaccinationRecords: "not-available" })] });
    expect(ApplicationSchema.safeParse(application).success).toBe(true);
  });

  it("keeps drafts saved before the question existed valid", () => {
    const child = makeChild({ dateOfBirth: "2022-03-10" }) as Record<string, unknown>;
    delete child.vaccinationRecords;
    delete child.vaccinationAcknowledgement;
    const parsed = ApplicationSchema.safeParse({ ...makeApplication(), children: [child] });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.children[0]).toMatchObject({ vaccinationRecords: "will-provide", vaccinationAcknowledgement: false });
  });

  it("uses the parent's names in the passport labels", () => {
    const documents = requiredDocuments(makeApplication({ parent1: makeParent({ firstName: "  Ana ", lastName: "Šćekić" }) }));
    expect(documents.family[0].label).toBe("Passport copy — Ana Šćekić");
  });
});
