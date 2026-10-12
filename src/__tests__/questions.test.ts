import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Doorkeeper, NoteBoard, QuestionBoard } from "../door/index.ts";
import { MODES, type Mode, type Role, type Spec } from "../job.ts";
import { post, takeSeat } from "../jobs.ts";
import { answerMessage, noteMessage } from "../messages.ts";
import { openJob } from "../publish.ts";
import { notesPath, questionsPath } from "../routes.ts";
import { serve } from "../server.ts";
import { JobStore } from "../store.ts";
import { ANSWER_WITHIN_SECONDS, MOST_QUESTIONS_A_ROUND, questionNote, raisedNote, type Question } from "../triage.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { anAgent, doorChainOn, type Agent } from "./support/podServer.ts";

/**
 * A pod's questions and their poster's answers, through the real doors on a real chain.
 *
 * The lead asks for its pod with a signed note, as a seat says anything. The poster answers with the wallet that paid
 * for the job. What is shown here is who may answer, what, and until when, and that a job too short
 * for questions has none however its notes are written.
 */

const available = await anvilAvailable();

let anvil: Anvil;
let jobs: Address;
let store: JobStore;
let base = "";
let server: { stop: () => void } | undefined;

const POSTER = ANVIL_KEYS[1];
const SOMEBODY_ELSE = ANVIL_KEYS[2];
const PRICE = parseEther("1");
const lead = anAgent();
const builder = anAgent();

interface Posted {
  readonly jobId: string;
  onChainId: bigint;
}
const WEEK: Posted = { jobId: "a-shop-given-a-week", onChainId: 0n };
const TWO_HOURS: Posted = { jobId: "a-page-given-two-hours", onChainId: 0n };
/** more jobs of a week, one to a test that needs the lead's few questions of a round to itself */
const ONCE: Posted = { jobId: "a-shop-answered-once", onChainId: 0n };
const WHOSE: Posted = { jobId: "a-shop-whose-answer", onChainId: 0n };
const MOVED: Posted = { jobId: "a-shop-moved-answer", onChainId: 0n };
const MANY: Posted = { jobId: "a-shop-many-questions", onChainId: 0n };
const NOT_ONE: Posted = { jobId: "a-shop-not-an-answer", onChainId: 0n };
/** a week's job that opened a day and an hour ago, with a question asked then and never answered */
const STALE: Posted = { jobId: "a-shop-nobody-answered", onChainId: 0n };

const contractAs = (key: Hex) => ({ address: jobs, publicClient: anvil.publicClient, wallet: anvil.wallet(key) });
const secondsNow = (): number => Math.floor(Date.now() / 1000);

/** A job posted on the contract and opened on the wall, of a length, having opened some seconds ago. */
async function aPostedJob(job: Posted, mode: Mode, openedSecondsAgo = 0): Promise<void> {
  const seal = `0x${"cd".repeat(32)}` as Hex;
  const endsAt = secondsNow() + MODES[mode].windowMinutes * 60 - openedSecondsAgo;
  job.onChainId = await post(contractAs(POSTER), { seal, endsAt: BigInt(endsAt), reviewers: 1, price: PRICE });
  for (const [role, agent] of [["lead", lead], ["builder", builder]] as const) await takeSeat(contractAs(agent.key), job.onChainId, role, agent.address);
  const spec: Spec = { idea: "A shop for a bakery", mode, price: PRICE, checks: [], allowed: [], salt: "nobody-can-guess" };
  const opened = await openJob(store, { jobId: job.jobId, seal, spec, endsAt: new Date(endsAt * 1000), seats: [] });
  await store.save({ ...opened, poster: privateKeyToAccount(POSTER).address, chain: { network: "monad-testnet", jobId: String(job.onChainId), jobs } });
}

beforeAll(async () => {
  if (!available) return;
  anvil = await startAnvil();
  jobs = await anvil.deploy("PodJobs", [privateKeyToAccount(ANVIL_KEYS[6]).address]);
  for (const agent of [lead, builder]) await anvil.fund(agent.address);
  store = new JobStore(await mkdtemp(join(tmpdir(), "pod-questions-jobs-")));
  for (const job of [WEEK, ONCE, WHOSE, MOVED, MANY, NOT_ONE]) await aPostedJob(job, "project");
  await aPostedJob(TWO_HOURS, "flash");
  await aPostedJob(STALE, "project", ANSWER_WITHIN_SECONDS + 3600);

  const keeper = new Doorkeeper({ store, chain: doorChainOn(anvil, jobs) });
  const serving = serve(store, 0, { notes: new NoteBoard({ keeper, store }), questions: new QuestionBoard({ keeper, store }) });
  server = serving;
  base = `http://127.0.0.1:${serving.port}`;
}, 120_000);

