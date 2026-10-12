/**
 * Triage: what a pod asks whoever posted a long job before it builds, and what they answer.
 *
 * A job of two hours or a day is one shot: the pod builds from what it was given. A job of a week has
 * room to ask. A seat asks by writing a note in a fixed form, signed like any note, so who asked is
 * checkable by anybody. Its poster answers on the job's page with their own wallet, so every seat reads
 * the same answer and it stays on the record. Each question says what the seat will assume if nobody
 * answers, and after a day it goes on assuming it: a poster who is away holds nothing up.
 *
 * Nothing here reads a clock, a disk or a chain: it says what a note is and what the rules are.
 */
import { isAddress, isHex, type Address } from "viem";
import { z } from "zod";
import { MODES, type Mode, type Role } from "./job.ts";
import type { Note } from "./note.ts";
import { SEATS } from "./seal.ts";

/** The jobs long enough for questions: a week. Two hours and a day are one shot. */
export const TRIAGE_MODES: readonly Mode[] = ["project"];
/** How many rounds of questions a job has, and how long each lasts, counted from when it opened. */
export const TRIAGE_ROUNDS = 2;
export const ROUND_SECONDS = 24 * 60 * 60;
/** How long a poster has to answer a question, from when it was asked. After it, the seat goes on with what it said it would assume. */
export const ANSWER_WITHIN_SECONDS = 24 * 60 * 60;
/** How many questions one seat may ask in one round: enough to settle what matters, too few to bury a poster. */
export const MOST_QUESTIONS_A_ROUND = 3;
export const LONGEST_ANSWER = 2000;

/** The two lines a question's note is written with, so a question is told from any other note by its form alone. */
export const ASKS = "Question for whoever posted this job:";
export const ASSUMES = "If nobody answers within a day, I will assume:";

/** A note's words for a question and the assumption it falls back on. */
export function questionNote(asks: string, assumes: string): string {
  return `${ASKS}\n${asks.trim()}\n${ASSUMES}\n${assumes.trim()}`;
}

/** The question and the assumption in a note's words, or nothing when it is not written as one. */
export function questionIn(says: string): { readonly asks: string; readonly assumes: string } | undefined {
  if (!says.startsWith(`${ASKS}\n`)) return undefined;
  const rest = says.slice(ASKS.length + 1);
  const at = rest.indexOf(`\n${ASSUMES}\n`);
  if (at === -1) return undefined;
  const asks = rest.slice(0, at).trim();
  const assumes = rest.slice(at + ASSUMES.length + 2).trim();
  return asks === "" || assumes === "" ? undefined : { asks, assumes };
}

/** A poster's answer as it arrives. Nothing in it is trusted until the signature is the poster's. */
export const AnswerSchema = z.object({
  /** the question it answers, named by the signature of the note that asked it */
  question: z.string().refine((signature): signature is `0x${string}` => isHex(signature), "the question is named by its note's signature"),
  says: z.string().max(LONGEST_ANSWER, `an answer is at most ${LONGEST_ANSWER} characters`).refine((says) => says.trim() !== "", "an answer says something"),
  /** seconds since 1970, as the poster signed it */
  at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  poster: z.string().refine((poster): poster is Address => isAddress(poster), "the poster is an address"),
  signature: z.string().refine((signature): signature is `0x${string}` => isHex(signature), "the signature is hex"),
}).strict();
export type TriageAnswer = z.infer<typeof AnswerSchema>;

/** A question as a server hands it over, read by an agent that trusts the server no further than it can check. */
export const QuestionSchema = z.object({
  id: z.string(), role: z.enum(SEATS), agent: z.string(), asks: z.string(), assumes: z.string(),
  askedAt: z.number(), round: z.number(), answerBy: z.number(),
  answer: z.object({ says: z.string(), at: z.number() }).optional(),
});

/** One question as a page or an agent reads it. */
export interface Question {
  /** the signature of the note that asked it: its name everywhere */
  readonly id: string;
  readonly role: Role;
  readonly agent: string;
  readonly asks: string;
  readonly assumes: string;
  /** seconds since 1970 */
  readonly askedAt: number;
  /** 1 or 2 */
  readonly round: number;
  /** until when the poster may answer; after it the seat goes on with what it said it would assume */
  readonly answerBy: number;
  readonly answer?: { readonly says: string; readonly at: number };
}

/** Whether a job of this length has questions at all. */
export const hasTriage = (mode: Mode): boolean => TRIAGE_MODES.includes(mode);

/** When a job opened, in seconds: its window's end less its window. */
export function openedAt(job: { readonly mode: Mode; readonly endsAt: Date }): number {
  return Math.floor(job.endsAt.getTime() / 1000) - MODES[job.mode].windowMinutes * 60;
}

/**
 * How far before a job's opening a moment may fall and still count as its first round. A job opens by
 * the chain's clock and a note is timed by its writer's, and the two are never quite the same.
 */
export const OPENING_SLACK_SECONDS = 5 * 60;

/** Which round a moment falls in, 1 or 2, or nothing once the rounds are over or before the job opened. */
export function roundAt(job: { readonly mode: Mode; readonly endsAt: Date }, at: number): number | undefined {
  const since = at - openedAt(job);
  if (since < -OPENING_SLACK_SECONDS) return undefined;
  const round = Math.floor(Math.max(since, 0) / ROUND_SECONDS) + 1;
  return round <= TRIAGE_ROUNDS ? round : undefined;
}

/**
 * The questions among a job's notes, in the order they were asked, each with its answer if it has one.
 * A note counts as a question only on a job long enough to have them, written as one, inside a round,
 * and among its seat's first few in that round: anything else is an ordinary note, and no answer is owed.
 */
export function questionsOf(
  job: { readonly mode: Mode; readonly endsAt: Date },
  notes: readonly Note[],
  answers: readonly TriageAnswer[] = [],
): readonly Question[] {
  if (!hasTriage(job.mode)) return [];
  const asked = new Map<string, number>();
  const questions: Question[] = [];
  for (const note of notes) {
    const said = questionIn(note.says);
    const round = roundAt(job, note.at);
    if (!said || round === undefined) continue;
    const seat = `${note.agent.toLowerCase()}:${round}`;
    const already = asked.get(seat) ?? 0;
    if (already >= MOST_QUESTIONS_A_ROUND) continue;
    asked.set(seat, already + 1);
    const answer = answers.find((one) => one.question.toLowerCase() === note.signature.toLowerCase());
    questions.push({
      id: note.signature, role: note.role, agent: note.agent, asks: said.asks, assumes: said.assumes,
      askedAt: note.at, round, answerBy: note.at + ANSWER_WITHIN_SECONDS,
      ...(answer ? { answer: { says: answer.says, at: answer.at } } : {}),
    });
  }
  return questions;
}

/** Whether a question still waits on its poster at some moment: unanswered, with time left to answer. */
export const isWaiting = (question: Question, now: number): boolean => question.answer === undefined && now < question.answerBy;

/** What a pod builds from once the asking is done: each answer, or the assumption that stands in for a missing one. */
export function settledAs(question: Question): string {
  return question.answer ? `Asked: ${question.asks}\nThe poster answered: ${question.answer.says}` : `Asked: ${question.asks}\nNot answered, so assumed: ${question.assumes}`;
}
