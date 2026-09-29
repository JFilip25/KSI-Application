import { requiredDocuments, type DocumentItem } from "../documents";
import { NEXT_STEPS, paymentSubject } from "../next-steps";
import type { AppliedEvent } from "../openapply/push";
import { getSuggestedPlacement } from "../placement";
import { EmailError, sendEmail } from "./brevo";

type Recipient = AppliedEvent["parents"][number];

export type ConfirmationEmail = { subject: string; text: string; html: string };

const SUBJECT = `Thank you for applying to ${NEXT_STEPS.schoolName}`;

function clean(value: string) {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function documentText(item: DocumentItem) {
  return item.status === "acknowledged-missing" ? `${item.label} — you can still upload them later if they become available` : item.label;
}

/** The email for one parent. Every value the family typed is escaped in the HTML version. */
export function buildConfirmationEmail(event: AppliedEvent, recipient: Recipient): ConfirmationEmail {
  const { application } = event;
  const academicYear = application.academicYear.replace("-", "–");
  const children = event.children.map(({ child, studentId }) => ({
    name: clean(`${child.firstName} ${child.lastName}`),
    url: NEXT_STEPS.openApply.applicantPage(studentId),
    group: getSuggestedPlacement(child.dateOfBirth, application.academicYear)?.group ?? null,
  }));
  const documents = requiredDocuments({ ...application, children: event.children.map(({ child }) => child) });
  const documentRows = [
    ...documents.family.map((item) => documentText(item)),
    ...documents.children.flatMap((child) => child.items.map((item) => `${clean(child.name)}: ${documentText(item)}`)),
  ];
  const greeting = `Dear ${clean(`${recipient.firstName} ${recipient.lastName}`)},`;
  const email = recipient.email.trim();
  const fee = `${NEXT_STEPS.registrationFeeEur} EUR per child`;
  const reference = event.shortReference;

  const text = [
    greeting,
    "",
    `Thank you for applying to ${NEXT_STEPS.schoolName}! Your application is now complete.`,
    "",
    `You can access your personal Applicant Status page here:`,
    ...children.map((child) => `${child.name}: ${child.url}`),
    "",
    `First time signing in to OpenApply? Set your password with this email address (${email}) here:`,
    NEXT_STEPS.openApply.setPassword,
    "",
    "Documents to upload in OpenApply",
    "Please upload these to the Checklist on your Applicant Status page. You can add them now or later.",
    ...documentRows.map((row) => `- ${row}`),
    "",
    "Please take a moment to review your Checklist and ensure that all required documents have been uploaded.",
    "",
    "Next Step – Registration Payment",
    `To reserve a place for your child and schedule an admissions interview, a registration payment of ${fee} is required.`,
    "You may complete the payment in one of the following ways:",
    "",
    "1. Bank Transfer",
    "If paying by bank transfer, please email the following information to our Finance Office:",
    ...NEXT_STEPS.bankTransferDetails.map((detail) => `- ${detail}`),
    `Email: ${NEXT_STEPS.financeEmail}`,
    "Please use the following email subject format:",
    ...children.map((child) => paymentSubject(application.academicYear, child.name, child.group)),
    "",
    "2. Credit Card (in person at school)",
    `You may also pay by credit card directly at the school reception. Please note that additional ${NEXT_STEPS.cardFeePercent}% fees are added for card transactions.`,
    "",
    `If you have any questions, please email ${NEXT_STEPS.admissionsEmail}.`,
    "We are here to help.",
    "",
    "Best regards,",
    "",
    `Admissions Office at ${NEXT_STEPS.schoolName}`,
    NEXT_STEPS.admissionsSignatory,
    "",
    `Application reference: ${reference} · Academic year ${academicYear}`,
  ].join("\n");

  const link = (url: string, label = url) => `<a href="${escapeHtml(url)}" style="color:#1d4f91">${escapeHtml(label)}</a>`;
  const list = (items: string[]) => `<ul style="margin:6px 0 14px;padding-left:20px">${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1f2340;max-width:640px">
<p>${escapeHtml(greeting)}</p>
<p>Thank you for applying to ${escapeHtml(NEXT_STEPS.schoolName)}! Your application is now complete.</p>
<p>You can access your personal Applicant Status page here:</p>
${list(children.map((child) => `${escapeHtml(child.name)}: ${link(child.url)}`))}
<p>First time signing in to OpenApply? ${link(NEXT_STEPS.openApply.setPassword, "Set your password")} with this email address (${escapeHtml(email)}).</p>
<h3 style="margin:22px 0 6px;font-size:16px">Documents to upload in OpenApply</h3>
<p>Please upload these to the Checklist on your Applicant Status page. You can add them now or later.</p>
${list(documentRows.map(escapeHtml))}
<p>Please take a moment to review your Checklist and ensure that all required documents have been uploaded.</p>
<h3 style="margin:22px 0 6px;font-size:16px">Next Step – Registration Payment</h3>
<p>To reserve a place for your child and schedule an admissions interview, a registration payment of <strong>${escapeHtml(fee)}</strong> is required. You may complete the payment in one of the following ways:</p>
<p><strong>1. Bank Transfer</strong><br>If paying by bank transfer, please email the following information to our Finance Office:</p>
${list(NEXT_STEPS.bankTransferDetails.map(escapeHtml))}
<p>Email: ${link(`mailto:${NEXT_STEPS.financeEmail}`, NEXT_STEPS.financeEmail)}<br>Please use the following email subject format:<br>${children
    .map((child) => `<em>${escapeHtml(paymentSubject(application.academicYear, child.name, child.group))}</em>`)
    .join("<br>")}</p>
<p><strong>2. Credit Card (in person at school)</strong><br>You may also pay by credit card directly at the school reception. Please note that additional ${NEXT_STEPS.cardFeePercent}% fees are added for card transactions.</p>
<p>If you have any questions, please email ${link(`mailto:${NEXT_STEPS.admissionsEmail}`, NEXT_STEPS.admissionsEmail)}.<br>We are here to help.</p>
<p>Best regards,</p>
<p>Admissions Office at ${escapeHtml(NEXT_STEPS.schoolName)}<br>${escapeHtml(NEXT_STEPS.admissionsSignatory)}</p>
<p style="color:#6b6f85;font-size:12px">Application reference: ${escapeHtml(reference)} · Academic year ${escapeHtml(academicYear)}</p>
</div>`;

  return { subject: SUBJECT, text, html };
}

let warnedMissingKey = false;

/**
 * Emails every linked parent. Returns "sent" when at least one email went out and "skipped" when
 * BREVO_API_KEY is not configured; throws only if every email failed.
 */
export async function sendConfirmation(
  event: AppliedEvent,
  options: { apiKey?: string; fetch?: typeof fetch } = {},
): Promise<"sent" | "skipped"> {
  const apiKey = (options.apiKey ?? process.env.BREVO_API_KEY)?.trim();
  if (!apiKey) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn(JSON.stringify({ evt: "confirmation_email.skipped", reason: "BREVO_API_KEY is not set" }));
    }
    return "skipped";
  }

  const seen = new Set<string>();
  const recipients = event.parents.filter((parent) => {
    const key = parent.email.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let sent = 0;
  let lastError: unknown = null;
  for (const recipient of recipients) {
    const message = buildConfirmationEmail(event, recipient);
    try {
      await sendEmail(
        {
          sender: NEXT_STEPS.sender,
          to: [{ email: recipient.email.trim(), name: clean(`${recipient.firstName} ${recipient.lastName}`) }],
          replyTo: { email: NEXT_STEPS.admissionsEmail, name: `${NEXT_STEPS.sender.name} Admissions` },
          subject: message.subject,
          html: message.html,
          text: message.text,
          tags: ["ksi-online-application"],
        },
        { apiKey, fetch: options.fetch },
      );
      sent += 1;
    } catch (error) {
      lastError = error;
      console.warn(
        JSON.stringify({
          evt: "confirmation_email.failed",
          ref: event.shortReference,
          message: error instanceof Error ? error.message : "Unknown error",
          status: error instanceof EmailError ? error.status : undefined,
        }),
      );
    }
  }
  if (sent === 0 && lastError) throw lastError;
  return sent > 0 ? "sent" : "skipped";
}
