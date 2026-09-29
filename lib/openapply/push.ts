import type { ApplicationData } from "../schema";
import * as api from "./api";
import { deadlineIn, OpenApplyClient, type Deadline, type RequestContext } from "./client";
import { isDryRun, readConfig, type OpenApplyConfig } from "./config";
import { OpenApplyError } from "./errors";
import {
  buildStudentSummary,
  buildSubmissionPlan,
  mergeRelationships,
  mergeSummary,
  sameChild,
  TEXT_FIELD_KEYS,
  toCustomFields,
  type PlannedChild,
  type PlannedParent,
  type SubmissionPlan,
} from "./mapping";
import { resolveFieldTargets, type FieldTargets, type StudentFieldKey } from "./tenant";

export type PushResult = {
  reference: string;
  dryRun: boolean;
  parentIds: number[];
  studentIds: number[];
  /** Non-fatal issues for the server log (never shown to families). */
  warnings: string[];
};

export type PushOptions = {
  client?: OpenApplyClient;
  env?: Record<string, string | undefined>;
  /** Total time for one submission, kept below the route's maxDuration. */
  budgetMs?: number;
  submittedAt?: Date;
};

const DEFAULT_BUDGET_MS = 50_000;
const RESULT_TTL_MS = 30 * 60_000;
const MS_PER_CALL_ESTIMATE = 460;

type ResolvedParent = {
  plan: PlannedParent;
  id: number;
  /** Created by this submission, so it has no earlier links or field values. */
  created: boolean;
  /** Whether the parent already has a mobile number (undefined when it could not be read). */
  hasMobile: boolean | undefined;
};

type ResolvedStudent = {
  plan: PlannedChild;
  id: number;
  created: boolean;
  /** "summary-only" leaves an existing record's answers untouched and appends to its summary. */
  mode: "full" | "summary-only";
  needsApplied: boolean;
  /** Current summary field value; undefined when it could not be read. */
  existingSummary: unknown;
};

const inflight = new Map<string, Promise<PushResult>>();
const completed = new Map<string, { result: PushResult; at: number }>();
let queueTail: Promise<unknown> = Promise.resolve();
let sharedClient: { key: string; client: OpenApplyClient } | null = null;
const fieldSlugs = new WeakMap<OpenApplyClient, Map<number, string | null>>();

/** Clears per-instance caches. Used by tests. */
export function resetPushState() {
  inflight.clear();
  completed.clear();
  queueTail = Promise.resolve();
  sharedClient = null;
}

function clientFor(config: OpenApplyConfig) {
  const key = `${config.baseUrl}|${config.clientId}|${config.clientSecret}`;
  if (!sharedClient || sharedClient.key !== key) sharedClient = { key, client: new OpenApplyClient(config) };
  return sharedClient.client;
}

function log(level: "info" | "warn" | "error", payload: Record<string, unknown>) {
  console[level](JSON.stringify(payload));
}

function errorForLog(error: unknown) {
  return error instanceof OpenApplyError ? error.toLog() : { message: error instanceof Error ? error.message : "Unknown error" };
}

export async function pushApplication(application: ApplicationData, options: PushOptions = {}): Promise<PushResult> {
  const env = options.env ?? process.env;
  const targets = resolveFieldTargets(env.OPENAPPLY_CUSTOM_FIELD_MAP);
  // Built in test mode too, so mapping problems surface before live submissions are enabled.
  const plan = buildSubmissionPlan(application, options.submittedAt);
  if (isDryRun(env)) {
    return { reference: plan.reference, dryRun: true, parentIds: [], studentIds: [], warnings: targets.warnings };
  }

  for (const [reference, entry] of completed) {
    if (Date.now() - entry.at > RESULT_TTL_MS) completed.delete(reference);
  }
  const done = completed.get(plan.reference);
  if (done) return done.result;
  const running = inflight.get(plan.reference);
  if (running) return running;

  const config = readConfig(env);
  const client = options.client ?? clientFor(config);
  const deadline = deadlineIn(options.budgetMs ?? DEFAULT_BUDGET_MS);
  const promise = enqueue(plan, deadline, () => execute(plan, targets, client, deadline));
  inflight.set(plan.reference, promise);
  try {
    const result = await promise;
    completed.set(plan.reference, { result, at: Date.now() });
    return result;
  } finally {
    inflight.delete(plan.reference);
  }
}

/**
 * One submission at a time per server instance: they share the rate limit, so running them
 * in parallel only makes every one slower. A submission that cannot start in time is turned
 * away before it writes anything.
 */
