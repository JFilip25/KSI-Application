import { NextResponse } from "next/server";
import { ApplicationSchema } from "@/lib/schema";
import { pushApplication } from "@/lib/openapply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return NextResponse.json({ error: "Expected a JSON submission." }, { status: 415 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 150_000) {
    return NextResponse.json({ error: "Submission is too large." }, { status: 413 });
  }

  try {
    const raw = await request.json();
    const parsed = ApplicationSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Please review the highlighted information.", fields: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    if (parsed.data.website || Date.now() - parsed.data.startedAt < 2_000) {
      return NextResponse.json({ error: "Unable to accept this submission." }, { status: 400 });
    }

    const result = await pushApplication(parsed.data);
    return NextResponse.json(result, {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("Application submission failed", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json(
      { error: "We could not submit the application. Your draft remains on this device; please try again." },
      { status: 502 },
    );
  }
}
