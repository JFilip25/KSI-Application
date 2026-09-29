import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailError, sendEmail } from "@/lib/email/brevo";
import { buildConfirmationEmail, sendConfirmation } from "@/lib/email/confirmation";
import type { AppliedEvent } from "@/lib/openapply";
import { makeApplication, makeChild, makeParent } from "./support/application";

function event(overrides: Partial<AppliedEvent> = {}): AppliedEvent {
  const application = makeApplication({
    academicYear: "2026-2027",
    familySituation: "separated",
    children: [
      makeChild({ firstName: "Mila", lastName: "Šćekić", dateOfBirth: "2022-03-10", vaccinationRecords: "not-available", vaccinationAcknowledgement: true }),
      makeChild({ firstName: "Luka", lastName: "Šćekić", dateOfBirth: "2013-05-20" }),
    ],
    parent1: makeParent({ firstName: "Ana", lastName: "Šćekić", email: "ana@example.com" }),
    parent2: makeParent({ firstName: "Marko", lastName: "Šćekić", relationship: "father", email: "marko@example.com" }),
  });
  return {
    application,
    reference: application.applicationReference,
    shortReference: application.applicationReference.split("-")[0].toUpperCase(),
    parents: [
      { email: "ana@example.com", firstName: "Ana", lastName: "Šćekić" },
      { email: "marko@example.com", firstName: "Marko", lastName: "Šćekić" },
    ],
    children: application.children.map((child, index) => ({ child, studentId: 9_700_001 + index })),
    ...overrides,
  };
}

