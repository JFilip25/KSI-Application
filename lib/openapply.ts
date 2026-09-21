import type { ApplicationData } from "./schema";
import { getSuggestedPlacement } from "./placement";

type JsonRecord = Record<string, unknown>;
type FieldMap = {
  student?: Record<string, string>;
  parent?: Record<string, string>;
};

type OpenApplyResult = {
  reference: string;
  dryRun: boolean;
  parentIds: string[];
  studentIds: string[];
};

let tokenCache: { token: string; expiresAt: number } | null = null;

function config() {
  const dryRunValue = process.env.OPENAPPLY_DRY_RUN
    ?.trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();

  return {
    baseUrl: process.env.OPENAPPLY_BASE_URL?.replace(/\/$/, ""),
    clientId: process.env.OPENAPPLY_CLIENT_ID,
    clientSecret: process.env.OPENAPPLY_CLIENT_SECRET,
    dryRun: dryRunValue !== "false",
  };
}

function customFieldMap(): FieldMap {
  try {
    return JSON.parse(process.env.OPENAPPLY_CUSTOM_FIELD_MAP || "{}") as FieldMap;
  } catch {
    throw new Error("OPENAPPLY_CUSTOM_FIELD_MAP must be valid JSON.");
  }
}

async function accessToken() {
  const settings = config();
  if (!settings.baseUrl || !settings.clientId || !settings.clientSecret) {
    throw new Error("OpenApply is not configured.");
  }
  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) return tokenCache.token;

  const response = await fetch(`${settings.baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`OpenApply authentication failed (${response.status}).`);
  }
  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("OpenApply returned no access token.");
  tokenCache = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return tokenCache.token;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const settings = config();
  if (!settings.baseUrl) throw new Error("OpenApply is not configured.");
  const token = await accessToken();
  const response = await fetch(`${settings.baseUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    cache: "no-store",
  });
  const raw = await response.text();
  const body = raw ? (JSON.parse(raw) as T) : ({} as T);
  if (!response.ok) {
    const safeMessage = response.status >= 500 ? "OpenApply is temporarily unavailable." : "OpenApply rejected the submitted record.";
    throw new Error(`${safeMessage} (${response.status})`);
  }
  return body;
}

function collection(body: unknown, key: string): JsonRecord[] {
  if (Array.isArray(body)) return body as JsonRecord[];
  if (!body || typeof body !== "object") return [];
  const record = body as JsonRecord;
  if (Array.isArray(record[key])) return record[key] as JsonRecord[];
  if (Array.isArray(record.data)) return record.data as JsonRecord[];
  return [];
}

function recordId(body: unknown): string {
  if (!body || typeof body !== "object") throw new Error("OpenApply returned an invalid record.");
  const record = body as JsonRecord;
  const nested = record.data && typeof record.data === "object" ? (record.data as JsonRecord) : record;
  const id = nested.id ?? nested.uuid;
  if (typeof id !== "string" && typeof id !== "number") {
    throw new Error("OpenApply returned a record without an ID.");
  }
  return String(id);
}

async function findParent(email: string) {
  const body = await request<unknown>(`/api/v3/parents?email=${encodeURIComponent(email)}&per_page=100`);
  const match = collection(body, "parents").find(
    (parent) => String(parent.email ?? "").toLowerCase() === email.toLowerCase(),
  );
  return match ? recordId(match) : null;
}

async function createParent(parent: ApplicationData["parent1"]) {
  const existing = await findParent(parent.email);
  if (existing) return existing;
  const body = await request<unknown>("/api/v3/parents", {
    method: "POST",
    body: JSON.stringify({
      first_name: parent.firstName,
      last_name: parent.lastName,
      email: parent.email,
      country: parent.country,
    }),
  });
  return recordId(body);
}

async function findStudent(child: ApplicationData["children"][number], enrollmentYear: number) {
  const params = new URLSearchParams({
    first_name: child.firstName,
    last_name: child.lastName,
    per_page: "100",
  });
  const body = await request<unknown>(`/api/v3/students?${params}`);
  const match = collection(body, "students").find((student) =>
    String(student.first_name ?? "").toLowerCase() === child.firstName.toLowerCase() &&
    String(student.last_name ?? "").toLowerCase() === child.lastName.toLowerCase() &&
    String(student.birth_date ?? "").slice(0, 10) === child.dateOfBirth &&
    Number(student.enrollment_year ?? enrollmentYear) === enrollmentYear,
  );
  return match ? recordId(match) : null;
}

