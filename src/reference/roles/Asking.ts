/**
 * Asking: what a seat does first on a job long enough for questions, before its own work, the way a
 * team does it.
 *
 * Every seat reads what the person asked for and raises with the lead what it needs to know, from
 * where it sits: the builder what it needs to build it for real, the reviewer what would make the
 * person refuse it, security what could do harm. A seat with no model, as QA here, raises nothing.
 * The lead is the pod's one voice to the poster. It leaves the others a few minutes to raise theirs,
 * then reads the brief and what was raised, drops what is asked twice and what the pod can decide for
 * itself, and puts one short list to the poster, each question with what the pod will assume if nobody
 * answers. A brief that is clear is asked nothing, and the lead says so to the pod, so nobody waits.
 * Each seat does this once, and one started again finds what it already wrote and does not write it twice.
 */
import { isAddress, isAddressEqual } from "viem";
import { z } from "zod";
import { secondsNow } from "../../clock.ts";
import type { Kind, Role } from "../../job.ts";
import { ASKS_THE_POSTER, hasTriage, MOST_QUESTIONS_A_ROUND, MOST_RAISED_A_ROUND, NOTHING_TO_ASK, raisedIn, roundAt } from "../../triage.ts";
import { askThePoster, briefFor, GATHERING_SECONDS, passwordFor, raiseWithTheLead, tellThePod, type Seated, type SeatWork } from "../Seated.ts";

/** What each seat asks about: its own part of the job, so five seats do not raise one question five times. */
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

interface Asked {
  readonly asks: string;
  readonly assumes: string;
}

/** The questions in a model's answer: the first list in it, a few at most, or none when it wrote nothing that reads as one. */
export function questionsIn(answer: string, most: number = MOST_QUESTIONS_A_ROUND): readonly Asked[] {
  const listed = answer.match(/\[[\s\S]*\]/);
  if (!listed) return [];
  try {
    const parsed = AskedSchema.safeParse(JSON.parse(listed[0]));
    return parsed.success ? parsed.data.slice(0, most) : [];
  } catch {
    return [];
  }
}

/**
 * What a seat has to know about what can be built before it asks or assumes anything: a website here
 * is files and nothing else. Without it, a seat assumes a server that keeps orders, which no builder
 * here can build, and the poster is asked to choose between things that cannot exist.
 */
function whatCanBeBuilt(kind: Kind | undefined): readonly string[] {
  return kind === "site"
    ? ["What gets built is a website of plain files, served as they are with no program behind them: by itself it cannot save anything, send anything or remember a visitor. Anything it does, it does in the visitor's browser. Ask and assume only what such a site can do, and where the person seems to expect more, ask them how they want it handled within that."]
    : [];
}

const HOW_TO_REPLY = 'Reply with a JSON list and nothing else, each item {"asks": "...", "assumes": "..."}, or [] to ask nothing.';
const WHAT_IS_WORTH_ASKING = "A question is worth asking only where their words leave open something that changes what gets built. Not taste, not wording, not anything a careful builder can decide and say on the work. If what they wrote is enough to build from, ask nothing.";

export class Asking implements SeatWork {
  private isDone = false;
  /** when the lead first looked, in seconds: the others' time to raise their questions is counted from here */
  private firstLooked?: number;

  constructor(private readonly seated: Seated, private readonly then: SeatWork) {}

  async step(): Promise<void> {
    if (!this.isDone) this.isDone = await this.ask();
    await this.then.step();
  }

  /** Do this seat's part of the asking, if it is time to. True once there is nothing more of it to do. */
  private async ask(): Promise<boolean> {
    const { seated } = this;
    const { listed } = seated;
    if (!hasTriage(listed.mode) || !seated.model) return true;
    // outside a round a question is only a note, and nobody is told of it
    if (roundAt({ mode: listed.mode, endsAt: new Date(listed.endsAt) }, secondsNow()) === undefined) return true;
    return seated.role === ASKS_THE_POSTER ? this.putToThePoster(seated.model) : this.raise(seated.model);
  }

