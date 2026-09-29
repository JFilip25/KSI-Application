import snapshot from "../../scripts/openapply-tenant-snapshot.json";

/**
 * In-memory OpenApply v3 tenant used by the tests. It mirrors behaviour observed on the real
 * KSI tenant on 2026-09-29 (rate limit headers, wrapped responses, numeric custom-field keys
 * with option-ID values, replace semantics for parent relationships, lowercase roles), and is
 * deliberately stricter where the real API silently stores wrong values.
 *
 * Field and option IDs are written out here independently of lib/openapply/tenant.ts so a
 * wrong ID in the app fails these tests instead of passing them.
 */

type FieldDef = { slug: string; kind: "text" | "options" | "terms"; options?: ReadonlyMap<string, string> };

const YES_NO = new Map([
  ["1", "Yes"],
  ["0", "No"],
]);

const STUDENT_FIELDS = new Map<string, FieldDef>([
  ["30", { slug: "nationality", kind: "options", options: new Map(snapshot.nationalities.map(([id, name]) => [String(id), String(name)])) }],
  ["40", { slug: "language", kind: "options", options: new Map(snapshot.languages.map(([id, name]) => [String(id), String(name)])) }],
  [
    "357797",
    {
      slug: "english_level",
      kind: "options",
      options: new Map([
        ["484343", "Fluent"],
        ["484344", "Proficient"],
        ["484345", "Basic"],
        ["484346", "No Knowledge"],
      ]),
    },
  ],
  ["17", { slug: "prior_school", kind: "text" }],
  ["124830", { slug: "current_grade", kind: "text" }],
  [
    "357715",
    {
      slug: "family_situation",
      kind: "options",
      options: new Map([
        ["484311", "Parents Married/Living Together"],
        ["484312", "Parents Married/Living Apart"],
        ["484313", "Parents Divorced/Separated"],
        ["484314", "Parent(s) Deceased"],
        ["484315", "Adopted Child"],
      ]),
    },
  ],
  ["357781", { slug: "grade_repeat_y_n", kind: "options", options: YES_NO }],
  ["357786", { slug: "attended_school_regularly_y_n", kind: "options", options: YES_NO }],
  ["357787", { slug: "attended_school_regularly_details", kind: "text" }],
  ["357788", { slug: "discipline_y_n", kind: "options", options: YES_NO }],
  ["357789", { slug: "discipline_details", kind: "text" }],
  ["357764", { slug: "learning_disabilities_y_n", kind: "options", options: YES_NO }],
  ["357766", { slug: "learning_disability_details", kind: "text" }],
  ["357760", { slug: "eal_programme_y_n", kind: "options", options: YES_NO }],
  ["358466", { slug: "medical_conditions_y_n", kind: "options", options: YES_NO }],
  ["358467", { slug: "medical_conditions_details", kind: "text" }],
  ["357895", { slug: "photo_video_permissions_y_n", kind: "options", options: YES_NO }],
  ["470505", { slug: "google_edu_services", kind: "terms" }],
  ["124870", { slug: "additional_information", kind: "text" }],
  ["999001", { slug: "admissions_office_notes", kind: "text" }],
]);

const PARENT_FIELDS = new Map<string, FieldDef>([
  ["75", { slug: "mobile_phone", kind: "text" }],
  ["84", { slug: "nationality", kind: "options", options: new Map(snapshot.nationalities.map(([id, name]) => [String(id), String(name)])) }],
]);

const GRADES = ["Nursery", "Reception", ...Array.from({ length: 13 }, (_, index) => `Year ${index + 1}`)];
const ENROLLMENT_YEARS = [2026, 2027];
const STATUSES = ["pending", "applied", "wait-listed", "admitted", "declined", "enrolled", "graduated", "withdrawn"];
const ROLES = [
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
];
const COUNTRIES = new Map(snapshot.countries.map(([id, name]) => [Number(id), String(name)]));

export type FakeParent = {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  custom_fields: Record<string, unknown>;
};

export type FakeStudent = {
  id: number;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  birth_date: string | null;
  gender: string | null;
  grade: string | null;
  enrollment_year: number | null;
  status: string;
  archived: boolean;
  country_id: number | null;
  custom_fields: Record<string, unknown>;
};

export type FailureResponse =
  | number
  | "timeout"
  | "network"
  | "html-502"
  | "invalid-json"
  | "commit-then-500"
  | { status: number; body: unknown };

export type Failure = { method?: string; path: RegExp; respond: FailureResponse; times?: number };

