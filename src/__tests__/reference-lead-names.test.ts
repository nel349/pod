import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Model } from "../broker.ts";
import { netlify } from "../hosting/index.ts";
import { SERVE_THE_SITE, type Role, type Spec } from "../job.ts";
import { readJob, readSeats, roleNumber, seatDeposit, seatPay } from "../jobs.ts";
import { accept, readAgentRecord } from "../jobsV3.ts";
import { accountOf, earnedSeats, NAMED_BY_THE_LEAD, podJobsV4Abi, readAccount, readConcluded, readCutRecord, readEarns, seatBit } from "../jobsV4.ts";
import { noteMessage } from "../messages.ts";
import { runReferenceAgent, type Finished } from "../reference/index.ts";
import { IMAGE } from "../sandbox.ts";
import { SEATS } from "../seal.ts";
import { DUTIES, STANDARD } from "../standard.ts";
import { isCodePublic } from "../store.ts";
import { Worker } from "../worker/index.ts";
import { ANVIL_KEYS, anvilAvailable } from "./support/anvil.ts";
import { netlifySaying, type NetlifySaying } from "./support/netlify.ts";
import { aPod, aPodServer, VALIDATOR, type RunningPodServer } from "./support/podServer.ts";
import { dockerAvailable } from "./support/tools.ts";

/**
 * A website, on the contract where the lead names who is paid: a pod of reference agents builds it,
 * each judging seat binds the account it wrote to its yes, the reviewer says at the start what it will
 * look at, and the lead reads every account and concludes the review, naming two seats and keeping the
 * third from the pay. The poster accepts, and the money lands exactly so: the seat kept from the pay
 * gets its deposit home and nothing else, and what it would have been paid goes back to the poster.
 * The models are scripted, and the host is a stand-in; the contract, the doors, git and the boxes are real.
 */
const available = (await anvilAvailable()) && (await dockerAvailable());

const JOB = "pokemon-cards-named";
const POSTER = ANVIL_KEYS[1];
const HOUR = 3600n;
/** the page a builder's model answers with: one file, the whole website */
const THE_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Pokemon cards</title><style>body { font-family: sans-serif; }</style></head>
<body>
  <h1>Pokemon cards</h1>
  <article id="mewtwo"><h2>Mewtwo</h2><img src="https://example.invalid/mewtwo.png" alt="Mewtwo"><p>Psychic. 106 HP.</p><button type="button">Mint for 1 MON</button></article>
</body>
</html>`;
const pageHolds = (words: string): string => `const answer = await fetch(process.env.TARGET + "/");
const page = await answer.text();
if (!answer.ok || !page.includes(${JSON.stringify(words)})) { console.log("the front page answered " + answer.status + " without ${words}"); process.exit(1); }
console.log("the front page holds ${words}");`;
const SPEC: Spec = {
  idea: "A page of Pokemon cards, each with its picture and details and a way to mint it", kind: "site", mode: "flash", price: parseEther("1"),
  checks: [
    { says: "The front page shows the cards", run: "node check-1.mjs", hidden: false, file: "check-1.mjs" },
    { says: "Mewtwo can be minted for a price in MON", run: "node check-2.mjs", hidden: true, file: "check-2.mjs" },
  ],
  allowed: [], salt: "a-number-nobody-can-guess-for-a-website",
};

const pod = aPod();
let running: RunningPodServer | undefined;
let host: NetlifySaying | undefined;

beforeAll(async () => {
  if (!available) return;
  host = netlifySaying();
  running = await aPodServer({
    jobId: JOB, spec: SPEC, files: { "check-1.mjs": pageHolds("Pokemon cards"), "check-2.mjs": pageHolds("Mint for 1 MON") },
    fund: Object.values(pod), lastWordWithin: 4n * HOUR, leadNames: true,
  });
}, 120_000);

afterAll(() => {
  running?.stop();
  host?.stop();
});

const fenced = (code: string): string => `\`\`\`html\n${code}\n\`\`\``;
const answering = (answer: string): Model => async () => answer;

