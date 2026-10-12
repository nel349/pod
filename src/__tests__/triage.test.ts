import { describe, expect, test } from "bun:test";
import type { Note } from "../note.ts";
import {
  ANSWER_WITHIN_SECONDS, ASKS_THE_POSTER, hasTriage, OPENING_SLACK_SECONDS, isWaiting, MOST_QUESTIONS_A_ROUND, openedAt, questionIn, questionNote, questionsOf, raisedIn, raisedNote, ROUND_SECONDS, roundAt, settledAs,
  type TriageAnswer,
} from "../triage.ts";

/**
 * Triage's rules, as plain state: which jobs have questions, what counts as one, which round it is in,
 * and until when its poster may answer. The doors and the pages only apply what is decided here.
 */

const WEEK = 7 * 24 * 3600;
const OPENED = 1_800_000_000;
const A_WEEK = { mode: "project" as const, endsAt: new Date((OPENED + WEEK) * 1000) };
const AGENT = "0x00000000000000000000000000000000000000a1" as const;
const OTHER = "0x00000000000000000000000000000000000000b2" as const;

let signed = 0;
const note = (says: string, at: number, agent: `0x${string}` = AGENT): Note =>
  ({ agent, role: "lead", says, at, signature: `0x${(++signed).toString(16).padStart(4, "0")}` });
const asking = (asks: string, at: number, agent: `0x${string}` = AGENT): Note => note(questionNote(asks, "a mock-up, said to be one"), at, agent);

describe("triage: what a pod asks whoever posted a long job", () => {
  test("only a job of a week has questions: two hours and a day are one shot", () => {
    expect(hasTriage("project")).toBe(true);
    expect(hasTriage("flash")).toBe(false);
    expect(hasTriage("sprint")).toBe(false);
    const aDay = { mode: "sprint" as const, endsAt: new Date((OPENED + 24 * 3600) * 1000) };
    expect(questionsOf(aDay, [asking("A real mint, or a mock-up?", OPENED + 60)])).toEqual([]);
  });

  test("a question is a note written as one, and says what its seat will assume if nobody answers", () => {
    const says = questionNote("  A real mint, or a mock-up?  ", " a mock-up, said to be one ");
    expect(questionIn(says)).toEqual({ asks: "A real mint, or a mock-up?", assumes: "a mock-up, said to be one" });
    // anything else is an ordinary note: no answer is owed to it
    expect(questionIn("Approved: every line is answered.")).toBeUndefined();
    expect(questionIn("Question for whoever posted this job:\nA real mint?")).toBeUndefined();
    expect(questionIn(questionNote("A real mint?", "   "))).toBeUndefined();
    expect(questionsOf(A_WEEK, [note("Approved: every line is answered.", OPENED + 60)])).toEqual([]);
  });

  test("two rounds, a day each, from when the job opened; after them nothing more is asked", () => {
    expect(openedAt(A_WEEK)).toBe(OPENED);
    expect(roundAt(A_WEEK, OPENED)).toBe(1);
    expect(roundAt(A_WEEK, OPENED + ROUND_SECONDS - 1)).toBe(1);
    expect(roundAt(A_WEEK, OPENED + ROUND_SECONDS)).toBe(2);
    expect(roundAt(A_WEEK, OPENED + 2 * ROUND_SECONDS - 1)).toBe(2);
    expect(roundAt(A_WEEK, OPENED + 2 * ROUND_SECONDS)).toBeUndefined();
    // a writer's clock a little behind the chain's still falls in the first round; one far behind falls in none
    expect(roundAt(A_WEEK, OPENED - 1)).toBe(1);
    expect(roundAt(A_WEEK, OPENED - OPENING_SLACK_SECONDS - 1)).toBeUndefined();

    const late = asking("Too late to ask?", OPENED + 2 * ROUND_SECONDS + 5);
    const found = questionsOf(A_WEEK, [asking("Round one?", OPENED + 100), asking("Round two?", OPENED + ROUND_SECONDS + 100), late]);
    expect(found.map((one) => [one.asks, one.round])).toEqual([["Round one?", 1], ["Round two?", 2]]);
  });

  test("the lead puts a few questions a round to the poster and no more; a question from any other seat is a note to its pod", () => {
    const many = Array.from({ length: MOST_QUESTIONS_A_ROUND + 2 }, (_, at) => asking(`Question ${at + 1}?`, OPENED + 100 + at));
    const fromTheBuilder: Note = { ...asking("Straight from the builder?", OPENED + 200, OTHER), role: "builder" };
    const found = questionsOf(A_WEEK, [...many, fromTheBuilder, asking("Next round?", OPENED + ROUND_SECONDS + 5)]);
    expect(found.map((one) => one.asks)).toEqual([...Array.from({ length: MOST_QUESTIONS_A_ROUND }, (_, at) => `Question ${at + 1}?`), "Next round?"]);
    expect(found.every((one) => one.role === ASKS_THE_POSTER)).toBe(true);
  });

  test("a seat raises a question with its lead in a form of its own, which is never read as a question to the poster", () => {
    const says = raisedNote(" Is there a price list? ", " No list: example prices, marked as examples. ");
    expect(raisedIn(says)).toEqual({ asks: "Is there a price list?", assumes: "No list: example prices, marked as examples." });
    expect(questionIn(says)).toBeUndefined();
    expect(raisedIn(questionNote("A real mint?", "A mock-up."))).toBeUndefined();
    expect(raisedIn("Builder, keep the pages small.")).toBeUndefined();
    expect(questionsOf(A_WEEK, [note(says, OPENED + 100)])).toEqual([]);
  });

  test("the poster has a day from when it was asked; an answer is kept with its question, and silence leaves the assumption standing", () => {
    const first = asking("A real mint, or a mock-up?", OPENED + 100);
    const second = asking("Which chain?", OPENED + 200);
    const answer: TriageAnswer = { question: first.signature, says: "A real mint, on Monad testnet.", at: OPENED + 500, poster: OTHER, signature: "0xbeef" };
    const [answered, silent] = questionsOf(A_WEEK, [first, second], [answer]);
    if (!answered || !silent) throw new Error("two questions were asked");

    expect(answered.answerBy).toBe(OPENED + 100 + ANSWER_WITHIN_SECONDS);
    expect(answered.answer).toEqual({ says: "A real mint, on Monad testnet.", at: OPENED + 500 });
    expect(isWaiting(answered, OPENED + 600)).toBe(false);
    expect(settledAs(answered)).toBe("Asked: A real mint, or a mock-up?\nThe poster answered: A real mint, on Monad testnet.");

    // unanswered: the pod waits while there is time, and then goes on with what it said it would assume
    expect(isWaiting(silent, OPENED + 600)).toBe(true);
    expect(isWaiting(silent, silent.answerBy)).toBe(false);
    expect(settledAs(silent)).toBe("Asked: Which chain?\nNot answered, so assumed: a mock-up, said to be one");
    // an answer that names no question here answers nothing
    expect(questionsOf(A_WEEK, [second], [answer])[0]?.answer).toBeUndefined();
  });
});