async function createStudent(child: ApplicationData["children"][number], application: ApplicationData) {
  const enrollmentYear = Number(application.academicYear.slice(0, 4));
  const existing = await findStudent(child, enrollmentYear);
  if (existing) return existing;
  const placement = getSuggestedPlacement(child.dateOfBirth, application.academicYear);
  const body = await request<unknown>("/api/v3/students", {
    method: "POST",
    body: JSON.stringify({
      first_name: child.firstName,
      last_name: child.lastName,
      preferred_name: child.preferredName || undefined,
      birth_date: child.dateOfBirth,
      gender: child.gender === "prefer-not-to-say" ? undefined : child.gender,
      country: child.nationality,
      grade: placement?.group,
      enrollment_year: enrollmentYear,
      status: "applied",
    }),
  });
  return recordId(body);
}

async function linkParent(parentId: string, studentIds: string[]) {
  await request(`/api/v3/relationships/parent/${encodeURIComponent(parentId)}`, {
    method: "PUT",
    body: JSON.stringify({ student_ids: studentIds }),
  });
}

async function patchCustomFields(kind: "student" | "parent", id: string, values: Record<string, unknown>) {
  const mapping = customFieldMap()[kind] ?? {};
  const fields = Object.entries(values)
    .filter(([key, value]) => mapping[key] && value !== "" && value !== undefined)
    .map(([key, value]) => ({ id: mapping[key], value }));
  if (!fields.length) return;
  await request(`/api/v3/${kind}s/${encodeURIComponent(id)}/custom_fields`, {
    method: "PATCH",
    body: JSON.stringify({ custom_fields: fields }),
  });
}

export async function pushApplication(application: ApplicationData): Promise<OpenApplyResult> {
  const settings = config();
  if (settings.dryRun) {
    return {
      reference: application.applicationReference,
      dryRun: true,
      parentIds: [],
      studentIds: [],
    };
  }

  const parent1Id = await createParent(application.parent1);
  const parent2Id = application.parent2 ? await createParent(application.parent2) : null;
  const studentIds: string[] = [];

  for (const child of application.children) {
    const studentId = await createStudent(child, application);
    studentIds.push(studentId);
    const placement = getSuggestedPlacement(child.dateOfBirth, application.academicYear);
    await patchCustomFields("student", studentId, {
      application_reference: application.applicationReference,
      academic_year: application.academicYear,
      recommended_year_group: placement?.group,
      current_school: child.currentSchool,
      current_grade: child.currentGrade,
      entry_timing: child.entryTiming,
      home_language: child.homeLanguage === "Other / not listed" ? child.otherHomeLanguage : child.homeLanguage,
      english_level: child.englishLevel,
      learning_needs: child.learningNeeds.join(", "),
      learning_plan: child.learningPlan,
      medical_needs: child.medicalNeeds.join(", "),
      medical_action: child.medicalAction,
      attendance: child.attendance,
      repeated_grade: child.repeatedGrade,
      serious_discipline: child.seriousDiscipline,
      disclosure_note: child.disclosureNote,
    });
  }

  await linkParent(parent1Id, studentIds);
  await patchCustomFields("parent", parent1Id, {
    mobile: application.parent1.mobile,
    family_situation: application.familySituation,
    legal_responsibility: application.legalResponsibility,
    parent_2_consent: application.parent2Consent,
    court_restrictions: application.courtRestrictions,
    google_education_consent: application.declarations.googleEducation ? "yes" : "no",
    marketing_consent: application.declarations.marketingConsent,
  });
  if (parent2Id) await linkParent(parent2Id, studentIds);

  return {
    reference: application.applicationReference,
    dryRun: false,
    parentIds: [parent1Id, ...(parent2Id ? [parent2Id] : [])],
    studentIds,
  };
}