export type FakeOptions = {
  clientId?: string;
  clientSecret?: string;
  /** Requests allowed per fixed window; false disables rate limiting. */
  rateLimit?: { limit: number; periodMs: number } | false;
  latencyMs?: number;
  tokenTtlSeconds?: number;
};

type RequestLog = { method: string; path: string; status: number; at: number };

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function formatReset(ms: number) {
  return `${new Date(Math.ceil(ms / 1000) * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export class FakeOpenApply {
  readonly baseUrl = "https://ksi-test.openapply.com";
  readonly parents = new Map<number, FakeParent>();
  readonly students = new Map<number, FakeStudent>();
  /** parent id → (student id → role) */
  readonly links = new Map<number, Map<number, string>>();
  readonly log: RequestLog[] = [];
  private readonly tokens = new Map<string, number>();
  private readonly windows = new Map<number, number>();
  private readonly failures: Failure[] = [];
  private nextParentId = 53_000_001;
  private nextStudentId = 9_700_001;
  private tokenCounter = 0;
  private readonly options: Required<Omit<FakeOptions, "rateLimit">> & { rateLimit: FakeOptions["rateLimit"] };

  constructor(options: FakeOptions = {}) {
    this.options = {
      clientId: options.clientId ?? "test-client",
      clientSecret: options.clientSecret ?? "test-secret",
      rateLimit: options.rateLimit ?? { limit: 5, periodMs: 2000 },
      latencyMs: options.latencyMs ?? 120,
      tokenTtlSeconds: options.tokenTtlSeconds ?? 86_400,
    };
  }

  env(overrides: Record<string, string> = {}) {
    return {
      OPENAPPLY_BASE_URL: this.baseUrl,
      OPENAPPLY_CLIENT_ID: this.options.clientId,
      OPENAPPLY_CLIENT_SECRET: this.options.clientSecret,
      OPENAPPLY_DRY_RUN: "false",
      ...overrides,
    };
  }

  fail(failure: Failure) {
    this.failures.push({ times: 1, ...failure });
  }

  seedParent(parent: Partial<FakeParent> & { email: string }) {
    const id = this.nextParentId++;
    const record: FakeParent = {
      id,
      first_name: parent.first_name ?? "Existing",
      last_name: parent.last_name ?? "Parent",
      email: parent.email,
      custom_fields: { mobile_phone: null, nationality: null, ...parent.custom_fields },
    };
    this.parents.set(id, record);
    return record;
  }

  seedStudent(student: Partial<FakeStudent> & { first_name: string; last_name: string }) {
    const id = this.nextStudentId++;
    const record: FakeStudent = {
      id,
      first_name: student.first_name,
      last_name: student.last_name,
      preferred_name: student.preferred_name ?? null,
      birth_date: student.birth_date ?? null,
      gender: student.gender ?? null,
      grade: student.grade ?? null,
      enrollment_year: student.enrollment_year ?? 2026,
      status: student.status ?? "applied",
      archived: student.archived ?? false,
      country_id: student.country_id ?? null,
      custom_fields: { ...this.emptyStudentFields(), ...student.custom_fields },
    };
    this.students.set(id, record);
    return record;
  }

  link(parentId: number, studentId: number, role = "mother") {
    const set = this.links.get(parentId) ?? new Map<number, string>();
    set.set(studentId, role);
    this.links.set(parentId, set);
  }

  parentIdsOf(studentId: number) {
    return [...this.links.entries()].filter(([, set]) => set.has(studentId)).map(([parentId]) => parentId);
  }

  relationshipsOf(parentId: number) {
    return Object.fromEntries(this.links.get(parentId) ?? []);
  }

  requestsTo(method: string, pattern: RegExp) {
    return this.log.filter((entry) => entry.method === method && pattern.test(entry.path));
  }

  /** Largest number of accepted (non-429) requests that arrived within any window of `periodMs`. */
  maxAcceptedInWindow(periodMs = 2000) {
    const times = this.log.filter((entry) => entry.status !== 429).map((entry) => entry.at);
    let max = 0;
    for (let start = 0; start < times.length; start += 1) {
      let count = 0;
      for (let index = start; index < times.length && times[index] - times[start] < periodMs; index += 1) count += 1;
      max = Math.max(max, count);
    }
    return max;
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const signal = init.signal ?? undefined;
    if (url.origin !== this.baseUrl) throw new TypeError(`fetch failed: unexpected host ${url.origin}`);
    await this.wait(this.options.latencyMs, signal);

    // Logged at the moment the server counts the request against its rate limit.
    const arrivedAt = Date.now();
    const record = (status: number) => this.log.push({ method, path: url.pathname + url.search, status, at: arrivedAt });
    const limited = this.rateLimit();
    if (limited) {
      record(429);
      return limited;
    }

    const failure = this.takeFailure(method, url.pathname);
    if (failure === "timeout") {
      record(0);
      await this.wait(10 * 60_000, signal);
    }
    if (failure === "network") {
      record(0);
      throw new TypeError("fetch failed");
    }
    if (failure === "html-502") {
      record(502);
      return new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } });
    }
    if (failure === "invalid-json") {
      record(200);
      return new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } });
    }
    if (typeof failure === "number") {
      record(failure);
      return json(failure, failure === 422 ? { errors: ["Injected validation failure"] } : { error: "Injected failure" });
    }
    if (failure && typeof failure === "object") {
      record(failure.status);
      return json(failure.status, failure.body);
    }

    const response = await this.route(method, url, init);
    if (failure === "commit-then-500") {
      record(500);
      return json(500, { error: "Internal Server Error" });
    }
    record(response.status);
    return response;
  };

  private wait(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException("The operation was aborted.", "AbortError"));
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  }

  private rateLimit(): Response | null {
    if (!this.options.rateLimit) return null;
    const { limit, periodMs } = this.options.rateLimit;
    const window = Math.floor(Date.now() / periodMs);
    const count = (this.windows.get(window) ?? 0) + 1;
    this.windows.set(window, count);
    if (count <= limit) return null;
    return json(
      429,
      { error: "Rate limit exceeded" },
      {
        "x-ratelimit-limit": String(limit),
        "x-ratelimit-period": String(periodMs / 1000),
        "x-ratelimit-reset": formatReset((window + 1) * periodMs),
      },
    );
  }

  private takeFailure(method: string, path: string): FailureResponse | null {
    const index = this.failures.findIndex((failure) => (!failure.method || failure.method === method) && failure.path.test(path));
    if (index < 0) return null;
    const failure = this.failures[index];
    failure.times = (failure.times ?? 1) - 1;
    if (failure.times <= 0) this.failures.splice(index, 1);
    return failure.respond;
  }

  private authorized(init: RequestInit) {
    const header = new Headers(init.headers).get("authorization") ?? "";
    const token = header.replace(/^Bearer\s+/i, "");
    const expiresAt = this.tokens.get(token);
    return expiresAt !== undefined && expiresAt > Date.now();
  }

  private body(init: RequestInit): unknown {
    if (typeof init.body !== "string") return null;
    try {
      return JSON.parse(init.body);
    } catch {
      return null;
    }
  }

  private emptyStudentFields() {
    return Object.fromEntries([...STUDENT_FIELDS.values()].map((field) => [field.slug, null]));
  }

  private parentView(parent: FakeParent) {
    return {
      id: parent.id,
      first_name: parent.first_name,
      last_name: parent.last_name,
      name: `${parent.first_name} ${parent.last_name}`,
      email: parent.email,
      country: null,
      custom_fields: parent.custom_fields,
      child_ids: [...(this.links.get(parent.id)?.keys() ?? [])],
    };
  }

  studentView(student: FakeStudent) {
    return {
      id: student.id,
      first_name: student.first_name,
      last_name: student.last_name,
      preferred_name: student.preferred_name,
      birth_date: student.birth_date,
      gender: student.gender,
      grade: student.grade,
      enrollment_year: student.enrollment_year,
      status: student.status,
      archived: student.archived,
      country: student.country_id ? COUNTRIES.get(student.country_id) ?? null : null,
      parent_ids: this.parentIdsOf(student.id),
      custom_fields: student.custom_fields,
    };
  }

  private async route(method: string, url: URL, init: RequestInit): Promise<Response> {
    const path = url.pathname;
    if (method === "POST" && path === "/oauth/token") return this.token(init);
    if (!this.authorized(init)) return json(401, { error: "invalid_token" });

    const params = url.searchParams;
    let match: RegExpExecArray | null;

    if (method === "GET" && path === "/api/v3/parents/search") {
      const email = params.get("parent[email]")?.toLowerCase();
      const parents = [...this.parents.values()].filter((parent) => !email || parent.email.toLowerCase() === email);
      return json(200, { parents: parents.map((parent) => this.parentView(parent)), meta: { page: 1, pages: 1, per_page: 50 } });
    }
    if (method === "POST" && path === "/api/v3/parents") return this.createParent(this.body(init));
    if (method === "GET" && (match = /^\/api\/v3\/parents\/(\d+)$/.exec(path))) {
      const parent = this.parents.get(Number(match[1]));
      return parent ? json(200, { parent: this.parentView(parent) }) : json(404, { error: "parent not found" });
    }
    if (method === "GET" && path === "/api/v3/students") {
      const parentIds = (params.get("parent_ids") ?? "").split(",").filter(Boolean).map(Number);
      const students = [...this.students.values()].filter(
        (student) => !parentIds.length || parentIds.some((id) => this.links.get(id)?.has(student.id)),
      );
      return json(200, { students: students.map((student) => this.studentView(student)), meta: { page: 1, pages: 1, per_page: 200 } });
    }
    if (method === "GET" && path === "/api/v3/students/search") {
      const lastName = params.get("student[last_name]")?.toLowerCase();
      const firstName = params.get("student[first_name]")?.toLowerCase();
      const year = params.get("student[enrollment_year]");
      const students = [...this.students.values()].filter(
        (student) =>
          (!lastName || student.last_name.toLowerCase() === lastName) &&
          (!firstName || student.first_name.toLowerCase() === firstName) &&
          (!year || String(student.enrollment_year) === year),
      );
      return json(200, { students: students.map((student) => this.studentView(student)) });
    }
    if (method === "POST" && path === "/api/v3/students") return this.createStudent(this.body(init));
    if (method === "GET" && (match = /^\/api\/v3\/students\/(\d+)$/.exec(path))) {
      const student = this.students.get(Number(match[1]));
      return student ? json(200, { student: this.studentView(student) }) : json(404, { error: "student not found" });
    }
    if ((match = /^\/api\/v3\/relationships\/parent\/(\d+)$/.exec(path))) {
      const parentId = Number(match[1]);
      if (!this.parents.has(parentId)) return json(404, { error: "parent not found" });
      if (method === "GET") return json(200, this.relationshipsBody(parentId, true));
      if (method === "PUT") return this.putRelationships(parentId, this.body(init));
    }
    if (method === "PATCH" && (match = /^\/api\/v3\/students\/(\d+)\/status$/.exec(path))) {
      return this.patchStatus(Number(match[1]), this.body(init));
    }
    if (method === "PATCH" && (match = /^\/api\/v3\/(students|parents)\/(\d+)\/custom_fields$/.exec(path))) {
      return this.patchCustomFields(match[1] === "students" ? "student" : "parent", Number(match[2]), this.body(init));
    }
    if (method === "GET" && (match = /^\/api\/v3\/fields\/(\d+)$/.exec(path))) {
      const field = STUDENT_FIELDS.get(match[1]) ?? PARENT_FIELDS.get(match[1]);
      return field ? json(200, { field: { id: Number(match[1]), slug: field.slug } }) : json(404, { error: "field not found" });
    }
    return json(404, { error: "Not found" });
  }

  private token(init: RequestInit) {
    const form = new URLSearchParams(typeof init.body === "string" ? init.body : "");
    if (
      form.get("grant_type") !== "client_credentials" ||
      form.get("client_id") !== this.options.clientId ||
      form.get("client_secret") !== this.options.clientSecret
    ) {
      return json(401, { error: "invalid_client", error_description: "Client authentication failed due to unknown client." });
    }
    const token = `token-${++this.tokenCounter}`;
    this.tokens.set(token, Date.now() + this.options.tokenTtlSeconds * 1000);
    return json(200, { access_token: token, token_type: "Bearer", expires_in: this.options.tokenTtlSeconds, scope: "public", created_at: 0 });
  }

  expireTokens() {
    for (const token of this.tokens.keys()) this.tokens.set(token, 0);
  }

  private createParent(raw: unknown) {
    const body = asObject(asObject(raw)?.parent) ?? asObject(raw) ?? {};
    const errors: string[] = [];
    for (const key of ["first_name", "last_name", "email"]) if (typeof body[key] !== "string" || !String(body[key]).trim()) errors.push(`${key} can't be blank`);
    if (errors.length) return json(422, { errors });
    const email = String(body.email);
    if ([...this.parents.values()].some((parent) => parent.email.toLowerCase() === email.toLowerCase())) {
      return json(422, { errors: ["Email has already been taken"] });
    }
    const parent = this.seedParent({ first_name: String(body.first_name), last_name: String(body.last_name), email });
    return json(201, { parent: this.parentView(parent) });
  }

  private createStudent(raw: unknown) {
    const body = asObject(raw) ?? {};
    const errors: string[] = [];
    for (const key of ["first_name", "last_name"]) if (typeof body[key] !== "string" || !String(body[key]).trim()) errors.push(`${key} can't be blank`);
    if (body.gender !== undefined && body.gender !== null && body.gender !== "Male" && body.gender !== "Female") {
      return json(400, { error: 'Please supply one of "Male", "Female" or null to clear.' });
    }
    if (body.grade !== undefined && !GRADES.includes(String(body.grade))) errors.push("Grade is not valid");
    if (body.enrollment_year !== undefined && !ENROLLMENT_YEARS.includes(Number(body.enrollment_year))) errors.push("Enrollment year is not valid");
    if (body.status !== undefined && !STATUSES.includes(String(body.status))) errors.push("Status is not valid");
    if (body.country_id !== undefined && !COUNTRIES.has(Number(body.country_id))) errors.push("Country is not valid");
    if (errors.length) return json(422, { errors });
    const student = this.seedStudent({
      first_name: String(body.first_name),
      last_name: String(body.last_name),
      preferred_name: typeof body.preferred_name === "string" ? body.preferred_name : null,
      birth_date: typeof body.birth_date === "string" ? body.birth_date : null,
      gender: typeof body.gender === "string" ? body.gender : null,
      grade: typeof body.grade === "string" ? body.grade : null,
      enrollment_year: body.enrollment_year === undefined ? null : Number(body.enrollment_year),
      status: typeof body.status === "string" ? body.status : "pending",
      // The real API drops `country` on create; only the country_id attribute is stored.
      country_id: body.country_id === undefined ? null : Number(body.country_id),
    });
    return json(201, { student: this.studentView(student) });
  }

  private relationshipsBody(parentId: number, includeParentId: boolean) {
    const set = this.links.get(parentId) ?? new Map<number, string>();
    return {
      ...(includeParentId ? { parent_id: parentId } : {}),
      student_ids: [...set.keys()],
      relationships: [...set.entries()].map(([studentId, role]) => ({ student_id: studentId, relationship: role })),
    };
  }

  private putRelationships(parentId: number, raw: unknown) {
    const relationships = asObject(raw)?.relationships;
    if (!Array.isArray(relationships) || relationships.some((item) => !asObject(item))) {
      return json(422, { errors: ["Invalid or missing relationships parameter. It must be an array of objects."] });
    }
    const next = new Map<number, string>();
    for (const item of relationships as Record<string, unknown>[]) {
      const studentId = Number(item.student_id);
      if (!this.students.has(studentId)) return json(422, { errors: [`Student ${String(item.student_id)} not found`] });
      const role = item.relationship === undefined || item.relationship === null ? "other guardian" : String(item.relationship);
      if (!ROLES.includes(role)) return json(422, { errors: [`Relationship must be one of: ${ROLES.join(", ")}`] });
      next.set(studentId, role);
    }
    this.links.set(parentId, next);
    return json(200, this.relationshipsBody(parentId, false));
  }

  private patchStatus(studentId: number, raw: unknown) {
    const student = this.students.get(studentId);
    if (!student) return json(404, { error: "student not found" });
    const wrapped = asObject(asObject(raw)?.student);
    if (!wrapped) return json(400, { error: "param is missing or the value is empty: student" });
    if (!STATUSES.includes(String(wrapped.status))) return json(422, { error: "Status is not valid" });
    student.status = String(wrapped.status);
    return json(200, { student: this.studentView(student) });
  }

  private patchCustomFields(kind: "student" | "parent", id: number, raw: unknown) {
    const record = kind === "student" ? this.students.get(id) : this.parents.get(id);
    if (!record) return json(404, { error: `${kind} not found` });
    const fields = asObject(asObject(raw)?.custom_fields);
    if (!fields) return json(422, { errors: ["custom_fields must be an object"] });
    const catalogue = kind === "student" ? STUDENT_FIELDS : PARENT_FIELDS;
    const updates: [string, unknown][] = [];
    for (const [key, value] of Object.entries(fields)) {
      const field = catalogue.get(key);
      if (!field) return json(422, { errors: [`Unknown field id: ${key}`] });
      const text = value === null || value === undefined ? "" : String(value);
      if (field.kind === "options") {
        const name = field.options?.get(text);
        if (name === undefined) return json(422, { errors: [`Field ${key} (${field.slug}) value ${text} is not a valid option value.`] });
        updates.push([field.slug, name]);
      } else if (field.kind === "terms") {
        updates.push([field.slug, text === "1" || text === "true"]);
      } else {
        updates.push([field.slug, text]);
      }
    }
    for (const [slug, value] of updates) record.custom_fields[slug] = value;
    return json(200, { [kind]: { id, custom_fields: record.custom_fields } });
  }
}
