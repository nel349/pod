/**
 * One job, all the way through, on Monad testnet.
 *
 * Nothing here is a special path: it calls the same functions the runner calls. What it adds is the
 * cast of characters a real job has — a person who pays, five agents owned by five different people,
 * and a validator nobody else can impersonate — and it uses the keys in .env for all of them.
 *
 *   bun run scripts/demo-job.ts
 *
 * It prints every transaction hash, and writes the job into POD_JOBS so the wall can show it.
 */
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { approve, post, readJob, seatDeposit, settle, takeSeat, type Contract } from "../src/jobs.ts";
import { gradeJob } from "../src/pipeline.ts";
import { openJob, publish } from "../src/publish.ts";
import { JobStore } from "../src/store.ts";
import { mintPod, tokenOfJob } from "../src/token.ts";
import { live, monadTestnet } from "../src/live.ts";
import { sealSpec, type Role, type Spec } from "../src/job.ts";
import type { CheckToRun } from "../src/blackbox.ts";

const IMAGE = "node@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944";
const CHECKS = new URL("../fixtures/checks", import.meta.url).pathname;
const PRICE = parseEther("0.1");

/**
 * Which job this run is.
 *
 * The same script runs the job that passes and the job that does not, because they are the same
 * job: the only difference is what the pod shipped. A wall with one of each on it is evidence; a
 * wall with only the first is a shop window.
 */
const artefact = new URL(`../fixtures/${process.env.POD_DEMO_ARTEFACT ?? "app-honest"}`, import.meta.url).pathname;

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; is .env loaded?`);
  return value;
};

const spec: Spec = {
  idea: process.env.POD_DEMO_IDEA ?? "A page that scores an excuse, and scores a thin one lower than a real one",
  mode: "flash",
  price: PRICE,
  checks: [
    { says: "the page answers", run: "node loads.mjs", hidden: false },
    { says: "a weak excuse scores lower than a strong one", run: "node weak.mjs", hidden: true },
  ],
  allowed: [],
  salt: process.env.POD_DEMO_SALT ?? need("POD_DEMO_SALT"),
};

const toRun: CheckToRun[] = spec.checks.map((check) => ({
  says: check.says, command: check.run, hidden: check.hidden,
}));

const rpc = need("MONAD_TESTNET_RPC");
const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpc) }) as PublicClient;

const as = (key: string, address: Address): Contract => ({
  address,
  publicClient,
  wallet: createWalletClient({ account: privateKeyToAccount(key as Hex), chain: monadTestnet, transport: http(rpc) }),
});

const contracts = live();
const jobsAt = contracts.jobs.address;
const poster = as(need("POD_DEPLOYER_KEY"), jobsAt);
const seats: readonly { readonly role: Role; readonly key: string; readonly address: Address }[] = [
  { role: "lead", key: need("POD_AGENT_LEAD_KEY"), address: need("POD_AGENT_LEAD_ADDRESS") as Address },
  { role: "builder", key: need("POD_AGENT_BUILDER_KEY"), address: need("POD_AGENT_BUILDER_ADDRESS") as Address },
  { role: "reviewer", key: need("POD_AGENT_REVIEWER_KEY"), address: need("POD_AGENT_REVIEWER_ADDRESS") as Address },
  { role: "qa", key: need("POD_AGENT_QA_KEY"), address: need("POD_AGENT_QA_ADDRESS") as Address },
  { role: "security", key: need("POD_AGENT_SECURITY_KEY"), address: need("POD_AGENT_SECURITY_ADDRESS") as Address },
];

const store = new JobStore(need("POD_JOBS"));
const site = process.env.POD_SITE ?? "http://localhost:3000";
const jobId = process.env.POD_DEMO_ID ?? "an-excuse-that-holds-up";

// 1. the idea is sealed before it opens, so nobody can claim they built it first
const seal = await sealSpec(spec);
console.log(`seal ${seal}`);

const now = (await publicClient.getBlock()).timestamp;
const onChainId = await post(poster, { seal, endsAt: now + 7200n, reviewers: 1, price: PRICE });
console.log(`posted   job ${onChainId} for ${PRICE} wei`);

// 2. the wall shows it as open while the pod works
await openJob(store, {
  jobId, seal, spec,
  endsAt: new Date(Number(now + 7200n) * 1000),
  seats: seats.map((seat) => ({ role: seat.role })),
});

// 3. five seats, five owners, each putting down a deposit
for (const seat of seats) {
  const at = as(seat.key, jobsAt);
  const deposit = await seatDeposit({ address: jobsAt, publicClient }, onChainId, seat.role);
  const hash = await takeSeat(at, onChainId, seat.role, seat.address);
  console.log(`seat     ${seat.role.padEnd(8)} ${seat.address} deposit ${deposit} wei  ${hash}`);
}

// 4. the work is graded in the sealed box, twice, before anybody approves anything
const commit = process.env.POD_DEMO_COMMIT ?? "d15d0cb";
const report = await gradeJob({
  seal, commit, artefact, start: "node server.js",
  checks: CHECKS, toRun, image: IMAGE, times: 2,
  runner: contracts.validator, runnerKey: need("POD_VALIDATOR_KEY") as Hex,
});
console.log(`graded   ${report.verdict.kind}, score ${report.score}, tag ${report.tag}`);

// 5. the seats that carry liability approve the exact commit
const commitHash = `0x${commit.padEnd(64, "0")}` as Hex;
for (const seat of seats.filter((s) => s.role !== "builder")) {
  const hash = await approve(as(seat.key, jobsAt), onChainId, seat.role, commitHash);
  console.log(`approved ${seat.role.padEnd(8)} ${hash}`);
}

// 6. the verdict reaches the money, and only the validator can carry it
const settled = await settle(contracts.jobs, onChainId, commitHash, report.verdict.kind === "passed");
console.log(`settled  ${settled}`);

// 7. the evidence is published before the title is minted
const record = await publish(store, {
  jobId, seal, idea: spec.idea, mode: spec.mode, price: PRICE, report,
  pod: seats.map((seat) => ({ role: seat.role, agent: seat.address, owner: seat.address })),
  checksDirectory: CHECKS,
  approvals: seats.filter((s) => s.role !== "builder").map((seat) => ({
    role: seat.role, agent: seat.address, commit, at: report.signed.receipt.finishedAt,
  })),
  open: report.verdict.kind === "passed" ? `${site}/job/${jobId}` : undefined,
});

// a title is minted for work that passed, and for nothing else
if (report.verdict.kind === "passed") {
  const minted = await mintPod(contracts.token, {
    jobs: contracts.jobs, jobId: onChainId, seal, commit: commitHash,
    receiptHash: record.signed!.hash, crew: seats.map((s) => ({ role: s.role, agent: s.address })),
    uri: `${site}/job/${jobId}`,
  });
  const tokenId = await tokenOfJob({ address: contracts.token.address, publicClient }, onChainId);
  console.log(`minted   POD #${tokenId} to the person who paid  ${minted}`);
} else {
  console.log(`no title: the checks said ${report.verdict.kind}, so the money went back to the poster`);
}

const after = await readJob({ address: jobsAt, publicClient }, onChainId);
console.log(`\njob ${onChainId} is ${after.state}. The wall has it at ${site}/job/${jobId}`);