async function until(what: string, said: readonly string[], done: () => Promise<boolean>, seconds = 240): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await done()) return;
    await Bun.sleep(250);
  }
  throw new Error(`never ${what}. What was said:\n${said.join("\n")}`);
}

describe.skipIf(!available)("the seats a lead names", () => {
  test("the bit this code sends for a seat is the bit the contract reads it as", async () => {
    const pod$ = running!;
    const reading = { address: pod$.jobs, publicClient: pod$.anvil.publicClient };
    for (const role of NAMED_BY_THE_LEAD) {
      for (let index = 0; index < 5; index++) {
        const onChain = await pod$.anvil.publicClient.readContract({
          address: pod$.jobs, abi: podJobsV4Abi, functionName: "seatBit", args: [roleNumber(role), BigInt(index)],
        });
        expect(onChain, `${role} ${index + 1}`).toBe(seatBit(role, index));
      }
    }
    // and the number sent for several seats is those bits together, which is what the contract takes
    expect(earnedSeats([{ role: "reviewer", index: 0 }, { role: "security", index: 0 }]))
      .toBe(seatBit("reviewer", 0) | seatBit("security", 0));
    expect(reading.address).toBe(pod$.jobs);
  }, 60_000);
});

describe.skipIf(!available)("a website, where the lead names who is paid", () => {
  test("each seat binds its account, the lead names who earned their pay, and the poster's yes pays exactly those", async () => {
    const pod$ = running!;
    const standIn = host!;
    const reading = { address: pod$.jobs, publicClient: pod$.anvil.publicClient };
    const asked: Partial<Record<Role, string[]>> = {};
    /** a model that answers by what it is asked, and keeps every prompt it was given */
    const scripted = (role: Role, answers: readonly { readonly when: string; readonly answer: string }[]): Model => async (prompt) => {
      (asked[role] ??= []).push(prompt);
      const found = answers.find((one) => prompt.includes(one.when));
      if (!found) throw new Error(`the ${role}'s model was asked something this test has no answer for`);
      return found.answer;
    };
    const models: Partial<Record<Role, Model>> = {
      builder: answering(fenced(THE_PAGE)),
      lead: scripted("lead", [
        { when: "Reply with one line for each seat", answer: "reviewer 1: EARNED it names what it read in site/index.html\nqa 1: EARNED it says each check it ran\nsecurity 1: KEPT it says the page is safe and names nothing it looked at" },
        { when: "You are the lead", answer: "APPROVE the front page shows the cards, and each can be minted for a price in MON\nThe cards: site/index.html. Minting: the button on each card." },
      ]),
      reviewer: scripted("reviewer", [
        { when: "Say what you will look at on this job", answer: "How the page of cards holds together, and whether minting is real." },
        { when: "the second pair of eyes", answer: "APPROVE it is a page of cards\nRead site/index.html: one card, Mewtwo, with its picture, details and a mint button." },
      ]),
      security: scripted("security", [{ when: "You are the security seat", answer: "APPROVE it is safe" }]),
    };
    const said: string[] = [];
    const outOfTime = AbortSignal.timeout(400_000);
    const seated = (role: Role): Promise<Finished> => runReferenceAgent({
      server: pod$.base, key: pod[role].key, role, model: models[role], image: IMAGE, every: 250, signal: outOfTime,
      say: (what) => said.push(what),
    });
    // the seats that judge sit down while the work is still to be built: once it is put forward and
    // everybody seated stands behind it, no seat is taken any more
    const judges = SEATS.filter((role) => role !== "builder").map(seated);
    await until("the judging seats being taken", said, async () => (await readSeats(reading, pod$.onChainId)).length === SEATS.length - 1);
    const agents: Promise<Finished>[] = [...judges, seated("builder")];

    const stop = new AbortController();
    const worker = new Worker({
      store: pod$.store, repositories: pod$.repositories, image: IMAGE, runnerKey: VALIDATOR, times: 2,
      jobs: { address: pod$.earlierJobs, publicClient: pod$.anvil.publicClient, wallet: pod$.anvil.wallet(VALIDATOR) },
      prepared: { ...reading, wallet: pod$.anvil.wallet(VALIDATOR) }, hasTheLastWord: true, leadNamesWhoIsPaid: true,
      token: { address: pod$.token, publicClient: pod$.anvil.publicClient, wallet: pod$.anvil.wallet(VALIDATOR) },
      siteHost: netlify({ token: "the-token", endpoint: standIn.endpoint }),
      say: (what) => said.push(what),
    });
    const working = worker.run(stop.signal, 250);
    try {
      // every seat is done once the work is delivered: nothing more is theirs to do while the poster decides
      const finished = await Promise.all(agents);
      for (const done of finished) expect(done.why).toBe("the job is delivered, and waits for its poster's answer");
      expect((await readJob(reading, pod$.onChainId)).state).toBe("delivered");
      // the lead spoke last: it concluded the review, which is its yes, and nobody's yes came after it
      expect(await readConcluded(reading, pod$.onChainId)).toBe(true);
      expect(said.some((line) => line.startsWith("[lead] concluded the review of "))).toBe(true);
      expect(said.some((line) => line.startsWith("[reviewer] said what it will look at on this job: ")), said.filter((line) => line.startsWith("[reviewer]")).join("\n")).toBe(true);
      expect((await readSeats(reading, pod$.onChainId)).every((seat) => seat.approved)).toBe(true);
      // what the lead named, as the contract has it: the reviewer and QA earned their pay, security did not
      expect(await readEarns(reading, pod$.onChainId, "reviewer", 0)).toBe(true);
      expect(await readEarns(reading, pod$.onChainId, "qa", 0)).toBe(true);
      expect(await readEarns(reading, pod$.onChainId, "security", 0)).toBe(false);
      expect(await readEarns(reading, pod$.onChainId, "builder", 0)).toBe(true);

      // every account bound on the contract is the fingerprint of a note that seat published about this commit
      const notes = await pod$.store.notes(JOB);
      const commit = (await pod$.store.read(JOB))?.signed?.receipt.commit;
      for (const role of ["lead", "reviewer", "qa", "security"] as const) {
        const bound = await readAccount(reading, pod$.onChainId, role, 0);
        const published = notes.filter((note) => note.role === role && note.about === commit)
          .map((note) => accountOf(noteMessage({ jobId: JOB, onChainId: String(pod$.onChainId), jobs: pod$.jobs, role, about: note.about, says: note.says, at: note.at })));
        expect(bound).toBeString();
        expect(published).toContain(bound!);
      }
      // every seat that thinks with a model was given the standard, word for word from the one place it is written
      for (const role of ["lead", "reviewer", "security"] as const) {
        for (const sentence of STANDARD) expect(asked[role]?.some((prompt) => prompt.includes(sentence)), `${role}: ${sentence.slice(0, 40)}`).toBe(true);
        expect(asked[role]?.some((prompt) => prompt.includes(DUTIES[role]))).toBe(true);
      }
      // the reviewer was shown what the other seats said, and the lead what each seat's account was and what its seat is for
      // and what QA sent it is an account with evidence in it: the command it ran and what the check printed
      expect(asked.reviewer?.some((prompt) => prompt.includes("### The qa seat says") && /ran: node check-1\.mjs, [0-9.]+s, exit 0 \(passed\)/.test(prompt) && prompt.includes("it printed:"))).toBe(true);
      expect(asked.lead?.some((prompt) => prompt.includes("## security 1") && prompt.includes("APPROVE it is safe") === false && prompt.includes("Approved: it is safe"))).toBe(true);
      // QA's account says what it ran, and what it did not do
      expect(notes.some((note) => note.role === "qa" && note.says.includes('- "The front page shows the cards"')
        && /ran: node check-1\.mjs, [0-9.]+s, exit 0 \(passed\)/.test(note.says) && note.says.includes("it printed:")
        && note.says.includes("Not done by this seat"))).toBe(true);

      await until("the website going live", said, async () => (await pod$.store.read(JOB))?.live !== undefined);
      const delivered = await pod$.store.read(JOB);
      expect(delivered?.signed?.receipt.verdict).toBe("passed");
      // the builder wrote the website's front page where a website is, our server served it to the checks, and that file is what is live
      expect(delivered?.signed?.receipt.start).toBe(SERVE_THE_SITE);
      expect(Object.fromEntries(standIn.files)).toEqual({ "/index.html": `${THE_PAGE}\n` });
      expect(await pod$.git(["show", `${delivered?.signed?.receipt.commit}:site/index.html`])).toBe(`${THE_PAGE}\n`);
      // nobody is paid yet, and the code is the pod's
      expect(delivered && isCodePublic(delivered)).toBe(false);
      expect((await fetch(`${pod$.base}/bundle/${JOB}`)).status).toBe(404);

      const before = Object.fromEntries(await Promise.all((["lead", "reviewer", "security"] as const).map(async (role) =>
        [role, await pod$.anvil.publicClient.getBalance({ address: pod[role].address })] as const)));
      const poster = privateKeyToAccount(POSTER).address;
      const posterBefore = await pod$.anvil.publicClient.getBalance({ address: poster });
      const accepting = await accept({ ...reading, wallet: pod$.anvil.wallet(POSTER) }, pod$.onChainId);
      const paidFor = async (role: Role): Promise<bigint> => (await pod$.anvil.publicClient.getBalance({ address: pod[role].address })) - before[role]!;
      const pay = (role: Role): Promise<bigint> => seatPay(reading, pod$.onChainId, role);
      const deposit = (role: Role): Promise<bigint> => seatDeposit(reading, pod$.onChainId, role);
      expect(await paidFor("lead")).toBe((await pay("lead")) + (await deposit("lead")));
      expect(await paidFor("reviewer")).toBe((await pay("reviewer")) + (await deposit("reviewer")));
      // kept from the pay: its deposit home, and nothing else
      expect(await paidFor("security")).toBe(await deposit("security"));
      // and what it would have been paid went back to whoever posted the job, less the gas of their own yes
      const receipt = await pod$.anvil.publicClient.getTransactionReceipt({ hash: accepting });
      expect((await pod$.anvil.publicClient.getBalance({ address: poster })) - posterBefore + receipt.gasUsed * receipt.effectiveGasPrice).toBe(await pay("security"));
      expect(await readCutRecord(reading, pod.security.address)).toEqual({ withheld: 1, withholdings: 0 });
      expect(await readCutRecord(reading, pod.lead.address)).toEqual({ withheld: 0, withholdings: 1 });

      await until("the title being minted", said, async () => (await pod$.store.read(JOB))?.chain?.tokenId !== undefined);
      const accepted = await pod$.store.read(JOB);
      expect(accepted?.chain?.answer?.how).toBe("accepted");
      expect(accepted?.live?.removedAt).toBeUndefined();
      expect(standIn.removed).toEqual([]);
      // paid for, the code opens to anybody
      expect(accepted && isCodePublic(accepted)).toBe(true);
      expect((await fetch(`${pod$.base}/bundle/${JOB}`)).status).toBe(200);
      // it stood behind the work, so the job is counted for it, kept from the pay or not
      expect(await readAgentRecord(reading, pod.security.address)).toEqual({ accepted: 1, paidUnanswered: 0, refusedPassed: 0, failed: 0, undelivered: 0 });
      // the job's own record says who was kept from the pay, and holds each seat's account
      const kept = accepted?.approvals.filter((approval) => approval.isKeptFromPay).map((approval) => approval.role);
      expect(kept).toEqual(["security"]);
      expect(accepted?.approvals.filter((approval) => approval.role !== "builder").every((approval) => approval.account !== undefined)).toBe(true);
    } finally {
      stop.abort();
      await working;
    }
  }, 480_000);
});