afterAll(() => {
  server?.stop();
  anvil?.stop();
});

/** A note as a seat signs it. */
async function aNote(agent: Agent, role: Role, job: Posted, says: string, at = secondsNow()): Promise<{ agent: Address; role: Role; says: string; at: number; signature: Hex }> {
  const signature = await privateKeyToAccount(agent.key).signMessage({
    message: noteMessage({ jobId: job.jobId, onChainId: String(job.onChainId), jobs, role, about: undefined, says, at }),
  });
  return { agent: agent.address, role, says, at, signature };
}

/** A seat asks, through the notes door, and the question's name comes back: its note's signature. */
async function ask(agent: Agent, role: Role, job: Posted, asks: string, assumes: string): Promise<Hex> {
  const note = await aNote(agent, role, job, questionNote(asks, assumes));
  const written = await fetch(`${base}${notesPath(job.jobId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(note) });
  expect(written.status).toBe(201);
  return note.signature;
}

/** An answer as a wallet signs it: by the poster, or by somebody else to show they are turned away. */
async function anAnswer(job: Posted, question: string, says: string, key: Hex = POSTER, at = secondsNow()): Promise<object> {
  const signature = await privateKeyToAccount(key).signMessage({
    message: answerMessage({ jobId: job.jobId, onChainId: String(job.onChainId), jobs, question, says, at }),
  });
  return { question, says, at, poster: privateKeyToAccount(POSTER).address, signature };
}

const send = (job: Posted, answer: object): Promise<Response> =>
  fetch(`${base}${questionsPath(job.jobId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(answer) });

const questionsOf = async (job: Posted): Promise<readonly Question[]> =>
  ((await (await fetch(`${base}${questionsPath(job.jobId)}`)).json()) as { questions: Question[] }).questions;

const why = async (answer: Response): Promise<string> => ((await answer.json()) as { why: string }).why;

describe.skipIf(!available)("what a pod asks whoever posted a week's job, and what they answer", () => {
  test("the lead asks, anybody reads the question, and the poster's signed answer is kept with it", async () => {
    const question = await ask(lead, "lead", WEEK, "Should the shop take payment, or only show the bread?", "It only shows the bread, with prices.");
    const asked = (await questionsOf(WEEK)).find((one) => one.id === question);
    expect(asked).toMatchObject({ role: "lead", asks: "Should the shop take payment, or only show the bread?", assumes: "It only shows the bread, with prices.", round: 1 });
    expect(asked?.answerBy).toBe((asked?.askedAt ?? 0) + ANSWER_WITHIN_SECONDS);
    expect(asked?.answer).toBeUndefined();

    const answered = await send(WEEK, await anAnswer(WEEK, question, "Only show it. People pay at the counter."));
    expect(answered.status).toBe(201);
    expect((await questionsOf(WEEK)).find((one) => one.id === question)?.answer?.says).toBe("Only show it. People pay at the counter.");
    expect((await store.answers(WEEK.jobId)).map((one) => one.question)).toContain(question);
  });

  test("an answer is given once", async () => {
    const question = await ask(lead, "lead", ONCE, "Which days is the bakery open?", "Every day but Monday.");
    expect((await send(ONCE, await anAnswer(ONCE, question, "Tuesday to Sunday."))).status).toBe(201);
    const again = await send(ONCE, await anAnswer(ONCE, question, "Actually every day."));
    expect(again.status).toBe(409);
    expect(await why(again)).toContain("an answer is given once");
    expect((await questionsOf(ONCE)).find((one) => one.id === question)?.answer?.says).toBe("Tuesday to Sunday.");
  });

  test("only the wallet that posted the job answers its pod", async () => {
    const question = await ask(lead, "lead", WHOSE, "Is there a logo to use?", "No logo: the name is set in type.");
    const forged = await send(WHOSE, await anAnswer(WHOSE, question, "Use any logo you like.", SOMEBODY_ELSE));
    expect(forged.status).toBe(403);
    expect(await why(forged)).toContain("only whoever posted this job");
    expect((await questionsOf(WHOSE)).find((one) => one.id === question)?.answer).toBeUndefined();
  });

  test("an answer to one question cannot be moved to another, or to a note that asked nothing", async () => {
    const first = await ask(lead, "lead", MOVED, "English only?", "English only.");
    const other = await ask(lead, "lead", MOVED, "Prices shown with tax?", "With tax.");
    const signedForFirst = (await anAnswer(MOVED, first, "English and Spanish.")) as { question: string };
    const moved = await send(MOVED, { ...signedForFirst, question: other });
    expect(moved.status).toBe(403);

    const plain = await aNote(lead, "lead", MOVED, "Builder, keep the pages small.");
    expect((await fetch(`${base}${notesPath(MOVED.jobId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(plain) })).status).toBe(201);
    const toNothing = await send(MOVED, await anAnswer(MOVED, plain.signature, "Yes."));
    expect(toNothing.status).toBe(404);
    expect(await why(toNothing)).toContain("no such question");
  });

  test("the lead is the pod's one voice to the poster: its questions past a few in a round, and any question straight from another seat, are notes to the pod and no answer is owed", async () => {
    const asked: Hex[] = [];
    for (let at = 0; at < MOST_QUESTIONS_A_ROUND + 1; at++) asked.push(await ask(lead, "lead", MANY, `One more thing, number ${at}?`, "Whatever is simplest."));
    // a builder that writes to the poster in the lead's form, and one that raises its question with the lead as it should
    const straight = await ask(builder, "builder", MANY, "Straight to the poster?", "Yes.");
    const raised = await aNote(builder, "builder", MANY, raisedNote("Is there a price list?", "No list: example prices."));
    expect((await fetch(`${base}${notesPath(MANY.jobId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(raised) })).status).toBe(201);

    const found = await questionsOf(MANY);
    expect(found.map((one) => one.id)).toEqual(asked.slice(0, MOST_QUESTIONS_A_ROUND));
    expect(found.every((one) => one.role === "lead")).toBe(true);
    for (const notOne of [asked.at(-1), straight, raised.signature]) {
      expect((await send(MANY, await anAnswer(MANY, notOne ?? "0x", "An answer."))).status).toBe(404);
    }
  });

  test("a job of two hours is one shot: a note written as a question is only a note", async () => {
    const note = await ask(lead, "lead", TWO_HOURS, "Which colour?", "Black on yellow.");
    expect(await questionsOf(TWO_HOURS)).toEqual([]);
    const answered = await send(TWO_HOURS, await anAnswer(TWO_HOURS, note, "Blue."));
    expect(answered.status).toBe(404);
  });

  test("after a day unanswered, the question is closed and its seat goes on with what it assumed", async () => {
    const askedAt = secondsNow() - ANSWER_WITHIN_SECONDS - 60;
    const note = await aNote(lead, "lead", STALE, questionNote("Delivery, or collection only?", "Collection only."), askedAt);
    await store.addNote(STALE.jobId, note);
    const [question] = await questionsOf(STALE);
    expect(question).toMatchObject({ id: note.signature, round: 1 });

    const late = await send(STALE, await anAnswer(STALE, note.signature, "Delivery too."));
    expect(late.status).toBe(403);
    expect(await why(late)).toContain("gone on with what it said it would assume");
    expect((await questionsOf(STALE))[0]?.answer).toBeUndefined();
  });

  test("an answer is refused when it is not one: unsigned, empty, or dated another day", async () => {
    const question = await ask(lead, "lead", NOT_ONE, "A contact form?", "No form: a phone number.");
    expect((await send(NOT_ONE, { question, says: "Yes" })).status).toBe(400);
    expect((await send(NOT_ONE, await anAnswer(NOT_ONE, question, "   "))).status).toBe(400);
    const yesterday = await send(NOT_ONE, await anAnswer(NOT_ONE, question, "Yes, a form.", POSTER, secondsNow() - 3600));
    expect(yesterday.status).toBe(400);
    expect(await why(yesterday)).toContain("not now");
  });
});
