import type { OpenApplyClient, RequestContext } from "./client";
import { OpenApplyError, type OpenApplyStep } from "./errors";

/**
 * Endpoint wrappers for the OpenApply v3 calls this app makes. Formats verified against the
 * KSI tenant (2026-09-29):
 * - create bodies are sent unwrapped; responses are wrapped as {parent: …} / {student: …};
 * - custom fields are keyed by numeric field ID and option fields take option IDs;
 * - PUT /relationships/parent/:id replaces the parent's whole set of children, roles are the
 *   lowercase values listed in RELATIONSHIP_ROLES, and a missing role becomes "other guardian".
 */

export type OAParent = {
  id: number;
  email: string | null;
  custom_fields: Record<string, unknown>;
};

export type OAStudent = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  birth_date: string | null;
  enrollment_year: number | null;
  status: string | null;
  archived: boolean;
  parent_ids: number[];
  custom_fields: Record<string, unknown>;
};

export type OARelationship = { student_id: number; relationship?: string };

export type ParentCreate = { first_name: string; last_name: string; email: string };

export type StudentCreate = {
  first_name: string;
  last_name: string;
  preferred_name?: string;
  birth_date: string;
  gender?: "Male" | "Female";
  grade?: string;
  enrollment_year: number;
  status: "pending" | "applied";
  country_id?: number;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function toId(value: unknown): number | null {
  const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof numeric === "number" && Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function text(value: unknown) {
  return typeof value === "string" ? value : value === null || value === undefined ? null : String(value);
}

function unwrap(body: unknown, key: "parent" | "student", step: OpenApplyStep, path: string): JsonRecord & { id: number } {
  const record = asRecord(body);
  const inner = asRecord(record?.[key]) ?? asRecord(record?.data) ?? record;
  const id = toId(inner?.id);
  if (!inner || id === null) {
    throw new OpenApplyError("invalid_response", `OpenApply returned a ${key} without an ID.`, { step, path, ambiguous: true });
  }
  return { ...inner, id };
}

function list(body: unknown, key: "parents" | "students"): JsonRecord[] {
  if (Array.isArray(body)) return body.filter((item): item is JsonRecord => asRecord(item) !== null);
  const record = asRecord(body);
  const items = record?.[key] ?? record?.data;
  return Array.isArray(items) ? items.filter((item): item is JsonRecord => asRecord(item) !== null) : [];
}

function toParent(record: JsonRecord): OAParent | null {
  const id = toId(record.id);
  if (id === null) return null;
  return { id, email: text(record.email), custom_fields: asRecord(record.custom_fields) ?? {} };
}

function toStudent(record: JsonRecord): OAStudent | null {
  const id = toId(record.id);
  if (id === null) return null;
  const year = Number(record.enrollment_year);
  return {
    id,
    first_name: text(record.first_name),
    last_name: text(record.last_name),
    birth_date: text(record.birth_date)?.slice(0, 10) ?? null,
    enrollment_year: Number.isFinite(year) && year > 0 ? year : null,
    status: text(record.status),
    archived: record.archived === true,
    parent_ids: Array.isArray(record.parent_ids) ? record.parent_ids.map(toId).filter((value): value is number => value !== null) : [],
    custom_fields: asRecord(record.custom_fields) ?? {},
  };
}

function studentFields(summarySlug: string | null) {
  const base = "id,first_name,last_name,birth_date,enrollment_year,status,archived,parent_ids";
  return summarySlug ? `${base},custom_fields(${summarySlug})` : base;
}

export async function searchParentsByEmail(client: OpenApplyClient, ctx: RequestContext, email: string) {
  const query = new URLSearchParams({ "parent[email]": email });
  const body = await client.request(
    { step: "parent.search", method: "GET", path: `/api/v3/parents/search?${query}`, template: "/api/v3/parents/search", idempotent: true },
    ctx,
  );
  return list(body, "parents").map(toParent).filter((parent): parent is OAParent => parent !== null);
}

export async function createParent(client: OpenApplyClient, ctx: RequestContext, payload: ParentCreate) {
  const body = await client.request(
    { step: "parent.create", method: "POST", path: "/api/v3/parents", template: "/api/v3/parents", body: payload, idempotent: false },
    ctx,
  );
  const parent = toParent(unwrap(body, "parent", "parent.create", "/api/v3/parents"));
  return parent as OAParent;
}

export async function listStudentsOfParent(client: OpenApplyClient, ctx: RequestContext, parentId: number, summarySlug: string | null) {
  const query = new URLSearchParams({ parent_ids: String(parentId), per_page: "200", fields: studentFields(summarySlug) });
  const body = await client.request(
    { step: "student.list", method: "GET", path: `/api/v3/students?${query}`, template: "/api/v3/students?parent_ids", idempotent: true },
    ctx,
  );
  return list(body, "students").map(toStudent).filter((student): student is OAStudent => student !== null);
}

export async function searchStudents(
  client: OpenApplyClient,
  ctx: RequestContext,
  criteria: { lastName: string; enrollmentYear: number },
  summarySlug: string | null,
) {
  const query = new URLSearchParams({
    "student[last_name]": criteria.lastName,
    "student[enrollment_year]": String(criteria.enrollmentYear),
    fields: studentFields(summarySlug),
  });
  const body = await client.request(
    { step: "student.search", method: "GET", path: `/api/v3/students/search?${query}`, template: "/api/v3/students/search", idempotent: true },
    ctx,
  );
  return list(body, "students").map(toStudent).filter((student): student is OAStudent => student !== null);
}

export async function createStudent(client: OpenApplyClient, ctx: RequestContext, payload: StudentCreate) {
  const body = await client.request(
    { step: "student.create", method: "POST", path: "/api/v3/students", template: "/api/v3/students", body: payload, idempotent: false },
    ctx,
  );
  return toStudent(unwrap(body, "student", "student.create", "/api/v3/students")) as OAStudent;
}

export async function getParentRelationships(client: OpenApplyClient, ctx: RequestContext, parentId: number) {
  const body = await client.request(
    {
      step: "relationship.get",
      method: "GET",
      path: `/api/v3/relationships/parent/${parentId}`,
      template: "/api/v3/relationships/parent/:id",
      idempotent: true,
    },
    ctx,
  );
  const items = asRecord(body)?.relationships;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item): OARelationship[] => {
    const record = asRecord(item);
    const studentId = toId(record?.student_id);
    if (!record || studentId === null) return [];
    const role = text(record.relationship);
    return [role ? { student_id: studentId, relationship: role } : { student_id: studentId }];
  });
}

