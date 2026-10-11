import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Model } from "../broker.ts";
import { netlify } from "../hosting/index.ts";
import { SERVE_THE_SITE, type Role, type Spec } from "../job.ts";
import { readJob, readSeats, seatDeposit, seatPay } from "../jobs.ts";
import { accept, readAgentRecord, readPosterRecord } from "../jobsV3.ts";
import { runReferenceAgent, type Finished } from "../reference/index.ts";
import { IMAGE } from "../sandbox.ts";
import { SEATS } from "../seal.ts";
import { isCodePublic } from "../store.ts";
import { Worker } from "../worker/index.ts";
import { ANVIL_KEYS, anvilAvailable } from "./support/anvil.ts";
import { netlifySaying, type NetlifySaying } from "./support/netlify.ts";
import { aPod, aPodServer, VALIDATOR, type RunningPodServer } from "./support/podServer.ts";
import { dockerAvailable } from "./support/tools.ts";

/**
 * A website, from a posted job to its poster's yes: a pod of reference agents builds it through the
 * public doors, the worker serves its files to its checks and reports what they found, it goes live
 * at an address of its own, and its poster accepts it with their own key. The builder puts its own work
 * forward, and the lead judges it beside the other seats. The builder's model and the three reading
 * seats' are scripted, and the host is a stand-in that answers as Netlify's guide says
 * Netlify does; everything else is real: the contract on a local chain, the doors, git, the boxes.
 */
const available = (await anvilAvailable()) && (await dockerAvailable());

const JOB = "pokemon-cards";
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
    fund: Object.values(pod), lastWordWithin: 4n * HOUR,
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

describe.skipIf(!available)("a website, from a posted job to its poster's yes", () => {
  test("a pod builds it, its files are checked as they are served, it goes live, and its poster's own yes pays the pod", async () => {
    const pod$ = running!;
    const standIn = host!;
    const reading = { address: pod$.jobs, publicClient: pod$.anvil.publicClient };
    const models: Partial<Record<Role, Model>> = {
      builder: answering(fenced(THE_PAGE)),
      lead: answering("APPROVE the front page shows the cards, and each can be minted for a price in MON"),
      reviewer: answering("APPROVE it is a page of cards, with a picture, details and a way to mint each"),
      security: answering("APPROVE the page sends nothing anywhere and asks a visitor's wallet for nothing"),
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
      prepared: { ...reading, wallet: pod$.anvil.wallet(VALIDATOR) }, hasTheLastWord: true,
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
      // the builder named its own work, the lead judged it like any other seat, and the whole pod stood behind it
      expect(said.some((line) => /^\[builder\] put [0-9a-f]+ forward to be reviewed and graded$/.test(line))).toBe(true);
      expect(said.some((line) => line.startsWith("[lead] approved "))).toBe(true);
      expect((await readSeats(reading, pod$.onChainId)).every((seat) => seat.approved)).toBe(true);

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

      const leadBefore = await pod$.anvil.publicClient.getBalance({ address: pod.lead.address });
      await accept({ ...reading, wallet: pod$.anvil.wallet(POSTER) }, pod$.onChainId);
      expect(await pod$.anvil.publicClient.getBalance({ address: pod.lead.address }))
        .toBe(leadBefore + (await seatPay(reading, pod$.onChainId, "lead")) + (await seatDeposit(reading, pod$.onChainId, "lead")));

      await until("the title being minted", said, async () => (await pod$.store.read(JOB))?.chain?.tokenId !== undefined);
      const accepted = await pod$.store.read(JOB);
      expect(accepted?.chain?.answer?.how).toBe("accepted");
      expect(accepted?.live?.removedAt).toBeUndefined();
      expect(standIn.removed).toEqual([]);
      // paid for, the code opens to anybody
      expect(accepted && isCodePublic(accepted)).toBe(true);
      expect((await fetch(`${pod$.base}/bundle/${JOB}`)).status).toBe(200);
      expect(await readPosterRecord(reading, privateKeyToAccount(POSTER).address)).toEqual({ posted: 1, accepted: 1, refusedPassed: 0, refusedFailed: 0, unanswered: 0 });
      expect(await readAgentRecord(reading, pod.builder.address)).toEqual({ accepted: 1, paidUnanswered: 0, refusedPassed: 0, failed: 0, undelivered: 0 });
    } finally {
      stop.abort();
      await working;
    }
  }, 480_000);
});