type BrevoCall = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function brevoStub(responses: (number | "network")[] = []) {
  const calls: BrevoCall[] = [];
  const stub = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const next = responses.shift() ?? 201;
    if (next === "network") throw new TypeError("fetch failed");
    return new Response(
      JSON.stringify(next < 300 ? { messageId: `<msg-${calls.length}@smtp-relay.mailin.fr>` } : { code: "invalid_parameter", message: "email is not valid: ana@example.com" }),
      { status: next, headers: { "content-type": "application/json" } },
    );
  });
  return { stub: stub as unknown as typeof fetch, calls };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("buildConfirmationEmail", () => {
  it("follows KSI's Applied email and adds links, documents and pre-filled payment subjects", () => {
    const applied = event();
    const email = buildConfirmationEmail(applied, applied.parents[0]);
    expect(email.subject).toBe("Thank you for applying to Knightsbridge Schools International Montenegro");
    for (const text of [
      "Dear Ana Šćekić,",
      "Thank you for applying to Knightsbridge Schools International Montenegro! Your application is now complete.",
      "Mila Šćekić: https://ksimontenegro.openapply.com/dashboard/9700001",
      "Luka Šćekić: https://ksimontenegro.openapply.com/dashboard/9700002",
      "Set your password with this email address (ana@example.com) here:\nhttps://ksimontenegro.openapply.com/parents/password/new",
      "- Passport copy — Ana Šćekić",
      "- Passport copy — Marko Šćekić",
      "- Signed consent to this application from the other parent",
      "- Mila Šćekić: Vaccination records — not provided (acknowledged) — you can still upload them later if they become available",
      "- Luka Šćekić: School reports / transcripts from the last two school years",
      "Please take a moment to review your Checklist and ensure that all required documents have been uploaded.",
      "a registration payment of 800 EUR per child is required.",
      "Email: j.jokic@ksi-montenegro.com",
      "Your Full Name – Registration Payment for Academic Year 2026–2027 – Student: Mila Šćekić – Reception",
      "Your Full Name – Registration Payment for Academic Year 2026–2027 – Student: Luka Šćekić – Year 9",
      "additional 2% fees are added for card transactions.",
      "If you have any questions, please email f.jankovic@ksi-montenegro.com.",
      "Admissions Office at Knightsbridge Schools International Montenegro\nFilip Janković",
      `Application reference: ${applied.shortReference} · Academic year 2026–2027`,
    ]) {
      expect(email.text).toContain(text);
    }
    expect(email.text).not.toMatch(/<[a-z]/i);
    expect(email.html).toContain('<a href="https://ksimontenegro.openapply.com/dashboard/9700001"');
    expect(email.html).toContain('<a href="https://ksimontenegro.openapply.com/parents/password/new"');
  });

  it("escapes everything the family typed", () => {
    const applied = event();
    applied.children[0].child = { ...applied.children[0].child, firstName: `<script>alert("x")</script>` };
    const email = buildConfirmationEmail(applied, { email: "ana@example.com", firstName: "Ana <b>", lastName: "O'Neil & Co" });
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<b>");
    expect(email.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(email.html).toContain("Dear Ana &lt;b&gt; O&#39;Neil &amp; Co,");
  });
});

describe("sendConfirmation", () => {
  it("skips sending when Brevo is not configured", async () => {
    const { stub, calls } = brevoStub();
    vi.stubEnv("BREVO_API_KEY", "");
    expect(await sendConfirmation(event(), { fetch: stub })).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("emails each linked parent once from the KSI sender", async () => {
    const { stub, calls } = brevoStub();
    const applied = event({
      parents: [
        { email: "ana@example.com", firstName: "Ana", lastName: "Šćekić" },
        { email: "ANA@example.com ", firstName: "Ana", lastName: "Again" },
        { email: "marko@example.com", firstName: "Marko", lastName: "Šćekić" },
      ],
    });
    expect(await sendConfirmation(applied, { apiKey: "test-key", fetch: stub })).toBe("sent");
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(calls[0].headers).toMatchObject({ "api-key": "test-key", "content-type": "application/json" });
    expect(calls[0].body).toMatchObject({
      sender: { name: "KSI Montenegro", email: "f.jankovic@ksi-montenegro.com" },
      to: [{ email: "ana@example.com", name: "Ana Šćekić" }],
      replyTo: { email: "f.jankovic@ksi-montenegro.com" },
      subject: "Thank you for applying to Knightsbridge Schools International Montenegro",
      tags: ["ksi-online-application"],
    });
    expect(String(calls[1].body.textContent)).toContain("Dear Marko Šćekić,");
  });

  it("counts as sent when at least one parent got the email", async () => {
    const { stub } = brevoStub([400, 201]);
    expect(await sendConfirmation(event(), { apiKey: "test-key", fetch: stub })).toBe("sent");
  });

  it("fails only when no email could be sent, without leaking addresses", async () => {
    const { stub } = brevoStub([401, "network"]);
    const outcome = await sendConfirmation(event(), { apiKey: "test-key", fetch: stub }).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(EmailError);
    const warnings = vi.mocked(console.warn).mock.calls.map((call) => String(call[0])).join("\n");
    expect(warnings).toContain("confirmation_email.failed");
    expect(warnings).not.toContain("ana@example.com");
  });
});

describe("sendEmail", () => {
  it("reports Brevo's status and code without the recipient's address", async () => {
    const { stub } = brevoStub([400]);
    const error = (await sendEmail(
      { sender: { email: "from@example.com" }, to: [{ email: "ana@example.com" }], subject: "Hi", html: "<p>Hi</p>", text: "Hi" },
      { apiKey: "k", fetch: stub },
    ).catch((caught: unknown) => caught)) as EmailError;
    expect(error).toBeInstanceOf(EmailError);
    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_parameter");
    expect(error.message).toBe("Brevo rejected the email (400): email is not valid: [email]");
  });

  it("returns Brevo's message ID and strips line breaks from names and subject", async () => {
    const { stub, calls } = brevoStub([201]);
    const result = await sendEmail(
      { sender: { email: "from@example.com", name: "KSI\r\nBcc: x" }, to: [{ email: "a@example.com", name: "A\nB" }], subject: "Hi\nthere", html: "", text: "" },
      { apiKey: "k", fetch: stub },
    );
    expect(result.messageId).toBe("<msg-1@smtp-relay.mailin.fr>");
    expect(calls[0].body).toMatchObject({ sender: { name: "KSI Bcc: x" }, to: [{ name: "A B" }], subject: "Hi there" });
  });
});
