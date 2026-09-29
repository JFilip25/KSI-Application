import { redact } from "../openapply/errors";

/** Minimal client for Brevo's transactional email API (https://developers.brevo.com/reference/sendtransacemail). */

export type EmailAddress = { email: string; name?: string };

export type EmailMessage = {
  sender: EmailAddress;
  to: EmailAddress[];
  replyTo?: EmailAddress;
  subject: string;
  html: string;
  text: string;
  tags?: string[];
};

export class EmailError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, info: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "EmailError";
    this.status = info.status;
    this.code = info.code;
  }
}

const ENDPOINT = "https://api.brevo.com/v3/smtp/email";

function oneLine(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function address(value: EmailAddress) {
  return value.name ? { email: value.email, name: oneLine(value.name) } : { email: value.email };
}

/**
 * Sends one email. Not retried after a timeout or server error: the message may already have
 * gone out, and a duplicate is worse than a missing copy (the thank-you page shows the same steps).
 */
export async function sendEmail(
  message: EmailMessage,
  options: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number },
): Promise<{ messageId: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "api-key": options.apiKey },
      body: JSON.stringify({
        sender: address(message.sender),
        to: message.to.map(address),
        ...(message.replyTo ? { replyTo: address(message.replyTo) } : {}),
        subject: oneLine(message.subject),
        htmlContent: message.html,
        textContent: message.text,
        ...(message.tags?.length ? { tags: message.tags } : {}),
      }),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    throw new EmailError(controller.signal.aborted ? "Brevo did not respond in time." : "Could not reach Brevo.");
  } finally {
    clearTimeout(timer);
  }

  const body = (await response.json().catch(() => ({}))) as { messageId?: string; code?: string; message?: string };
  if (!response.ok) {
    const detail = typeof body.message === "string" ? `: ${redact(body.message)}` : "";
    throw new EmailError(`Brevo rejected the email (${response.status})${detail}`, { status: response.status, code: body.code });
  }
  return { messageId: typeof body.messageId === "string" ? body.messageId : null };
}
