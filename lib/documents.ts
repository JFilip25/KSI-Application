import { getAgeOnSeptemberFirst, getSuggestedPlacement, type AcademicYear } from "./placement";

/**
 * Which documents a family is asked to upload in OpenApply after applying. Used by the form's
 * review step and thank-you page, the confirmation email and the OpenApply summary, so all four
 * always list the same documents.
 */

type PersonInput = { firstName: string; lastName: string };

export type DocumentInput = {
  academicYear: AcademicYear;
  familySituation: string;
  courtRestrictions: string;
  parent1: PersonInput;
  parent2?: PersonInput;
  children: (PersonInput & {
    dateOfBirth: string;
    vaccinationRecords?: "will-provide" | "not-available";
  })[];
};

export type DocumentItem = {
  key: string;
  label: string;
  /** "acknowledged-missing": the family declared it cannot provide this document. */
  status: "required" | "acknowledged-missing";
};

export type DocumentList = {
  family: DocumentItem[];
  children: { name: string; items: DocumentItem[] }[];
};

const VACCINATION_GROUPS = new Set(["Nursery", "Reception", "Year 1"]);
export const TRANSCRIPT_MIN_AGE = 12;

function fullName(person: PersonInput, fallback: string) {
  const name = `${person.firstName} ${person.lastName}`.replace(/\s+/g, " ").trim();
  return name || fallback;
}

/** Nursery, Reception and Year 1 applicants provide vaccination records (or acknowledge they can't). */
export function needsVaccinationRecords(dateOfBirth: string, academicYear: AcademicYear) {
  const placement = getSuggestedPlacement(dateOfBirth, academicYear);
  return placement !== null && VACCINATION_GROUPS.has(placement.group);
}

/** Students aged 12 or older on 1 September provide their last two years of school reports. */
export function needsTranscripts(dateOfBirth: string, academicYear: AcademicYear) {
  const age = getAgeOnSeptemberFirst(dateOfBirth, academicYear);
  return age !== null && age >= TRANSCRIPT_MIN_AGE;
}

export function requiredDocuments(input: DocumentInput): DocumentList {
  const family: DocumentItem[] = [
    { key: "parent1-passport", label: `Passport copy — ${fullName(input.parent1, "parent/guardian 1")}`, status: "required" },
  ];
  // Parent 2's documents are requested only when their details were given and no court order or
  // restriction was declared (Admissions follows up privately in that case).
  if (input.parent2 && input.courtRestrictions === "none") {
    family.push({ key: "parent2-passport", label: `Passport copy — ${fullName(input.parent2, "parent/guardian 2")}`, status: "required" });
  }
  if (input.familySituation === "separated" || input.familySituation === "divorced") {
    family.push({ key: "other-parent-consent", label: "Signed consent to this application from the other parent", status: "required" });
  }

  const children = input.children.map((child, index) => {
    const items: DocumentItem[] = [
      { key: `child${index}-passport`, label: "Passport copy", status: "required" },
      { key: `child${index}-birth-certificate`, label: "Birth certificate", status: "required" },
    ];
    if (needsVaccinationRecords(child.dateOfBirth, input.academicYear)) {
      items.push(
        child.vaccinationRecords === "not-available"
          ? { key: `child${index}-vaccinations`, label: "Vaccination records — not provided (acknowledged)", status: "acknowledged-missing" }
          : { key: `child${index}-vaccinations`, label: "Vaccination records", status: "required" },
      );
    }
    if (needsTranscripts(child.dateOfBirth, input.academicYear)) {
      items.push({ key: `child${index}-transcripts`, label: "School reports / transcripts from the last two school years", status: "required" });
    }
    return { name: fullName(child, `Child ${index + 1}`), items };
  });

  return { family, children };
}

/** Plain-text lines ("- …"): the family's documents plus every child's, or only one child's. */
export function documentLines(list: DocumentList, childIndex?: number) {
  const lines = list.family.map((item) => `- ${item.label}`);
  list.children.forEach((child, index) => {
    if (childIndex !== undefined && index !== childIndex) return;
    for (const item of child.items) lines.push(`- ${child.name}: ${item.label}`);
  });
  return lines;
}
