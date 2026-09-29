export type OpenApplyErrorKind =
  | "config"
  | "auth"
  | "busy"
  | "rate_limited"
  | "budget"
  | "timeout"
  | "network"
  | "server"
  | "rejected"
  | "invalid_response";

export type OpenApplyStep =
  | "config"
  | "queue"
  | "token"
  | "parent.search"
  | "parent.create"
  | "student.list"
  | "student.search"
  | "student.create"
  | "relationship.get"
  | "relationship.put"
  | "student.status"
  | "field.get"
  | "fields.student"
  | "fields.parent";

export type OpenApplyErrorInfo = {
  step: OpenApplyStep;
  method?: string;
  /** Path template such as /api/v3/parents/:id — never a URL with query values. */
  path?: string;
  status?: number;
  /** OpenApply validation messages with submitted values redacted. */
  errors?: string[];
  requestId?: string;
  /** True when a create may have been applied even though no success response arrived. */
  ambiguous?: boolean;
};

const RETRYABLE: readonly OpenApplyErrorKind[] = ["busy", "rate_limited", "budget", "timeout", "network", "server"];

export class OpenApplyError extends Error {
  readonly kind: OpenApplyErrorKind;
  readonly info: OpenApplyErrorInfo;

  constructor(kind: OpenApplyErrorKind, message: string, info: OpenApplyErrorInfo) {
    super(message);
    this.name = "OpenApplyError";
    this.kind = kind;
    this.info = info;
  }

  /** Whether the family can reasonably try the same submission again later. */
  get retryable() {
    return RETRYABLE.includes(this.kind);
  }

  toLog() {
    return { kind: this.kind, message: this.message, ...this.info };
  }
}

const EMAIL_PATTERN = /[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+\.[^\s@"'<>(),;:]+/g;

/** Removes email addresses and any submitted values from an OpenApply message before it is logged. */
export function redact(message: string, values: readonly string[] = []) {
  let output = message.replace(EMAIL_PATTERN, "[email]");
  for (const value of values) {
    if (value && value.trim().length >= 3) output = output.split(value).join("[redacted]");
  }
  return output.slice(0, 200);
}

/** Extracts `errors` / `error` messages from an OpenApply error body. */
export function extractApiErrors(body: unknown, values: readonly string[] = []): string[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const messages: string[] = [];
  if (Array.isArray(record.errors)) {
    messages.push(...record.errors.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))));
  } else if (record.errors && typeof record.errors === "object") {
    for (const [field, value] of Object.entries(record.errors)) {
      messages.push(`${field}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
    }
  }
  if (typeof record.error === "string") messages.push(record.error);
  return messages.slice(0, 5).map((message) => redact(message, values));
}