  /** A seat other than the lead: raise what it needs to know with the lead, once. */
  private async raise(model: NonNullable<Seated["model"]>): Promise<boolean> {
    const { seated } = this;
    const raised = await this.raisedSoFar();
    if (raised.some((one) => one.isMine)) return true;
    const answer = await model([
      `You are the ${seated.role} on a small team about to build what a person asked for. Your lead will put the team's questions to that person before the work starts. Each one costs them time, and the team up to a day of waiting.`,
      `Read what they asked for, and say what your lead should ask them for you. ${WHAT_IS_WORTH_ASKING}`,
      `Your seat asks about ${ASKS_ABOUT[seated.role]}. Leave the rest to the other seats.`,
      `Raise at most ${MOST_RAISED_A_ROUND} questions. For each, say what you will assume if they do not answer: the smallest honest reading of their words.`,
      ...whatCanBeBuilt(seated.listed.kind),
      "",
      HOW_TO_REPLY,
      "",
      "## What is being asked for",
      briefFor(seated.listed, seated.references),
      ...(raised.length > 0 ? ["", "## What the rest of the team has already raised, which you must not raise again", ...raised.map((one) => `- ${one.role}: ${one.asks}`)] : []),
    ].join("\n"), AbortSignal.timeout(MODEL_MAY_TAKE_MS));

    const questions = questionsIn(answer, MOST_RAISED_A_ROUND);
    for (const question of questions) await raiseWithTheLead(seated, question.asks, question.assumes);
    seated.say(questions.length === 0 ? "read the brief and raised nothing for its poster" : `raised ${questions.length === 1 ? "a question" : `${questions.length} questions`} with the lead, for its poster`);
    return true;
  }

  /** The lead: once the others have had their time, put the pod's one list to the poster, or say there is none. */
  private async putToThePoster(model: NonNullable<Seated["model"]>): Promise<boolean> {
    const { seated } = this;
    const now = secondsNow();
    this.firstLooked ??= now;
    if (now - this.firstLooked < (seated.gatheringSeconds ?? GATHERING_SECONDS)) return false;
    // found on the server, so a lead started again does not ask twice
    if (await leadHasSpoken(seated)) return true;

    const raised = (await this.raisedSoFar()).filter((one) => !one.isMine);
    const answer = await model([
      "You are the lead on a small team about to build what a person asked for. You are the team's one voice to that person, and you answer to them for the whole job.",
      `Before the work starts you may put one short list of questions to them. Each one costs them time, and the team up to a day of waiting. ${WHAT_IS_WORTH_ASKING}`,
      `Read what they asked for, and what your team raised for you to ask. Add your own, about ${ASKS_ABOUT.lead}. Fold together questions that ask the same thing, and drop any the team can decide for itself.`,
      `Ask at most ${MOST_QUESTIONS_A_ROUND} questions, the ones that matter most first. For each, say what the team will assume if they do not answer: the smallest honest reading of their words.`,
      ...whatCanBeBuilt(seated.listed.kind),
      "",
      HOW_TO_REPLY,
      "",
      "## What is being asked for",
      briefFor(seated.listed, seated.references),
      "",
      "## What your team raised",
      ...(raised.length > 0 ? raised.map((one) => `- ${one.role}: ${one.asks} (it would assume: ${one.assumes})`) : ["Nothing."]),
    ].join("\n"), AbortSignal.timeout(MODEL_MAY_TAKE_MS));

    const questions = questionsIn(answer);
    for (const question of questions) await askThePoster(seated, question.asks, question.assumes);
    // said to the pod when there is nothing, so that a builder knows not to wait
    if (questions.length === 0) await tellThePod(seated, `${NOTHING_TO_ASK} the brief and what the pod raised leave nothing open that changes what gets built.`);
    seated.say(questions.length === 0
      ? "read the brief and what the pod raised, and put nothing to its poster"
      : `put ${questions.length === 1 ? "a question" : `${questions.length} questions`} to the poster for the pod, before the work starts`);
    return true;
  }

  /** What the pod has raised with its lead so far, with whether each is this seat's own. */
  private async raisedSoFar(): Promise<readonly (Asked & { readonly role: Role; readonly isMine: boolean })[]> {
    const { seated } = this;
    const notes = await seated.server.notes(seated.job, seated.identity.address, await passwordFor(seated));
    return notes.flatMap((note) => {
      const said = raisedIn(note.says);
      return said ? [{ ...said, role: note.role, isMine: isAddress(note.agent) && isAddressEqual(note.agent, seated.identity.address) }] : [];
    });
  }
}

/**
 * Whether the pod's lead has done its asking: it has put questions to the poster, or told the pod it
 * has none. A builder reads this to know whether there is anything to wait for.
 */
export async function leadHasSpoken(seated: Seated): Promise<boolean> {
  if ((await seated.server.questions(seated.job)).length > 0) return true;
  const notes = await seated.server.notes(seated.job, seated.identity.address, await passwordFor(seated));
  return notes.some((note) => note.role === ASKS_THE_POSTER && note.says.startsWith(NOTHING_TO_ASK));
}
