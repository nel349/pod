// What POD writes to a poster about their job: that it was delivered, and that a day of their time is
// left. Said to them, about their own job by name, with the one address to go to: in plain text, and
// as a page in POD's own look for a reader whose mail shows one.
import type { Mail } from "./Mailer.ts";

/** A delivery, as much of it as a message says. */
export interface DeliveryToTell {
  readonly idea: string;
  readonly checksPassed: boolean;
  /** until when the poster may answer */
  readonly answerBy: Date;
  /** the job's page, in full, where they open the work and answer */
  readonly page: string;
  /** how many of its checks passed, of how many, the hidden ones included */
  readonly checks?: { readonly passed: number; readonly of: number };
  /** where what the pod built is live, when it is a website and is */
  readonly live?: string;
}

/** The longest a job's idea runs in a subject line before it is cut. */
const LONGEST_IDEA_IN_A_SUBJECT = 70;

const inASubject = (idea: string): string =>
  idea.length <= LONGEST_IDEA_IN_A_SUBJECT ? idea : `${idea.slice(0, LONGEST_IDEA_IN_A_SUBJECT - 1).trimEnd()}…`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const twoDigits = (value: number): string => String(value).padStart(2, "0");

/** A time said for a reader whose own clock the server cannot know, written out here so it reads the same wherever this runs. */
export function whenInAMail(when: Date): string {
  const day = `${when.getUTCDate()} ${MONTHS[when.getUTCMonth()]} ${when.getUTCFullYear()}`;
  return `${day}, ${twoDigits(when.getUTCHours())}:${twoDigits(when.getUTCMinutes())} UTC`;
}

const silence = (delivery: DeliveryToTell): string => delivery.checksPassed
  ? "If you say nothing by then, the checks decide: the pod is paid."
  : "If you say nothing by then, the checks decide: your money comes back.";

const WHY_YOU_GET_THIS = "You get this because you left this address when you posted the job. POD keeps it only to tell you about this job.";

/** What the checks found, counted when the count is known. */
function found(delivery: DeliveryToTell): string {
  const { checks } = delivery;
  if (!checks) return delivery.checksPassed ? "Its checks passed." : "Its checks failed. You can still accept it.";
  if (checks.passed === checks.of) return checks.of === 1 ? "Its check passed." : checks.of === 2 ? "Both of its checks passed." : `All ${checks.of} of its checks passed.`;
  return `${checks.passed} of its ${checks.of} checks passed. You can still accept it.`;
}

const escaped = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** POD's colours, written out here because mail reads no stylesheet. */
const LOOK = { yellow: "#ffe500", pink: "#ff2e88", ink: "#0b0b0b", paper: "#f3f3ee", grey: "#5b5b55", passed: "#117a43" } as const;
const FACE = "Arial, Helvetica, sans-serif";
// single quotes: these sit inside a style attribute, which double quotes would close
const SHOUT = `'Arial Narrow', Impact, ${FACE}`;

/** A message as a page: a yellow bill with what happened, the job by name, what was found, and one button. */
function asAPage(parts: {
  readonly shout: string; readonly delivery: DeliveryToTell; readonly lines: readonly string[]; readonly button: string;
}): string {
  const { delivery } = parts;
  const paragraph = (line: string): string => `<p style="margin:0 0 14px;font:400 16px/1.5 ${FACE};color:${LOOK.ink}">${escaped(line)}</p>`;
  const live = delivery.live
    ? `<p style="margin:0 0 14px;font:400 15px/1.5 ${FACE};color:${LOOK.ink}">It is live at <a href="${escaped(delivery.live)}" style="color:${LOOK.ink}">${escaped(delivery.live)}</a></p>`
    : "";
  return `<!doctype html><html lang="en"><body style="margin:0;padding:0;background:${LOOK.ink}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${LOOK.ink}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="background:${LOOK.yellow};padding:26px 28px 22px">
<p style="margin:0 0 10px;font:700 13px/1.2 ${FACE};letter-spacing:1px;color:${LOOK.ink}">POD · PROOF OF DEVELOPMENT</p>
<p style="margin:0;font:900 34px/1 ${SHOUT};text-transform:uppercase;color:${LOOK.ink}">${escaped(parts.shout)}</p>
</td></tr>
<tr><td style="background:${LOOK.paper};padding:26px 28px 8px">
<p style="margin:0 0 16px;font:700 20px/1.3 ${FACE};color:${LOOK.ink}">${escaped(delivery.idea)}</p>
<p style="margin:0 0 16px"><span style="display:inline-block;padding:5px 10px 4px;background:${delivery.checksPassed ? LOOK.passed : LOOK.pink};color:#ffffff;font:700 14px/1.2 ${FACE}">${escaped(found(delivery))}</span></p>
${live}${parts.lines.map(paragraph).join("\n")}
<p style="margin:8px 0 22px"><a href="${escaped(delivery.page)}" style="display:inline-block;padding:14px 22px 12px;background:${LOOK.ink};color:${LOOK.yellow};font:900 20px/1 ${SHOUT};text-transform:uppercase;text-decoration:none;border-right:5px solid ${LOOK.pink};border-bottom:5px solid ${LOOK.pink}">${escaped(parts.button)}</a></p>
</td></tr>
<tr><td style="background:${LOOK.paper};padding:0 28px 24px;border-top:2px solid ${LOOK.ink}">
<p style="margin:14px 0 0;font:400 13px/1.45 ${FACE};color:${LOOK.grey}">${escaped(WHY_YOU_GET_THIS)}</p>
</td></tr></table></td></tr></table></body></html>`;
}

/** The message that a job was delivered: what its checks found, where to open it, and until when to answer. */
export function deliveredMail(delivery: DeliveryToTell): Omit<Mail, "to"> {
  const until = `You have until ${whenInAMail(delivery.answerBy)} to answer. ${silence(delivery)}`;
  return {
    subject: `Your job is delivered: ${inASubject(delivery.idea)}`,
    text: [
      "The work you asked for on POD has been delivered.",
      delivery.idea,
      found(delivery),
      ...(delivery.live ? [`It is live at:\n${delivery.live}`] : []),
      `Open it, then accept or refuse it, here:\n${delivery.page}`,
      until,
      WHY_YOU_GET_THIS,
    ].join("\n\n"),
    html: asAPage({
      shout: "Your job is delivered", delivery, button: "Open it and answer",
      lines: ["Open what was built, then accept or refuse it. Nobody is paid before you answer.", until],
    }),
  };
}

/** The message a day before the poster's time runs out, when they have not answered. */
export function lastDayMail(delivery: DeliveryToTell): Omit<Mail, "to"> {
  const until = `You have until ${whenInAMail(delivery.answerBy)}. ${silence(delivery)}`;
  return {
    subject: `One day left to answer: ${inASubject(delivery.idea)}`,
    text: [
      "Your job on POD was delivered, and you have not accepted or refused it yet.",
      delivery.idea,
      until,
      ...(delivery.live ? [`It is live at:\n${delivery.live}`] : []),
      `Open it and answer here:\n${delivery.page}`,
      WHY_YOU_GET_THIS,
    ].join("\n\n"),
    html: asAPage({
      shout: "One day left to answer", delivery, button: "Open it and answer",
      lines: ["Your job was delivered, and you have not accepted or refused it yet.", until],
    }),
  };
}