function enqueue<T>(plan: SubmissionPlan, deadline: Deadline, task: () => Promise<T>): Promise<T> {
  const previous = queueTail;
  const latestStart = deadline.at - (plan.estimatedCalls * MS_PER_CALL_ESTIMATE + 2_000);
  const run = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = await Promise.race([
      previous.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, latestStart - Date.now()));
      }),
    ]);
    clearTimeout(timer);
    if (!started) {
      throw new OpenApplyError("busy", "Other applications are being submitted; try again shortly.", { step: "queue" });
    }
    return task();
  })();
  queueTail = Promise.allSettled([previous, run]);
  return run;
}

async function execute(plan: SubmissionPlan, targets: FieldTargets, client: OpenApplyClient, deadline: Deadline): Promise<PushResult> {
  const started = Date.now();
  const ctx: RequestContext = { deadline, stats: { calls: 0, retries: 0, rateLimited: 0 }, redact: plan.redact };
  const warnings = [...targets.warnings];
  const notes: string[] = [];
  if (plan.parent2Skipped === "court-restriction") {
    warnings.push("parent2_not_linked_court_restriction");
    notes.push(
      "Note: Parent/guardian 2 was not added to OpenApply automatically because a court order or restriction was declared; Admissions will follow up.",
    );
  }
  if (plan.parent2Skipped === "same-email") {
    warnings.push("parent2_same_email");
    notes.push("Note: Parent/guardian 2 gave the same email address as Parent/guardian 1, so one parent account is used.");
  }
  if (plan.duplicateChildren) warnings.push("duplicate_children_ignored");

  try {
    const parent1 = await resolveParent(client, ctx, plan.parent1, targets);
    let parent2: ResolvedParent | null = null;
    if (plan.parent2) {
      try {
        parent2 = await resolveParent(client, ctx, plan.parent2, targets);
      } catch (error) {
        if (!(error instanceof OpenApplyError) || error.kind !== "rejected") throw error;
        warnings.push("parent2_rejected");
        notes.push("Note: Parent/guardian 2 could not be added to OpenApply automatically; Admissions will follow up.");
        log("warn", { evt: "openapply.parent2_rejected", ref: plan.shortReference, error: error.toLog() });
      }
    }
    const parents = parent2 ? [parent1, parent2] : [parent1];

    const summarySlug = await summaryFieldSlug(client, ctx, targets);
    const students = await resolveStudents(client, ctx, plan, parents, summarySlug, warnings);
    await linkParents(client, ctx, parents, students, warnings);
    await markApplied(client, ctx, students, warnings);
    await writeStudentFields(client, ctx, plan, students, targets, notes, warnings);
    await writeParentFields(client, ctx, plan, parents, targets, warnings);

    const result: PushResult = {
      reference: plan.reference,
      dryRun: false,
      parentIds: parents.map((parent) => parent.id),
      studentIds: students.map((student) => student.id),
      warnings,
    };
    log("info", {
      evt: "openapply.push",
      ref: plan.shortReference,
      parentIds: result.parentIds,
      studentIds: result.studentIds,
      createdParents: parents.filter((parent) => parent.created).length,
      createdStudents: students.filter((student) => student.created).length,
      ...ctx.stats,
      ms: Date.now() - started,
      warnings,
    });
    return result;
  } catch (error) {
    log("error", { evt: "openapply.push_failed", ref: plan.shortReference, ...ctx.stats, ms: Date.now() - started, warnings, error: errorForLog(error) });
    throw error;
  }
}

function hasValue(value: unknown) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

async function findParent(client: OpenApplyClient, ctx: RequestContext, parent: PlannedParent, targets: FieldTargets) {
  const email = parent.payload.email;
  const matches = (await api.searchParentsByEmail(client, ctx, email))
    .filter((candidate) => candidate.email?.trim().toLowerCase() === email)
    .sort((a, b) => a.id - b.id);
  const match = matches[0];
  if (!match) return null;
  const slug = targets.parent.mobile?.slug;
  const hasMobile = slug && Object.prototype.hasOwnProperty.call(match.custom_fields, slug) ? hasValue(match.custom_fields[slug]) : undefined;
  return { plan: parent, id: match.id, created: false, hasMobile } satisfies ResolvedParent;
}

async function resolveParent(client: OpenApplyClient, ctx: RequestContext, parent: PlannedParent, targets: FieldTargets): Promise<ResolvedParent> {
  const existing = await findParent(client, ctx, parent, targets);
  if (existing) return existing;
  try {
    const created = await api.createParent(client, ctx, parent.payload);
    return { plan: parent, id: created.id, created: true, hasMobile: false };
  } catch (error) {
    // Either another submission created this parent a moment ago ("Email has already been
    // taken") or the create may have gone through without a response: look again first.
    if (!(error instanceof OpenApplyError) || !(error.info.ambiguous || error.kind === "rejected")) throw error;
    const again = await findParent(client, ctx, parent, targets);
    if (again) return again;
    if (!error.info.ambiguous) throw error;
    const created = await api.createParent(client, ctx, parent.payload);
    return { plan: parent, id: created.id, created: true, hasMobile: false };
  }
}

