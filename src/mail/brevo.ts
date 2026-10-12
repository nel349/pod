// Mail sent through Brevo, by its web address and nothing else: one POST for one message.
//
// Brevo sends from an address it has confirmed belongs to whoever holds the key, which takes a click
// on a link and no domain. The key is the account's, so it lives in the server's settings and is never
// logged, drawn or handed to a page.
import { firstLine } from "../errors.ts";
import { isEmail, type Mail, type Mailer } from "./Mailer.ts";

/** Where Brevo answers, and the one door of it used here. */
export const BREVO = "https://api.brevo.com";
export const BREVO_SEND_PATH = "/v3/smtp/email";

/** The settings that name Brevo: the account's key, and the confirmed address mail is sent from. */
export const BREVO_SETTINGS = {
  key: "POD_BREVO_KEY",
  from: "POD_MAIL_FROM",
  fromName: "POD_MAIL_FROM_NAME",
} as const;

/** Who a message says it is from, when the settings do not say. */
const DEFAULT_FROM_NAME = "POD";

/** How long Brevo is given to take one message before the send is called failed and tried again later. */
const SEND_TIMEOUT_MS = 20_000;

export interface BrevoOptions {
  readonly key: string;
  /** the sender address Brevo has confirmed */
  readonly from: string;
  readonly fromName?: string;
  /** where Brevo is reached, when it is not Brevo itself */
  readonly endpoint?: string;
}

/** The settings name Brevo, or nothing does: a key with no sender, or a sender with no key, is refused by name. */
export function brevoFromTheEnvironment(environment: Record<string, string | undefined> = process.env): Mailer | undefined {
  const key = environment[BREVO_SETTINGS.key]?.trim();
  const from = environment[BREVO_SETTINGS.from]?.trim();
  if (!key && !from) return undefined;
  if (!key || !from) {
    throw new Error(`${BREVO_SETTINGS.key} and ${BREVO_SETTINGS.from} go together: mail is sent with the account's key, from an address the mail service has confirmed`);
  }
  if (!isEmail(from)) throw new Error(`${BREVO_SETTINGS.from} is not an email address`);
  const fromName = environment[BREVO_SETTINGS.fromName]?.trim();
  return brevo({ key, from, ...(fromName ? { fromName } : {}) });
}

export function brevo(options: BrevoOptions): Mailer {
  const endpoint = options.endpoint ?? BREVO;
  return {
    name: "Brevo",
    async send(mail: Mail): Promise<void> {
      const response = await fetch(`${endpoint}${BREVO_SEND_PATH}`, {
        method: "POST",
        headers: { "api-key": options.key, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sender: { email: options.from, name: options.fromName ?? DEFAULT_FROM_NAME },
          to: [{ email: mail.to }],
          subject: mail.subject,
          textContent: mail.text,
          ...(mail.html ? { htmlContent: mail.html } : {}),
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Brevo did not take the message (${response.status}): ${await whyNot(response)}`);
    },
  };
}

/** What Brevo said was wrong, in its own words, or that it said nothing readable. */
async function whyNot(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const said: unknown = JSON.parse(text);
    if (typeof said === "object" && said !== null && "message" in said && typeof said.message === "string") return firstLine(said.message);
  } catch {
    // not JSON: its own words, cut to a line, are said as they came
  }
  return firstLine(text) || "it gave no reason";
}
