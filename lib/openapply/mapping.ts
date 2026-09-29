import { documentLines, needsVaccinationRecords, requiredDocuments } from "../documents";
import { getSuggestedPlacement } from "../placement";
import type { ApplicationData } from "../schema";
import type { OARelationship, OAStudent, ParentCreate, StudentCreate } from "./api";
import { OPENAPPLY_COUNTRIES } from "./data/countries";
import { OPENAPPLY_LANGUAGES } from "./data/languages";
import { OPTION, type FieldTarget, type StudentFieldKey } from "./tenant";

type Child = ApplicationData["children"][number];
type Parent = ApplicationData["parent1"];

/** Same normalization as scripts/generate-openapply-data.mjs uses for option lookups. */
export function normalizeKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function cleanText(value: string) {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function clip(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export const LABELS = {
  gender: { female: "Female", male: "Male", nonbinary: "Non-binary", "prefer-not-to-say": "Prefer not to say" },
  entryTiming: { "start-of-year": "Start of the academic year", "during-year": "During the school year" },
  englishLevel: {
    fluent: "Fluent",
    proficient: "Proficient",
    developing: "Developing",
    beginner: "Beginner",
    "not-yet-assessed": "Not yet assessed",
  },
  learningPlan: {
    none: "No",
    "current-plan": "Current plan / assessment",
    "previous-plan": "Previous plan / assessment",
    "assessment-in-progress": "Assessment in progress",
  },
  medicalAction: {
    none: "No current action",
    "emergency-plan": "Emergency plan",
    medication: "Medication at school",
    "staff-training": "Staff awareness / training",
    "access-adjustment": "Access adjustment",
    other: "Another arrangement",
  },
  attendance: { regular: "Regular", "some-concern": "Some concern", "significant-concern": "Significant concern" },
  repeatedGrade: { no: "No", yes: "Yes" },
  seriousDiscipline: { no: "No", "yes-current-school": "Yes, current school", "yes-previous-school": "Yes, previous school" },
  familySituation: {
    together: "Parents together",
    separated: "Parents separated",
    divorced: "Parents divorced",
    "sole-parent": "Sole-parent family",
    widowed: "One parent deceased",
    other: "Another legal arrangement",
  },
  legalResponsibility: {
    joint: "Both parents / guardians",
    "sole-parent-1": "Parent 1 only",
    "restricted-parent-2": "Parent 2 authority is restricted",
    "parent-2-deceased": "Parent 2 is deceased",
    "parent-2-uncontactable": "Parent 2 cannot reasonably be contacted",
  },
  parent2Consent: {
    "signing-now": "Consenting with this application",
    "secure-request": "Separate consent needed (Admissions to send a secure request)",
    "evidence-exception": "Second consent is not applicable",
  },
  courtRestrictions: { none: "No", "yes-admissions-follow-up": "Yes — contact the family privately" },
  relationship: {
    mother: "Mother",
    father: "Father",
    stepmother: "Stepmother",
    stepfather: "Stepfather",
    "step-parent": "Step-parent",
    "legal-guardian": "Legal guardian",
    "other-guardian": "Other guardian",
  },
  marketingConsent: { yes: "Yes", no: "No" },
} as const;

const RELATIONSHIP_ROLE: Record<Parent["relationship"], string> = {
  mother: "mother",
  father: "father",
  stepmother: "stepmother",
  stepfather: "stepfather",
  // Legacy drafts: OpenApply has no neutral step-parent role; this is also its default.
  "step-parent": "other guardian",
  "legal-guardian": "legal guardian",
  "other-guardian": "other guardian",
};

const ENGLISH_LEVEL: Partial<Record<Child["englishLevel"], string>> = {
  fluent: OPTION.englishLevel.fluent,
  proficient: OPTION.englishLevel.proficient,
  developing: OPTION.englishLevel.basic,
  beginner: OPTION.englishLevel.basic,
};

const FAMILY_SITUATION: Partial<Record<ApplicationData["familySituation"], string>> = {
  together: OPTION.familySituation.together,
  separated: OPTION.familySituation.divorcedOrSeparated,
  divorced: OPTION.familySituation.divorcedOrSeparated,
  widowed: OPTION.familySituation.deceased,
};

const LANGUAGE_ALIASES: Record<string, string> = {
  "mandarin chinese": "mandarin",
  "chinese mandarin": "mandarin",
  farsi: "persian",
  "serbo croat": "serbo croatian",
  bcms: "serbo croatian",
};

const NO_LEARNING_NEEDS = "No known learning support needs";
const NO_MEDICAL_NEEDS = "No condition the school needs to plan for";
const EAL = "English as an Additional Language";
const OTHER_LANGUAGE = "Other / not listed";

export function languageOption(child: Pick<Child, "homeLanguage" | "otherHomeLanguage">) {
  const label = child.homeLanguage === OTHER_LANGUAGE ? child.otherHomeLanguage : child.homeLanguage;
  if (!label) return null;
  const key = normalizeKey(label);
  return OPENAPPLY_LANGUAGES[LANGUAGE_ALIASES[key] ?? key] ?? null;
}

export function homeLanguageLabel(child: Pick<Child, "homeLanguage" | "otherHomeLanguage">) {
  return child.homeLanguage === OTHER_LANGUAGE ? `Other: ${child.otherHomeLanguage || "not specified"}` : child.homeLanguage;
}

export function countryName(code: string) {
  return OPENAPPLY_COUNTRIES[code]?.country ?? code;
}

export function nationalityName(code: string) {
  return OPENAPPLY_COUNTRIES[code]?.nationality ?? countryName(code);
}

export function relationshipRole(relationship: Parent["relationship"]) {
  return RELATIONSHIP_ROLE[relationship];
}

export function parentPayload(parent: Parent): ParentCreate {
  return {
    first_name: cleanText(parent.firstName),
    last_name: cleanText(parent.lastName),
    email: parent.email.trim().toLowerCase(),
  };
}

export function studentPayload(child: Child, application: ApplicationData): StudentCreate {
  const placement = getSuggestedPlacement(child.dateOfBirth, application.academicYear);
  const residence = OPENAPPLY_COUNTRIES[application.parent1.country];
  const preferredName = cleanText(child.preferredName);
  return {
    first_name: cleanText(child.firstName),
    last_name: cleanText(child.lastName),
    ...(preferredName ? { preferred_name: preferredName } : {}),
    birth_date: child.dateOfBirth,
    // OpenApply accepts only "Male", "Female" or no value; other answers are kept in the summary.
    ...(child.gender === "female" ? { gender: "Female" as const } : child.gender === "male" ? { gender: "Male" as const } : {}),
    ...(placement ? { grade: placement.group } : {}),
    enrollment_year: Number(application.academicYear.slice(0, 4)),
    // Created as pending and moved to applied once parents are linked, so OpenApply's own
    // "applied" status event fires with the family attached.
    status: "pending",
    ...(residence ? { country_id: residence.countryId } : {}),
  };
}

/** Values for KSI's existing student fields (option IDs for radio/select fields). */
export function studentFieldValues(child: Child, application: ApplicationData) {
  const values: Partial<Record<StudentFieldKey, string>> = {};
  const nationality = OPENAPPLY_COUNTRIES[child.nationality]?.nationalityId;
  if (nationality) values.nationality = String(nationality);
  const language = languageOption(child);
  if (language) values.language = String(language.id);
  const english = ENGLISH_LEVEL[child.englishLevel];
  if (english) values.englishLevel = english;
  const school = cleanText(child.currentSchool);
  if (school) values.priorSchool = clip(school, 180);
  const grade = cleanText(child.currentGrade);
  if (grade) values.currentGrade = clip(grade, 180);
  const family = FAMILY_SITUATION[application.familySituation];
  if (family) values.familySituation = family;

  values.repeatedGrade = child.repeatedGrade === "yes" ? OPTION.yes : OPTION.no;

  values.attendedRegularly = child.attendance === "regular" ? OPTION.yes : OPTION.no;
  if (child.attendance !== "regular") values.attendanceDetails = LABELS.attendance[child.attendance];

  values.discipline = child.seriousDiscipline === "no" ? OPTION.no : OPTION.yes;
  if (child.seriousDiscipline !== "no") values.disciplineDetails = LABELS.seriousDiscipline[child.seriousDiscipline];

  // OpenApply keeps a "Please explain" detail only when its Yes/No answer is Yes; support needs
  // without a plan or assessment are recorded in the summary.
  const learningNeeds = child.learningNeeds.filter((need) => need !== NO_LEARNING_NEEDS);
  values.learningEvaluated = child.learningPlan === "none" ? OPTION.no : OPTION.yes;
  if (child.learningPlan !== "none") {
    values.learningDetails = clip([LABELS.learningPlan[child.learningPlan], learningNeeds.join("; ")].filter(Boolean).join(" — "), 250);
  }
  values.eal = child.learningNeeds.includes(EAL) ? OPTION.yes : OPTION.no;

  const medicalNeeds = child.medicalNeeds.filter((need) => need !== NO_MEDICAL_NEEDS);
  const hasMedical = medicalNeeds.length > 0 || child.medicalAction !== "none";
  values.medical = hasMedical ? OPTION.yes : OPTION.no;
  if (hasMedical) {
    values.medicalDetails = clip(
      [medicalNeeds.join("; "), child.medicalAction !== "none" ? `School planning: ${LABELS.medicalAction[child.medicalAction]}` : ""]
        .filter(Boolean)
        .join(" — "),
      250,
    );
  }

  values.photoConsent = application.declarations.marketingConsent === "yes" ? OPTION.yes : OPTION.no;
  if (application.declarations.googleEducation) values.googleConsent = OPTION.termsAccepted;
  return values;
}

export const TEXT_FIELD_KEYS: readonly StudentFieldKey[] = [
  "priorSchool",
  "currentGrade",
  "attendanceDetails",
  "disciplineDetails",
  "learningDetails",
  "medicalDetails",
  "summary",
];

export function toCustomFields<K extends string>(values: Partial<Record<K, string>>, targets: Record<K, FieldTarget | null>) {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(values) as [K, string | undefined][]) {
    const target = targets[key];
    if (target && value !== undefined && value !== "") fields[String(target.id)] = value;
  }
  return fields;
}

export type PlannedParent = {
  slot: 1 | 2;
  source: Parent;
  payload: ParentCreate;
  role: string;
  mobile: string;
};

export type PlannedChild = {
  source: Child;
  payload: StudentCreate;
  fieldValues: Partial<Record<StudentFieldKey, string>>;
};

export type SubmissionPlan = {
  application: ApplicationData;
  reference: string;
  shortReference: string;
  submittedAt: Date;
  enrollmentYear: number;
  parent1: PlannedParent;
  parent2: PlannedParent | null;
  /** Why parent 2's details are kept in the summary instead of creating and linking them. */
  parent2Skipped: "same-email" | "court-restriction" | null;
  children: PlannedChild[];
  duplicateChildren: number;
  /** Submitted values that must never reach logs. */
  redact: string[];
  estimatedCalls: number;
};

function plannedParent(slot: 1 | 2, parent: Parent): PlannedParent {
  return { slot, source: parent, payload: parentPayload(parent), role: relationshipRole(parent.relationship), mobile: parent.mobile.trim() };
}

export function childIdentity(firstName: string, lastName: string, birthDate: string) {
  return [normalizeKey(firstName), normalizeKey(lastName), birthDate.slice(0, 10)].join("|");
}

export function sameChild(student: Pick<OAStudent, "first_name" | "last_name" | "birth_date">, child: PlannedChild) {
  return (
    !!student.first_name &&
    !!student.last_name &&
    !!student.birth_date &&
    childIdentity(student.first_name, student.last_name, student.birth_date) ===
      childIdentity(child.payload.first_name, child.payload.last_name, child.payload.birth_date)
  );
}

export function buildSubmissionPlan(application: ApplicationData, submittedAt = new Date()): SubmissionPlan {
  const parent1 = plannedParent(1, application.parent1);
  let parent2: PlannedParent | null = application.parent2 ? plannedParent(2, application.parent2) : null;
  let parent2Skipped: SubmissionPlan["parent2Skipped"] = null;
  if (parent2 && parent2.payload.email === parent1.payload.email) {
    parent2 = null;
    parent2Skipped = "same-email";
  } else if (parent2 && application.courtRestrictions === "yes-admissions-follow-up") {
    // Linking a parent grants OpenApply portal access, so Admissions decides after following up.
    parent2 = null;
    parent2Skipped = "court-restriction";
  }

  const seen = new Set<string>();
  const children: PlannedChild[] = [];
  for (const child of application.children) {
    const payload = studentPayload(child, application);
    const identity = childIdentity(payload.first_name, payload.last_name, payload.birth_date);
    if (seen.has(identity)) continue;
    seen.add(identity);
    children.push({ source: child, payload, fieldValues: studentFieldValues(child, application) });
  }

  const parents = [application.parent1, ...(application.parent2 ? [application.parent2] : [])];
  const redact = [
    ...parents.flatMap((parent) => [parent.firstName, parent.lastName, parent.email, parent.mobile]),
    ...application.children.flatMap((child) => [
      child.firstName,
      child.lastName,
      child.preferredName,
      child.dateOfBirth,
      child.currentSchool,
      child.otherHomeLanguage,
      child.disclosureNote,
    ]),
  ]
    .map((value) => value.trim())
    .filter((value) => value.length >= 3);

  const parentCount = parent2 ? 2 : 1;
  return {
    application,
    reference: application.applicationReference,
    shortReference: application.applicationReference.split("-")[0].toUpperCase(),
    submittedAt,
    enrollmentYear: Number(application.academicYear.slice(0, 4)),
    parent1,
    parent2,
    parent2Skipped,
    children,
    duplicateChildren: application.children.length - children.length,
    redact,
    estimatedCalls: 1 + parentCount * 5 + children.length * 4,
  };
}

function formatParent(parent: Parent) {
  return [
    `${cleanText(parent.firstName)} ${cleanText(parent.lastName)} (${LABELS.relationship[parent.relationship]})`,
    parent.email.trim(),
    parent.mobile.trim(),
    `lives in ${countryName(parent.country)}`,
  ].join(" · ");
}

/**
 * Readable record of every answer for one child, written to the student's summary field.
 * It holds only what the family entered: the field may be visible to linked parents.
 */
export function buildStudentSummary(plan: SubmissionPlan, child: PlannedChild, notes: readonly string[] = []) {
  const { application } = plan;
  const source = child.source;
  const academicYear = application.academicYear.replace("-", "–");
  const placement = getSuggestedPlacement(source.dateOfBirth, application.academicYear);
  const learningNeeds = source.learningNeeds.filter((need) => need !== NO_LEARNING_NEEDS);
  const medicalNeeds = source.medicalNeeds.filter((need) => need !== NO_MEDICAL_NEEDS);
  const siblings = plan.children.filter((other) => other !== child).map((other) => `${other.payload.first_name} ${other.payload.last_name}`);
  const submitted = plan.submittedAt.toISOString().replace("T", " ").slice(0, 16);
  const documents = documentLines(requiredDocuments(application), application.children.indexOf(source));
  const vaccination = needsVaccinationRecords(source.dateOfBirth, application.academicYear)
    ? source.vaccinationRecords === "not-available"
      ? "Vaccination records: NOT PROVIDED — the parent acknowledged that they have not provided the school with vaccination records and that the family may be fined by the Montenegrin authorities."
      : "Vaccination records: to be uploaded in OpenApply"
    : "";

  const lines = [
    `KSI Montenegro online application · ref ${plan.shortReference} · submitted ${submitted} UTC`,
    `Academic year: ${academicYear} · Suggested year group: ${
      placement ? `${placement.group} (age-based guide; ${placement.ageOnSeptemberFirst} on 1 September)` : "Admissions review needed"
    } · Joining: ${LABELS.entryTiming[source.entryTiming]}`,
    [
      source.preferredName.trim() ? `Preferred name: ${cleanText(source.preferredName)}` : "",
      `Gender: ${LABELS.gender[source.gender]}`,
      `Nationality: ${nationalityName(source.nationality)}`,
    ]
      .filter(Boolean)
      .join(" · "),
    `Home language: ${homeLanguageLabel(source)} · English level: ${LABELS.englishLevel[source.englishLevel]}`,
    `Current school: ${cleanText(source.currentSchool) || "Not yet at school"} · Current year/grade: ${cleanText(source.currentGrade) || "—"}`,
    `Learning support: ${learningNeeds.length ? learningNeeds.join("; ") : NO_LEARNING_NEEDS} · Learning plan or assessment: ${
      LABELS.learningPlan[source.learningPlan]
    }`,
    `Health or access needs: ${medicalNeeds.length ? medicalNeeds.join("; ") : NO_MEDICAL_NEEDS} · School planning: ${
      LABELS.medicalAction[source.medicalAction]
    }`,
    vaccination,
    `Attendance: ${LABELS.attendance[source.attendance]} · Repeated a grade: ${LABELS.repeatedGrade[source.repeatedGrade]} · Serious disciplinary action: ${
      LABELS.seriousDiscipline[source.seriousDiscipline]
    }`,
    source.disclosureNote.trim() ? `Family's note: ${source.disclosureNote.trim()}` : "",
    `Family situation: ${LABELS.familySituation[application.familySituation]} · Legal parental responsibility: ${
      LABELS.legalResponsibility[application.legalResponsibility]
    }`,
    `Parent/guardian 2 consent: ${LABELS.parent2Consent[application.parent2Consent]} · Court order or restriction: ${
      LABELS.courtRestrictions[application.courtRestrictions]
    }`,
    `Parent/guardian 1: ${formatParent(application.parent1)}`,
    application.parent2 ? `Parent/guardian 2: ${formatParent(application.parent2)}` : "",
    `Consents: Google Workspace for Education — given · Marketing (photo/video) — ${LABELS.marketingConsent[application.declarations.marketingConsent]}`,
    siblings.length ? `Siblings in this application: ${siblings.join(", ")}` : "",
    `Documents requested (the family uploads them in OpenApply):\n${documents.join("\n")}`,
    ...notes,
    `Full reference: ${plan.reference}`,
  ];
  return lines.filter(Boolean).join("\n");
}

const SUMMARY_SEPARATOR = "\n\n---\n";
const MAX_SUMMARY_LENGTH = 12_000;

/**
 * Combines a new summary with what the field already holds: replaces this submission's own
 * earlier block (a retry), keeps other submissions' blocks. Returns null when nothing changes.
 */
export function mergeSummary(existing: unknown, next: string, shortReference: string): string | null {
  const current = typeof existing === "string" ? existing.trim() : "";
  if (!current) return next;
  const marker = `ref ${shortReference} `;
  const blocks = current.split(SUMMARY_SEPARATOR);
  const index = blocks.findIndex((block) => block.includes(marker));
  if (index >= 0) {
    if (blocks[index].trim() === next.trim()) return null;
    blocks[index] = next;
  } else {
    blocks.push(next);
  }
  // Keep the newest blocks if the field would grow past a sensible size.
  while (blocks.length > 1 && blocks.join(SUMMARY_SEPARATOR).length > MAX_SUMMARY_LENGTH) blocks.shift();
  return blocks.join(SUMMARY_SEPARATOR);
}

/** Adds wanted links to a parent's existing ones (PUT replaces the whole set). */
export function mergeRelationships(existing: readonly OARelationship[], wanted: readonly OARelationship[]) {
  const byStudent = new Map<number, OARelationship>();
  for (const link of existing) byStudent.set(link.student_id, link);
  let changed = false;
  for (const link of wanted) {
    if (!byStudent.has(link.student_id)) {
      byStudent.set(link.student_id, link);
      changed = true;
    }
  }
  return { relationships: [...byStudent.values()], changed };
}