async function summaryFieldSlug(client: OpenApplyClient, ctx: RequestContext, targets: FieldTargets) {
  const target = targets.student.summary;
  if (!target) return null;
  if (target.slug) return target.slug;
  let cache = fieldSlugs.get(client);
  if (!cache) {
    cache = new Map();
    fieldSlugs.set(client, cache);
  }
  if (!cache.has(target.id)) {
    try {
      cache.set(target.id, await api.getFieldSlug(client, ctx, target.id));
    } catch (error) {
      log("warn", { evt: "openapply.field_lookup_failed", fieldId: target.id, error: errorForLog(error) });
      return null;
    }
  }
  return cache.get(target.id) ?? null;
}

function summaryOf(student: api.OAStudent, slug: string | null): unknown {
  if (!slug || !Object.prototype.hasOwnProperty.call(student.custom_fields, slug)) return undefined;
  return student.custom_fields[slug] ?? null;
}

function reuseDecision(student: api.OAStudent, enrollmentYear: number) {
  if (student.archived || ["declined", "withdrawn", "graduated"].includes(student.status ?? "")) return null;
  if (student.enrollment_year === enrollmentYear && (student.status === "pending" || student.status === "applied")) {
    return { mode: "full" as const, needsApplied: student.status === "pending", warning: null };
  }
  // Already further along (or another year): keep Admissions' data and status; add the summary.
  return { mode: "summary-only" as const, needsApplied: false, warning: "existing_student_kept_as_is" };
}

async function findOrphan(
  client: OpenApplyClient,
  ctx: RequestContext,
  plan: SubmissionPlan,
  child: PlannedChild,
  parentIds: ReadonlySet<number>,
  summarySlug: string | null,
  usedIds: ReadonlySet<number>,
) {
  const candidates = await api.searchStudents(client, ctx, { lastName: child.payload.last_name, enrollmentYear: plan.enrollmentYear }, summarySlug);
  return (
    candidates.find(
      (student) =>
        !usedIds.has(student.id) &&
        sameChild(student, child) &&
        (student.parent_ids.length === 0 || student.parent_ids.some((id) => parentIds.has(id))),
    ) ?? null
  );
}

async function createStudent(
  client: OpenApplyClient,
  ctx: RequestContext,
  plan: SubmissionPlan,
  child: PlannedChild,
  parentIds: ReadonlySet<number>,
  summarySlug: string | null,
  usedIds: ReadonlySet<number>,
): Promise<ResolvedStudent> {
  try {
    const student = await api.createStudent(client, ctx, child.payload);
    return { plan: child, id: student.id, created: true, mode: "full", needsApplied: true, existingSummary: null };
  } catch (error) {
    if (!(error instanceof OpenApplyError) || !error.info.ambiguous) throw error;
    const found = await findOrphan(client, ctx, plan, child, parentIds, summarySlug, usedIds);
    if (found) {
      return {
        plan: child,
        id: found.id,
        created: true,
        mode: "full",
        needsApplied: found.status === "pending",
        existingSummary: summaryOf(found, summarySlug),
      };
    }
    const student = await api.createStudent(client, ctx, child.payload);
    return { plan: child, id: student.id, created: true, mode: "full", needsApplied: true, existingSummary: null };
  }
}

async function resolveStudents(
  client: OpenApplyClient,
  ctx: RequestContext,
  plan: SubmissionPlan,
  parents: readonly ResolvedParent[],
  summarySlug: string | null,
  warnings: string[],
) {
  const existingParents = parents.filter((parent) => !parent.created);
  const family = new Map<number, api.OAStudent>();
  for (const parent of existingParents) {
    for (const student of await api.listStudentsOfParent(client, ctx, parent.id, summarySlug)) family.set(student.id, student);
  }
  const parentIds = new Set(parents.map((parent) => parent.id));
  const usedIds = new Set<number>();
  const resolved: ResolvedStudent[] = [];

  for (const child of plan.children) {
    let match = [...family.values()].find((student) => !usedIds.has(student.id) && sameChild(student, child)) ?? null;
    // Records left unlinked by an earlier attempt that failed part-way.
    if (!match && existingParents.length) match = await findOrphan(client, ctx, plan, child, parentIds, summarySlug, usedIds);

    const decision = match ? reuseDecision(match, plan.enrollmentYear) : null;
    if (match && decision) {
      usedIds.add(match.id);
      if (decision.warning) warnings.push(decision.warning);
      resolved.push({
        plan: child,
        id: match.id,
        created: false,
        mode: decision.mode,
        needsApplied: decision.needsApplied,
        existingSummary: summaryOf(match, summarySlug),
      });
      continue;
    }
    if (match) warnings.push("inactive_match_created_new_student");
    const created = await createStudent(client, ctx, plan, child, parentIds, summarySlug, usedIds);
    usedIds.add(created.id);
    resolved.push(created);
  }
  return resolved;
}