export async function putParentRelationships(client: OpenApplyClient, ctx: RequestContext, parentId: number, relationships: OARelationship[]) {
  await client.request(
    {
      step: "relationship.put",
      method: "PUT",
      path: `/api/v3/relationships/parent/${parentId}`,
      template: "/api/v3/relationships/parent/:id",
      body: { relationships },
      idempotent: true,
    },
    ctx,
  );
}

export async function setStudentStatus(client: OpenApplyClient, ctx: RequestContext, studentId: number, status: "applied") {
  await client.request(
    {
      step: "student.status",
      method: "PATCH",
      path: `/api/v3/students/${studentId}/status`,
      template: "/api/v3/students/:id/status",
      body: { student: { status } },
      idempotent: true,
    },
    ctx,
  );
}

export async function patchCustomFields(
  client: OpenApplyClient,
  ctx: RequestContext,
  kind: "student" | "parent",
  id: number,
  fields: Record<string, string>,
) {
  await client.request(
    {
      step: kind === "student" ? "fields.student" : "fields.parent",
      method: "PATCH",
      path: `/api/v3/${kind}s/${id}/custom_fields`,
      template: `/api/v3/${kind}s/:id/custom_fields`,
      body: { custom_fields: fields },
      idempotent: true,
    },
    ctx,
  );
}

/** Looks up a field's slug (the key it uses inside `custom_fields` on read). */
export async function getFieldSlug(client: OpenApplyClient, ctx: RequestContext, fieldId: number) {
  const body = await client.request(
    { step: "field.get", method: "GET", path: `/api/v3/fields/${fieldId}`, template: "/api/v3/fields/:id", idempotent: true },
    ctx,
  );
  const field = asRecord(asRecord(body)?.field);
  return typeof field?.slug === "string" ? field.slug : null;
}
