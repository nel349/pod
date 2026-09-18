/**
 * The verdicts, on the ERC-8004 registries, one per seat.
 *
 * The money moved in our own contract. This is the leg that makes the record portable and, more to
 * the point, role-scoped: the registry is told that this agent was checked as a reviewer, or as a
 * builder, on a job whose evidence anybody can fetch. A summary filtered by that tag is a reputation
 * with a shape, rather than a number that means "generally fine".
 *
 *   POD_DEMO_ID=<job on the wall> bun run scripts/verdict-onchain.ts
 *
 * It reads the job from the store rather than from arguments, so what reaches the chain is what the
 * wall already shows. Identities are registered once and remembered in .env: registering twice would
 * quietly give one agent two records and halve both.
 */
import { createPublicClient, createWalletClient, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { appendFileSync } from "node:fs";
import {
  MONAD_TESTNET, approvePlatform, identityAbi, record as summaryOf, registerAgent,
  requestValidation, verdictOnChain, writeVerdict, type Sender,
} from "../src/registry.ts";
import { seatVerdictKey } from "../src/job.ts";
import { monadTestnet } from "../src/live.ts";
import { JobStore } from "../src/store.ts";

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; is .env loaded?`);
  return value;
};

const rpc = need("MONAD_TESTNET_RPC");
const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpc) }) as PublicClient;
const sender = (key: string): Sender => ({
  publicClient,
  wallet: createWalletClient({ account: privateKeyToAccount(key as Hex), chain: monadTestnet, transport: http(rpc) }),
});

const validatorKey = need("POD_VALIDATOR_KEY") as Hex;
const validator = privateKeyToAccount(validatorKey).address;
const site = process.env.POD_SITE ?? "http://localhost:3000";

const jobId = process.env.POD_DEMO_ID ?? "an-excuse-that-holds-up";
const store = new JobStore(need("POD_JOBS"));
const job = await store.read(jobId);
if (!job) throw new Error(`no job called ${jobId} in ${need("POD_JOBS")}`);
if (!job.signed) throw new Error(`${jobId} has no signed receipt, so there is no verdict to write`);

const verdict = job.signed.receipt.verdict;
const score = verdict === "passed" ? 100 : 0;
console.log(`${jobId}: ${verdict}, so ${score} goes to the registry for every seat\n`);

/** An identity is registered once. The id lives in .env because a second one would split the record. */
async function identityOf(role: string, key: string, address: Address): Promise<bigint> {
  const remembered = process.env[`POD_AGENT_${role.toUpperCase()}_ID`];
  if (remembered) return BigInt(remembered);

  const registered = await registerAgent(sender(key));
  appendFileSync(".env", `POD_AGENT_${role.toUpperCase()}_ID=${registered.agentId}\n`);
  console.log(`  registered agent ${registered.agentId}  ${registered.hash}`);
  return registered.agentId;
}

for (const seat of job.tile.pod) {
  const role = seat.role;
  const key = need(`POD_AGENT_${role.toUpperCase()}_KEY`);
  const address = seat.agent as Address;
  console.log(`${role}`);

  const agentId = await identityOf(role, key, address);

  const approved = await publicClient.readContract({
    address: MONAD_TESTNET.identityRegistry, abi: identityAbi, functionName: "isApprovedForAll",
    args: [address, validator],
  });
  if (!approved) console.log(`  approved the validator to act for it  ${await approvePlatform(sender(key), validator)}`);

  const key8004 = await seatVerdictKey({
    seal: job.seal, commit: job.signed.receipt.commit, runner: validator, agent: address,
  });
  // one request per job, per runner. Asking about one nobody has made reverts, which is an answer
  const already = await verdictOnChain(publicClient, key8004).catch(() => undefined);
  if (!already || already.validator === "0x0000000000000000000000000000000000000000") {
    console.log(`  requested  ${await requestValidation(sender(key), {
      runner: validator, agentId, evidenceURI: `${site}/job/${jobId}`, key: key8004,
    })}`);
  }

  const tag = `pod.${role}`;
  console.log(`  verdict ${score} under "${tag}"  ${await writeVerdict(sender(validatorKey), {
    key: key8004, score, receiptURI: `${site}/receipt/${jobId}`, receiptHash: job.signed.hash, tag,
  })}`);

  const summary = await summaryOf(publicClient, agentId, tag, [validator]);
  console.log(`  record as ${role}: ${summary.count} verdict(s), average ${summary.average}\n`);
}
