/**
 * Questions: what a pod asks whoever posted a long job, and where that person answers.
 *
 * A seat asks by writing a note in the form `triage.ts` gives, through the notes door, so asking is
 * signed and checked like anything a seat says. This door is the other half: anybody reads a job's
 * questions here, and its poster answers one with a sentence signed by the wallet that paid for the
 * job. An answer is public the moment it is given: every seat builds from the same one.
 *
 *   read     anybody, at any time: a question is asked in the open
 *   answer   the job's poster, once for each question, within a day of its being asked
 */
import { isAddressEqual, recoverMessageAddress, type Address } from "viem";
import { bodyWithin, tooLarge } from "../body.ts";
import { secondsNow } from "../clock.ts";
import { NO_STORE } from "../headers.ts";
import { MODE_NAMES, type Mode } from "../job.ts";
import { answerMessage } from "../messages.ts";
import { ROUTES } from "../routes.ts";
import type { JobRecord, JobStore } from "../store.ts";
import { AnswerSchema, hasTriage, LONGEST_ANSWER, questionsOf, type Question } from "../triage.ts";
import type { Doorkeeper } from "./Doorkeeper.ts";
import { NOTE_CLOCK_SLACK_SECONDS } from "./NoteBoard.ts";

/** A request carrying an answer, with room for its words, its signature and its field names */
const MOST_AN_ANSWER_MAY_WEIGH = LONGEST_ANSWER * 4 + 2000;

/** The length a job was posted for, and when its window ends, as its record has them; nothing for a job with no brief. */
function lengthOf(record: JobRecord): { readonly mode: Mode; readonly endsAt: Date } | undefined {
  const mode = MODE_NAMES.find((name) => name === record.tile.mode);
  return mode && record.brief ? { mode, endsAt: new Date(record.brief.endsAt) } : undefined;
}

/** A job's questions with their answers, from its notes: the one place that says what they are. */
export async function questionsOn(store: JobStore, record: JobRecord): Promise<readonly Question[]> {
  const job = lengthOf(record);
  if (!job || !hasTriage(job.mode)) return [];
  return questionsOf(job, await store.notes(record.jobId), await store.answers(record.jobId));
}

export class QuestionBoard {
  constructor(private readonly options: { readonly keeper: Doorkeeper; readonly store: JobStore }) {}

  async handle(request: Request): Promise<Response> {
    const { keeper, store } = this.options;
    const job = await keeper.job(new URL(request.url).pathname.slice(ROUTES.questions.length));
    if (!job.ok) return Response.json({ why: job.why }, { status: job.status });
    const { record, jobId, onChainId } = job.value;
    const questions = await questionsOn(store, record);

    if (request.method === "GET") return Response.json({ questions }, { headers: NO_STORE });
    if (request.method !== "POST") return Response.json({ why: "questions are read with GET and answered with POST" }, { status: 405 });

    const body = await bodyWithin(request, MOST_AN_ANSWER_MAY_WEIGH);
    if (body === undefined) return tooLarge(`an answer is at most ${LONGEST_ANSWER} characters`);
    let asked: unknown;
    try {
      asked = JSON.parse(body);
    } catch {
      return Response.json({ why: "that is not an answer" }, { status: 400 });
    }
    const parsed = AnswerSchema.safeParse(asked);
    if (!parsed.success) return Response.json({ why: parsed.error.issues[0]?.message ?? "that is not an answer" }, { status: 400 });
    const answer = parsed.data;

    const question = questions.find((one) => one.id.toLowerCase() === answer.question.toLowerCase());
    if (!question) return Response.json({ why: "there is no such question on this job" }, { status: 404 });
    if (question.answer) return Response.json({ why: "that question has been answered, and an answer is given once" }, { status: 409 });
    const now = secondsNow();
    if (Math.abs(answer.at - now) > NOTE_CLOCK_SLACK_SECONDS) return Response.json({ why: "that answer's time is not now" }, { status: 400 });
    if (now >= question.answerBy) {
      return Response.json({ why: `the day to answer that question ended at ${new Date(question.answerBy * 1000).toISOString()}: its seat has gone on with what it said it would assume` }, { status: 403 });
    }

    let signer: Address;
    try {
      signer = await recoverMessageAddress({
        message: answerMessage({ jobId, onChainId: String(onChainId), jobs: job.value.chain.jobs, question: answer.question, says: answer.says, at: answer.at }),
        signature: answer.signature,
      });
    } catch {
      return Response.json({ why: "that signature could not be read" }, { status: 401 });
    }
    const poster = record.poster;
    if (!poster) return Response.json({ why: "this job does not say who posted it, so nobody can answer for them here" }, { status: 409 });
    if (!isAddressEqual(signer, poster) || !isAddressEqual(answer.poster, poster)) {
      return Response.json({ why: "only whoever posted this job answers its pod, with the wallet that paid for it" }, { status: 403 });
    }

    await store.addAnswer(jobId, answer);
    return Response.json({ answer }, { status: 201 });
  }
}
