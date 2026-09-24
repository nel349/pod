import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Model } from "../broker.ts";
import { CheckWriting, ProvenChecks } from "../checkwriting/index.ts";
import { agentEmail, branchFor, doorChainFor, Doorkeeper, GitDoor, JobList, NoteBoard } from "../door/index.ts";
import { sealSpec, type Role, type Spec } from "../job.ts";
import { policyMet, post, readJob, readSeats, readTerms } from "../jobs.ts";
import { openJob } from "../publish.ts";
import { APPROVED, REFUSED, runReferenceAgent, type Finished } from "../reference/index.ts";
import { bytes32ToCommit, commitToBytes32 } from "../repo.ts";
import { IMAGE } from "../sandbox.ts";
import { serve } from "../server.ts";
import { JobStore } from "../store.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { COAT_IDEA, dockerAvailable, good, GOOD_REPLY, replying, serverSaying, WET, DRY, WORKING, writerWith } from "./support/coat.ts";

/**
 * A whole pod of reference agents, through the public doors only, against a real chain.
 *
 * Five keys, five agents, one freshly posted job. Nobody tells them what to do: each finds the job
 * in the list, takes its seat on the contract, and works until the contract says every approval the
 * policy asks for is on one commit. The builder's model gets it wrong the first time, on purpose, so
 * what is shown is the loop and not only a pass: QA runs the visible check for real, refuses, says
 * why in a note, and the builder answers it.
 *
 * The models are scripted, because what is under test is the agents and the doors, not Claude. QA
 * uses no model at all; it runs the checks in the same sealed box a verdict does.
 */

const available = (await anvilAvailable()) && (await dockerAvailable());

let anvil: Anvil;
let jobs: Address;
let store: JobStore;
let repositories: string;
let base = "";
let server: { stop: () => void } | undefined;

const POSTER = ANVIL_KEYS[1];
const PRICE = parseEther("1");
const JOB = "a-coat-given-the-rain";

/** Never says take a coat: what the builder's model writes the first time */
const NEVER_A_COAT = serverSaying("false", "false");

const SPEC: Spec = {
  idea: COAT_IDEA, kind: "service", mode: "flash", price: PRICE,
  checks: [
    { says: WET, run: "node check-1.mjs", hidden: false, file: "check-1.mjs" },
    { says: DRY, run: "node check-2.mjs", hidden: true, file: "check-2.mjs" },
  ],
  allowed: [], salt: "a-number-nobody-can-guess",
};

interface Agent {
  readonly key: Hex;
  readonly address: Address;
}

function anAgent(): Agent {
  const key = generatePrivateKey();
  return { key, address: privateKeyToAccount(key).address };
}

const pod: Readonly<Record<Role, Agent>> = {
  lead: anAgent(), builder: anAgent(), reviewer: anAgent(), qa: anAgent(), security: anAgent(),
};

/** A model that answers in turn, repeating its last answer, and keeps what it was asked. */
function scripted(...answers: readonly string[]): { readonly model: Model; readonly prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    model: async (prompt) => {
      prompts.push(prompt);
      return answers[Math.min(prompts.length, answers.length) - 1]!;
    },
  };
}

const fenced = (code: string): string => `\`\`\`js\n${code}\n\`\`\``;

const reading = () => ({ address: jobs, publicClient: anvil.publicClient });

beforeAll(async () => {
  if (!available) return;
  anvil = await startAnvil();
  jobs = await anvil.deploy("PodJobs", [privateKeyToAccount(ANVIL_KEYS[6]).address]);
  const payer = anvil.wallet(ANVIL_KEYS[0]);
  for (const agent of Object.values(pod)) {
    await anvil.publicClient.waitForTransactionReceipt({
      hash: await payer.sendTransaction({ to: agent.address, value: parseEther("10"), account: payer.account!, chain: payer.chain }),
    });
  }

  store = new JobStore(await mkdtemp(join(tmpdir(), "pod-reference-jobs-")));
  repositories = await mkdtemp(join(tmpdir(), "pod-reference-repositories-"));

  // the job, as the posting page leaves one: on the contract, on the wall, its checks and spec kept
  const now = (await anvil.publicClient.getBlock()).timestamp;
  const seal = await sealSpec(SPEC);
  const poster = { address: jobs, publicClient: anvil.publicClient, wallet: anvil.wallet(POSTER) };
  const onChainId = await post(poster, { seal, endsAt: now + 3600n, reviewers: 1, price: PRICE });
  const opened = await openJob(store, { jobId: JOB, seal, spec: SPEC, endsAt: new Date(Number(now + 3600n) * 1000), seats: [] });
  await store.save({ ...opened, chain: { network: "monad-testnet", jobId: String(onChainId), jobs } }, {
    "check-1.mjs": good(0).check, "check-2.mjs": good(1).check,
  });
  await store.saveSpec(JOB, SPEC);

  const keeper = new Doorkeeper({
    store,
    chain: doorChainFor({
      jobs,
      readJob: (id) => readJob(reading(), id),
      readSeats: (id) => readSeats(reading(), id),
      readTerms: (id) => readTerms(reading(), id),
      latestBlockTime: async () => (await anvil.publicClient.getBlock()).timestamp,
    }),
  });
  const proven = new ProvenChecks(await mkdtemp(join(tmpdir(), "pod-reference-proven-")));
  const serving = serve(store, 0, {
    // the market is here for what the agents read first: which chain, which contract
    market: {
      page: { chainId: 31337, chainName: "a local chain", rpc: anvil.rpc, jobs, explorer: "http://explorer.invalid", coin: "ETH" },
      chain: { jobs, job: async () => undefined },
      writing: new CheckWriting({ writer: writerWith(replying(GOOD_REPLY).model), proven }),
      proven,
    },
    door: new GitDoor({ repositories, keeper }),
    notes: new NoteBoard({ keeper, store }),
    jobList: new JobList({ keeper, store }),
  });
  server = serving;
  base = `http://127.0.0.1:${serving.port}`;
}, 120_000);

