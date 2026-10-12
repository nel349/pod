import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Model } from "../broker.ts";
import type { Role, Spec } from "../job.ts";
import { readJob } from "../jobs.ts";
import { answerMessage } from "../messages.ts";
import { runReferenceAgent, type Finished } from "../reference/index.ts";
import { questionsIn } from "../reference/roles/Asking.ts";
import { questionsPath } from "../routes.ts";
import { IMAGE } from "../sandbox.ts";
import { MOST_QUESTIONS_A_ROUND, type Question } from "../triage.ts";
import { ANVIL_KEYS, anvilAvailable } from "./support/anvil.ts";
import { aPod, aPodServer, type RunningPodServer } from "./support/podServer.ts";

/**
 * A week's job, where a pod may ask before it builds: every seat with a model reads the brief and may
 * ask its poster, each shown what the others asked; the builder holds its first build while a question
 * waits, the poster answers with the wallet that paid, and the builder then builds from the answers. The two models are scripted; the contract on a
 * local chain, the doors, the signatures and git are real.
 */

const available = await anvilAvailable();

const JOB = "a-bakery-shop";
const POSTER = ANVIL_KEYS[1];
const HOURS_IN_A_WEEK = 7 * 24;
const SPEC: Spec = {
  idea: "A shop for a bakery, with its bread and a way to buy it", kind: "site", mode: "project", price: parseEther("1"),
  checks: [{ says: "The front page lists the bread", run: "node check-1.mjs", hidden: false, file: "check-1.mjs" }],
  allowed: [], salt: "a-number-nobody-can-guess-for-a-bakery",
};
const THE_PAGE = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Bakery</title></head><body><h1>Bread</h1><p>Pay at the counter.</p></body></html>`;
const ASKS = "Should the shop take payment online, or only show the bread?";
const ASSUMES = "It only shows the bread with prices, and says to pay at the counter.";
const ANSWER = "Only show it. People pay at the counter.";
const BUILDER_ASKS = "Is there a list of the bread and its prices to use?";
const BUILDER_ASSUMES = "No list: six common breads with example prices, marked as examples on the page.";
const BUILDER_ANSWER = "Use sourdough at 6, rye at 5 and baguette at 3.";

const pod = aPod();
let running: RunningPodServer | undefined;

beforeAll(async () => {
  if (!available) return;
  running = await aPodServer({ jobId: JOB, spec: SPEC, files: { "check-1.mjs": "process.exit(0)" }, fund: Object.values(pod), hours: HOURS_IN_A_WEEK, lastWordWithin: 3600n });
}, 120_000);

afterAll(() => running?.stop());

async function until(what: string, said: readonly string[], done: () => Promise<boolean>, seconds = 120): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await done()) return;
    await Bun.sleep(250);
  }
  throw new Error(`never ${what}. What was said:\n${said.join("\n")}`);
}

describe("the questions in a model's answer", () => {
  test("a list of them is read, a few at most, and anything else is no question at all", () => {
    expect(questionsIn(`Here you go:\n[{"asks": "Online payment?", "assumes": "No."}]`)).toEqual([{ asks: "Online payment?", assumes: "No." }]);
    expect(questionsIn("[]")).toEqual([]);
    expect(questionsIn("Nothing to ask.")).toEqual([]);
    expect(questionsIn(`[{"asks": "With no fallback?"}]`)).toEqual([]);
    expect(questionsIn("[not json]")).toEqual([]);
    const many = JSON.stringify(Array.from({ length: MOST_QUESTIONS_A_ROUND + 2 }, (_one, index) => ({ asks: `Question ${index}?`, assumes: "The simplest." })));
    expect(questionsIn(many)).toHaveLength(MOST_QUESTIONS_A_ROUND);
  });
});

describe.skipIf(!available)("a week's job, where the pod asks before it builds", () => {
  test("every seat asks the poster from where it sits, the builder waits for the answers, and builds from them once they are given", async () => {
    const pod$ = running!;
    const said: string[] = [];
    const builderRead: string[] = [];
    const builderAsked: string[] = [];
    const models: Partial<Record<Role, Model>> = {
      // the lead's model is asked twice over a job: what to ask, and later whether the work answers the brief
      lead: async (prompt) => (prompt.includes("Reply with a JSON list") ? JSON.stringify([{ asks: ASKS, assumes: ASSUMES }]) : "APPROVE it lists the bread"),
      // the builder asks too, from its own seat, and is shown what the lead already asked
      builder: async (prompt) => {
        if (prompt.includes("Reply with a JSON list")) {
          builderAsked.push(prompt);
          return JSON.stringify([{ asks: BUILDER_ASKS, assumes: BUILDER_ASSUMES }]);
        }
        builderRead.push(prompt);
        return `\`\`\`html\n${THE_PAGE}\n\`\`\``;
      },
    };
    const stop = new AbortController();
    const outOfTime = AbortSignal.any([stop.signal, AbortSignal.timeout(240_000)]);
    const seated = (role: Role): Promise<Finished> => runReferenceAgent({
      server: pod$.base, key: pod[role].key, role, model: models[role], image: IMAGE, every: 250, signal: outOfTime, askingGraceSeconds: 0,
      say: (what) => said.push(what),
    });
    const questions = async (): Promise<readonly Question[]> =>
      ((await (await fetch(`${pod$.base}${questionsPath(JOB)}`)).json()) as { questions: Question[] }).questions;

    const lead = seated("lead");
    await until("the lead asking its question", said, async () => (await questions()).length > 0);
    const [question] = await questions();
    expect(question).toMatchObject({ role: "lead", asks: ASKS, assumes: ASSUMES, round: 1 });
    expect(said).toContain("[lead] asked the poster a question before the work starts");

    // the builder sits down with a question waiting: it asks its own, from its own seat, and writes nothing
    const builder = seated("builder");
    await until("the builder saying it waits", said, async () => said.some((line) => line.startsWith("[builder] not building yet: waiting on 2 questions the pod asked the poster")));
    await Bun.sleep(1500);
    expect(builderRead, "its model is not asked to build anything while questions wait").toHaveLength(0);
    expect(builderAsked[0], "it is shown what was already asked, so the poster is not asked twice").toContain(`- lead: ${ASKS}`);
    expect(builderAsked[0]).toContain("which contract, service, account or data to use");
    const builders = (await questions()).find((one) => one.role === "builder");
    expect(builders).toMatchObject({ asks: BUILDER_ASKS, assumes: BUILDER_ASSUMES });

    // the poster answers each, with the wallet that paid for the job
    const poster = privateKeyToAccount(POSTER);
    const answer = async (to: string, says: string): Promise<number> => {
      const at = Math.floor(Date.now() / 1000);
      const signature = await poster.signMessage({ message: answerMessage({ jobId: JOB, onChainId: String(pod$.onChainId), jobs: pod$.jobs, question: to, says, at }) });
      return (await fetch(`${pod$.base}${questionsPath(JOB)}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: to, says, at, poster: poster.address, signature }),
      })).status;
    };
    expect(await answer(question!.id, ANSWER)).toBe(201);
    await Bun.sleep(1500);
    expect(builderRead, "one answer of two is not enough to start on").toHaveLength(0);
    expect(await answer(builders!.id, BUILDER_ANSWER)).toBe(201);

    await until("the builder putting its work forward", said, async () => said.some((line) => /^\[builder\] put [0-9a-f]+ forward/.test(line)));
    expect(builderRead[0]).toContain(`Asked: ${ASKS}\nThe poster answered: ${ANSWER}`);
    expect(builderRead[0]).toContain(`Asked: ${BUILDER_ASKS}\nThe poster answered: ${BUILDER_ANSWER}`);
    expect(builderRead[0]).toContain("Hold the work to their answers as to their first words");
    expect((await readJob(pod$.reading, pod$.onChainId)).state).toBe("working");
    // each seat asked once: looking again, and again, asks nothing more
    expect(await questions()).toHaveLength(2);

    stop.abort();
    await Promise.all([lead, builder]);
  }, 300_000);
});