async function linkParents(
  client: OpenApplyClient,
  ctx: RequestContext,
  parents: readonly ResolvedParent[],
  students: readonly ResolvedStudent[],
  warnings: string[],
) {
  for (const parent of parents) {
    const existing = parent.created ? [] : await api.getParentRelationships(client, ctx, parent.id);
    const wanted = students.map((student) => ({ student_id: student.id, relationship: parent.plan.role }));
    const { relationships, changed } = mergeRelationships(existing, wanted);
    if (!changed) continue;
    try {
      await api.putParentRelationships(client, ctx, parent.id, relationships);
    } catch (error) {
      if (!(error instanceof OpenApplyError) || error.kind !== "rejected") throw error;
      // The role is optional; without it OpenApply records "other guardian".
      const fallback = mergeRelationships(
        existing,
        students.map((student) => ({ student_id: student.id })),
      );
      await api.putParentRelationships(client, ctx, parent.id, fallback.relationships);
      warnings.push("relationship_role_rejected");
      log("warn", { evt: "openapply.relationship_role_rejected", parentId: parent.id, error: error.toLog() });
    }
  }
}

async function markApplied(client: OpenApplyClient, ctx: RequestContext, students: readonly ResolvedStudent[], warnings: string[]) {
  for (const student of students) {
    if (!student.needsApplied) continue;
    try {
      await api.setStudentStatus(client, ctx, student.id, "applied");
    } catch (error) {
      // Records and links are complete; Admissions can move the status by hand.
      if (!(error instanceof OpenApplyError) || error.kind !== "rejected") throw error;
      warnings.push("status_not_updated");
      log("warn", { evt: "openapply.status_rejected", studentId: student.id, error: error.toLog() });
    }
  }
}

async function writeStudentFields(
  client: OpenApplyClient,
  ctx: RequestContext,
  plan: SubmissionPlan,
  students: readonly ResolvedStudent[],
  targets: FieldTargets,
  notes: readonly string[],
  warnings: string[],
) {
  for (const student of students) {
    const values: Partial<Record<StudentFieldKey, string>> = student.mode === "full" ? { ...student.plan.fieldValues } : {};
    if (targets.student.summary) {
      const summary = buildStudentSummary(plan, student.plan, notes);
      if (student.existingSummary === undefined && !student.created) {
        warnings.push("summary_skipped_unreadable");
      } else {
        const merged = mergeSummary(student.existingSummary, summary, plan.shortReference);
        if (merged !== null) values.summary = merged;
      }
    }
    const fields = toCustomFields(values, targets.student);
    if (!Object.keys(fields).length) continue;
    try {
      await api.patchCustomFields(client, ctx, "student", student.id, fields);
    } catch (error) {
      // OpenApply validates the whole batch; keep the free-text answers if an option was refused.
      log("warn", { evt: "openapply.student_fields_failed", studentId: student.id, error: errorForLog(error) });
      const textOnly = toCustomFields(
        Object.fromEntries(Object.entries(values).filter(([key]) => TEXT_FIELD_KEYS.includes(key as StudentFieldKey))) as Partial<
          Record<StudentFieldKey, string>
        >,
        targets.student,
      );
      const canRetry = error instanceof OpenApplyError && error.kind === "rejected" && Object.keys(textOnly).length > 0;
      if (!canRetry) {
        warnings.push("student_fields_not_saved");
        continue;
      }
      try {
        await api.patchCustomFields(client, ctx, "student", student.id, textOnly);
        warnings.push("student_fields_partly_saved");
      } catch (retryError) {
        warnings.push("student_fields_not_saved");
        log("warn", { evt: "openapply.student_fields_failed", studentId: student.id, error: errorForLog(retryError) });
      }
    }
  }
}

async function writeParentFields(
  client: OpenApplyClient,
  ctx: RequestContext,
  plan: SubmissionPlan,
  parents: readonly ResolvedParent[],
  targets: FieldTargets,
  warnings: string[],
) {
  const target = targets.parent.mobile;
  if (!target) return;
  for (const parent of parents) {
    // Returning families keep the number Admissions already holds.
    if (!parent.plan.mobile || (!parent.created && parent.hasMobile !== false)) continue;
    try {
      await api.patchCustomFields(client, ctx, "parent", parent.id, { [String(target.id)]: parent.plan.mobile });
    } catch (error) {
      warnings.push("parent_fields_not_saved");
      log("warn", { evt: "openapply.parent_fields_failed", ref: plan.shortReference, parentId: parent.id, error: errorForLog(error) });
    }
  }
}
