/**
 * Asking: what every seat does first on a job long enough for questions, before its own work.
 *
 * Each seat asks from where it sits: the lead about what counts as done, the builder about what it
 * needs to build it for real, the reviewer about what would make the person refuse it, security about
 * money, secrets and people's data. A seat with no model, as QA here, asks nothing. It reads what the person asked for and, where their words leave open something that changes what
 * gets built, asks them, a few questions at most, each with what it will assume if nobody answers.
 * A brief that is clear is asked nothing: a question nobody needed costs the poster a day. It is
 * shown what the rest of the pod has already asked, so the poster is not asked the same thing twice. It asks
 * once, and a seat started again finds its own questions on the server and does not ask twice.
 */
import { isAddressEqual, isAddress } from "viem";
import { z } from "zod";
import { secondsNow } from "../../clock.ts";
import { hasTriage, MOST_QUESTIONS_A_ROUND, roundAt } from "../../triage.ts";
import type { Role } from "../../job.ts";
import { askThePoster, briefFor, type Seated, type SeatWork } from "../Seated.ts";

/** What each seat asks about: its own part of the job, so five seats do not ask one question five times. */
const ASKS_ABOUT: Readonly<Record<Role, string>> = {
  lead: "what counts as done: what the person will expect to see when they open it, and what is real and what may be a mock-up",
  builder: "what you need to build it for real: which contract, service, account or data to use, and anything that needs a key or a sign-in only a person can give",
  reviewer: "what would make the person refuse it: who uses it, what it must hold or say, what must not be left out",
  qa: "how it will be tried: on what, by whom, and what a pass looks like to the person",
  security: "what could do harm: money that moves, secrets, what is kept about the people who use it, and who is allowed to do what",
};

/** How long an asking seat waits for its model */
const MODEL_MAY_TAKE_MS = 3 * 60_000;
const LONGEST_QUESTION = 400;

const AskedSchema = z.array(z.object({
  asks: z.string().trim().min(1).max(LONGEST_QUESTION),
  assumes: z.string().trim().min(1).max(LONGEST_QUESTION),
}));

/** The questions in a model's answer: the first list in it, or none when it wrote nothing that reads as one. */
export function questionsIn(answer: string): readonly { readonly asks: string; readonly assumes: string }[] {
  const listed = answer.match(/\[[\s\S]*\]/);
  if (!listed) return [];
  try {
    const parsed = AskedSchema.safeParse(JSON.parse(listed[0]));
    return parsed.success ? parsed.data.slice(0, MOST_QUESTIONS_A_ROUND) : [];
  } catch {
    return [];
  }
}

export class Asking implements SeatWork {
  private hasAsked = false;

  constructor(private readonly seated: Seated, private readonly then: SeatWork) {}

  async step(): Promise<void> {
    if (!this.hasAsked) {
      await this.ask();
      this.hasAsked = true;
    }
    await this.then.step();
  }

  private async ask(): Promise<void> {
    const { seated } = this;
    const { listed } = seated;
    if (!hasTriage(listed.mode) || !seated.model) return;
    // asked outside a round, a question is only a note, and nobody is told of it
    if (roundAt({ mode: listed.mode, endsAt: new Date(listed.endsAt) }, secondsNow()) === undefined) return;
    const asked = await seated.server.questions(seated.job);
    if (asked.some((question) => isAddress(question.agent) && isAddressEqual(question.agent, seated.identity.address))) return;

    const answer = await seated.model([
      `You are the ${seated.role} on a small team about to build what a person asked for. They can be asked questions before the work starts, and each question costs them time, and the team up to a day of waiting.`,
      `Read what they asked for. Ask only where their words leave open something that changes what gets built. Your seat asks about ${ASKS_ABOUT[seated.role]}. Leave the rest to the other seats.`,
      "Do not ask about taste, wording or anything a careful builder can decide and say on the work. If what they wrote is enough to build from, ask nothing.",
      `Ask at most ${MOST_QUESTIONS_A_ROUND} questions. For each, say what you will assume if they do not answer: the smallest honest reading of their words.`,
      "",
      'Reply with a JSON list and nothing else, each item {"asks": "...", "assumes": "..."}, or [] to ask nothing.',
      "",
      "## What is being asked for",
      briefFor(listed, seated.references),
      ...(asked.length > 0 ? ["", "## What the rest of the team has already asked, which you must not ask again", ...asked.map((question) => `- ${question.role}: ${question.asks}`)] : []),
    ].join("\n"), AbortSignal.timeout(MODEL_MAY_TAKE_MS));

    const questions = questionsIn(answer);
    for (const question of questions) await askThePoster(seated, question.asks, question.assumes);
    seated.say(questions.length === 0 ? "read the brief and found nothing to ask its poster" : `asked the poster ${questions.length === 1 ? "a question" : `${questions.length} questions`} before the work starts`);
  }
}