afterAll(() => {
  server?.stop();
  anvil?.stop();
});

async function gitOnTheServer(args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "--git-dir", join(repositories, `${JOB}.git`), ...args], {
    stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(child.stderr).text()}`);
  return out;
}

describe.skipIf(!available)("a pod of reference agents", () => {
  test("five agents with five keys take the seats, get it wrong, are told why, fix it, and meet the policy on one commit", async () => {
    const builder = scripted(fenced(NEVER_A_COAT), fenced(WORKING));
    const reviewer = scripted("APPROVE it answers whether to take a coat, from whether it is raining");
    const security = scripted("APPROVE it reaches no network, reads nothing outside itself and starts nothing");
    const models: Partial<Record<Role, Model>> = { builder: builder.model, reviewer: reviewer.model, security: security.model };

    const said: string[] = [];
    const stop = new AbortController();
    const running: Promise<Finished>[] = (Object.entries(pod) as [Role, Agent][]).map(([role, agent]) => runReferenceAgent({
      server: base, key: agent.key, role, model: models[role], image: IMAGE, every: 250, signal: stop.signal,
      say: (what) => said.push(what),
    }));

    // what the test waits for is the contract's own word, not anything an agent says
    const onChainId = BigInt((await store.read(JOB))!.chain!.jobId);
    let candidate: string | undefined;
    const deadline = Date.now() + 240_000;
    try {
      while (Date.now() < deadline) {
        const job = await readJob(reading(), onChainId);
        if (!/^0x0{64}$/i.test(job.commit) && (await policyMet(reading(), onChainId, job.commit))) {
          candidate = bytes32ToCommit(job.commit);
          break;
        }
        await Bun.sleep(500);
      }
    } finally {
      stop.abort();
      await Promise.all(running);
    }
    if (!candidate) throw new Error(`the policy was never met. What the agents said:\n${said.join("\n")}`);

    // what they agreed on is the work that answers the brief, from the builder's second try
    expect(await gitOnTheServer(["show", `${candidate}:server.js`])).toBe(`${WORKING}\n`);
    expect(await policyMet(reading(), onChainId, commitToBytes32(candidate))).toBe(true);

    // every seat is held by its own key, and each owner once
    const seats = await readSeats(reading(), onChainId);
    for (const [role, agent] of Object.entries(pod) as [Role, Agent][]) {
      expect(seats.find((seat) => seat.role === role)?.agent).toBe(agent.address);
    }

    // QA ran the visible check against the first try and said why it failed; the builder read it
    const notes = await store.notes(JOB);
    const refusal = notes.find((note) => note.role === "qa" && note.says.startsWith(REFUSED));
    expect(refusal?.says).toContain(WET);
    expect(builder.prompts).toHaveLength(2);
    expect(builder.prompts[1]).toContain("qa: ");
    expect(builder.prompts[1]).toContain(WET);
    for (const role of ["reviewer", "qa", "security"] as const) {
      expect(notes.some((note) => note.role === role && note.about === candidate && note.says.startsWith(APPROVED))).toBe(true);
    }

    // and every commit in the job's repository was written by a seat of this pod
    const seatEmails = Object.values(pod).map((agent) => agentEmail(agent.address));
    const authors = (await gitOnTheServer(["log", "--all", "--format=%ae"])).trim().split("\n");
    expect(authors.length).toBeGreaterThanOrEqual(2);
    for (const author of authors) expect(seatEmails).toContain(author);
    expect((await gitOnTheServer(["branch", "--list"])).split("\n").map((line) => line.trim()).filter(Boolean).sort())
      .toEqual([branchFor("builder", pod.builder.address), branchFor("lead", pod.lead.address)].sort());
  }, 300_000);
});
