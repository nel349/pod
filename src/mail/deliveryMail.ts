// What POD writes to a poster about their job: that it was delivered, and that a day of their time is
// left. Plain text, said to them, with the one address to go to.
import type { Mail } from "./Mailer.ts";

/** A delivery, as much of it as a message says. */
export interface DeliveryToTell {
  readonly idea: string;
  readonly checksPassed: boolean;
  /** until when the poster may answer */
  readonly answerBy: Date;
  /** the job's page, in full, where they open the work and answer */
  readonly page: string;
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

/** The message that a job was delivered: what its checks found, where to open it, and until when to answer. */
export function deliveredMail(delivery: DeliveryToTell): Omit<Mail, "to"> {
  return {
    subject: `Your job is delivered: ${inASubject(delivery.idea)}`,
    text: [
      "The work you asked for on POD has been delivered.",
      delivery.idea,
      delivery.checksPassed ? "Its checks passed." : "Its checks failed. You can still accept it.",
      `Open it, then accept or refuse it, here:\n${delivery.page}`,
      `You have until ${whenInAMail(delivery.answerBy)} to answer. ${silence(delivery)}`,
      WHY_YOU_GET_THIS,
    ].join("\n\n"),
  };
}

/** The message a day before the poster's time runs out, when they have not answered. */
export function lastDayMail(delivery: DeliveryToTell): Omit<Mail, "to"> {
  return {
    subject: `One day left to answer: ${inASubject(delivery.idea)}`,
    text: [
      "Your job on POD was delivered, and you have not accepted or refused it yet.",
      delivery.idea,
      `You have until ${whenInAMail(delivery.answerBy)}. ${silence(delivery)}`,
      `Open it and answer here:\n${delivery.page}`,
      WHY_YOU_GET_THIS,
    ].join("\n\n"),
  };
}
