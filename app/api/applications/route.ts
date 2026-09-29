import { NextResponse } from "next/server";
import { sendConfirmation } from "@/lib/email/confirmation";
import { ApplicationSchema } from "@/lib/schema";
import { OpenApplyError, pushApplication } from "@/lib/openapply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// OpenApply allows 5 requests per 2 seconds, so a large family can take ~15 s to write.
export const maxDuration = 60;

const MAX_BYTES = 150_000;

function reply(body: Record<string, unknown>, status: number, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return reply({ error: "Expected a JSON submission." }, 415);
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BYTES) {
    return reply({ error: "Submission is too large." }, 413);
  }

  const text = await request.text();
  if (text.length > MAX_BYTES) {
    return reply({ error: "Submission is too large." }, 413);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return reply({ error: "Expected a JSON submission." }, 400);
  }

  const parsed = ApplicationSchema.safeParse(raw);
  if (!parsed.success) {
    return reply({ error: "Please review the highlighted information.", fields: parsed.error.flatten().fieldErrors }, 400);
  }

  if (parsed.data.website || Date.now() - parsed.data.startedAt < 2_000) {
    return reply({ error: "Unable to accept this submission." }, 400);
  }

  const shortReference = parsed.data.applicationReference.split("-")[0].toUpperCase();
  try {
    const result = await pushApplication(parsed.data, { onApplied: (event) => sendConfirmation(event) });
    return reply({ reference: result.reference, dryRun: result.dryRun, emailed: result.confirmationEmail === "sent" }, 201);
  } catch (error) {
    if (error instanceof OpenApplyError) {
      // pushApplication has already logged the details.
      if (error.kind === "busy" || error.kind === "rate_limited" || error.kind === "budget") {
        return reply(
          { error: "Admissions is receiving a lot of applications right now. Your draft is saved on this device; please try again in a minute." },
          503,
          { "retry-after": "60" },
        );
      }
      if (!error.retryable) {
        return reply(
          {
            error: `We could not submit the application. Your draft is saved on this device. Please contact Admissions and quote reference ${shortReference}.`,
          },
          502,
        );
      }
    } else {
      console.error(
        JSON.stringify({
          evt: "application.submit_failed",
          ref: shortReference,
          message: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    }
    return reply({ error: "We could not submit the application. Your draft remains on this device; please try again." }, 502);
  }
}
