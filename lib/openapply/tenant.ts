/**
 * KSI Montenegro OpenApply field catalogue (tenant https://ksimontenegro.openapply.com).
 * OpenApply keys custom fields by numeric field ID on write and expects option IDs for
 * radio/select fields; Yes/No fields use option IDs "1" and "0".
 */
export const STUDENT_FIELDS = {
  nationality: { id: 30, slug: "nationality", kind: "option" },
  language: { id: 40, slug: "language", kind: "option" },
  englishLevel: { id: 357797, slug: "english_level", kind: "option" },
  priorSchool: { id: 17, slug: "prior_school", kind: "text" },
  currentGrade: { id: 124830, slug: "current_grade", kind: "text" },
  familySituation: { id: 357715, slug: "family_situation", kind: "option" },
  repeatedGrade: { id: 357781, slug: "grade_repeat_y_n", kind: "option" },
  attendedRegularly: { id: 357786, slug: "attended_school_regularly_y_n", kind: "option" },
  attendanceDetails: { id: 357787, slug: "attended_school_regularly_details", kind: "text" },
  discipline: { id: 357788, slug: "discipline_y_n", kind: "option" },
  disciplineDetails: { id: 357789, slug: "discipline_details", kind: "text" },
  learningEvaluated: { id: 357764, slug: "learning_disabilities_y_n", kind: "option" },
  learningDetails: { id: 357766, slug: "learning_disability_details", kind: "text" },
  eal: { id: 357760, slug: "eal_programme_y_n", kind: "option" },
  medical: { id: 358466, slug: "medical_conditions_y_n", kind: "option" },
  medicalDetails: { id: 358467, slug: "medical_conditions_details", kind: "text" },
  photoConsent: { id: 357895, slug: "photo_video_permissions_y_n", kind: "option" },
  googleConsent: { id: 470505, slug: "google_edu_services", kind: "option" },
  summary: { id: 124870, slug: "additional_information", kind: "text" },
} as const;

export const PARENT_FIELDS = {
  mobile: { id: 75, slug: "mobile_phone", kind: "text" },
} as const;

export const OPTION = {
  yes: "1",
  no: "0",
  /** FieldTerms: "1" stores the terms as accepted. */
  termsAccepted: "1",
  englishLevel: { fluent: "484343", proficient: "484344", basic: "484345" },
  familySituation: { together: "484311", divorcedOrSeparated: "484313", deceased: "484314" },
} as const;

export const RELATIONSHIP_ROLES = [
  "father",
  "mother",
  "stepfather",
  "stepmother",
  "grandmother",
  "grandfather",
  "sister",
  "brother",
  "uncle",
  "aunt",
  "other guardian",
  "legal guardian",
  "consultant/recruiter",
] as const;

export type StudentFieldKey = keyof typeof STUDENT_FIELDS;
export type ParentFieldKey = keyof typeof PARENT_FIELDS;
export type FieldTarget = { id: number; slug: string | null };

export type FieldTargets = {
  student: Record<StudentFieldKey, FieldTarget | null>;
  parent: Record<ParentFieldKey, FieldTarget | null>;
  warnings: string[];
};

function defaults<T extends Record<string, { id: number; slug: string }>>(fields: T) {
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, { id: field.id, slug: field.slug }])) as Record<
    keyof T,
    FieldTarget | null
  >;
}

function applyOverrides(
  scope: "student" | "parent",
  fields: Record<string, { id: number; slug: string; kind: string }>,
  targets: Record<string, FieldTarget | null>,
  overrides: unknown,
  warnings: string[],
) {
  if (overrides === undefined) return;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    warnings.push(`OPENAPPLY_CUSTOM_FIELD_MAP.${scope} must be an object.`);
    return;
  }
  for (const [key, value] of Object.entries(overrides)) {
    const field = fields[key];
    if (!field) {
      warnings.push(`Ignoring unknown OPENAPPLY_CUSTOM_FIELD_MAP key ${scope}.${key}.`);
      continue;
    }
    if (value === null || value === false || value === "") {
      targets[key] = null;
      continue;
    }
    const id = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) {
      warnings.push(`Ignoring ${scope}.${key}: use a numeric OpenApply field ID or null.`);
    } else if (field.kind !== "text") {
      warnings.push(`Ignoring ${scope}.${key}: option fields can only be disabled (null), because their option IDs are tenant-specific.`);
    } else {
      targets[key] = { id, slug: id === field.id ? field.slug : null };
    }
  }
}

/**
 * Built-in targets, optionally adjusted by OPENAPPLY_CUSTOM_FIELD_MAP:
 * {"student": {"summary": 123456, "photoConsent": null}, "parent": {"mobile": null}}
 * A numeric ID retargets a text field; null disables a field.
 */
export function resolveFieldTargets(raw: string | undefined = process.env.OPENAPPLY_CUSTOM_FIELD_MAP): FieldTargets {
  const targets: FieldTargets = { student: defaults(STUDENT_FIELDS), parent: defaults(PARENT_FIELDS), warnings: [] };
  const value = raw?.trim();
  if (!value || value === "{}") return targets;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    targets.warnings.push("OPENAPPLY_CUSTOM_FIELD_MAP is not valid JSON; using the built-in field map.");
    return targets;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    targets.warnings.push("OPENAPPLY_CUSTOM_FIELD_MAP must be a JSON object; using the built-in field map.");
    return targets;
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "student" && key !== "parent") targets.warnings.push(`Ignoring unknown OPENAPPLY_CUSTOM_FIELD_MAP section ${key}.`);
  }
  applyOverrides("student", STUDENT_FIELDS, targets.student, record.student, targets.warnings);
  applyOverrides("parent", PARENT_FIELDS, targets.parent, record.parent, targets.warnings);
  return targets;
}
