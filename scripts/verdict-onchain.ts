/**
 * The verdict, on the ERC-8004 Validation Registry.
 *
 * This is the leg that makes the record portable: the money moved in our own contract, but the fact
 * that an independent runner checked this agent's work, under this role, is written where anybody
 * else's system can read it and nobody has to trust our wall.
 *
 *   bun run scripts/verdict-onchain.ts
 *
 * The registries are the deployed ones on Monad testnet. Nothing here deploys anything.
 */
import { createPublicClient, createWalletClient, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  MONAD_TESTNET, approvePlatform, identityAbi, record, registerAgent,
  requestValidation, verdictOnChain, writeVerdict, type Sender,
} from "../src/registry.ts";
import { verdictKey } from "../src/job.ts";
import { monadTestnet } from "../src/live.ts";

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

// the builder of job 1: the seat whose work the checks were actually about
const builder = sender(need("POD_AGENT_BUILDER_KEY"));
const builderAddress = need("POD_AGENT_BUILDER_ADDRESS") as Address;

// 1. an identity, owned by whoever registered it
let agentId: bigint;
const already = process.env.POD_AGENT_BUILDER_ID;
if (already) {
  agentId = BigInt(already);
  console.log(`agent    ${agentId} (already registered)`);
} else {
  const registered = await registerAgent(builder);
  agentId = registered.agentId;
  console.log(`agent    ${agentId} registered  ${registered.hash}`);
}

const owner = await publicClient.readContract({
  address: MONAD_TESTNET.identityRegistry, abi: identityAbi, functionName: "ownerOf", args: [agentId],
});
console.log(`owner    ${owner}${owner.toLowerCase() === builderAddress.toLowerCase() ? " (the agent's own wallet)" : ""}`);

// 2. the owner lets the validator speak for it, so a request can be made for its work
const approved = await publicClient.readContract({
  address: MONAD_TESTNET.identityRegistry, abi: identityAbi, functionName: "isApprovedForAll",
  args: [builderAddress, validator],
});
if (!approved) console.log(`approved validator to act for the agent  ${await approvePlatform(builder, validator)}`);
else console.log("approved the validator can already act for this agent");

// 3. one request per verdict: the job, the commit, and the runner that will answer
const seal = need("POD_DEMO_SEAL") as Hex;
const commit = process.env.POD_DEMO_COMMIT ?? "d15d0cb";
const key = await verdictKey({ seal, commit, runner: validator });
const site = process.env.POD_SITE ?? "http://localhost:3000";
const jobId = process.env.POD_DEMO_ID ?? "an-excuse-that-holds-up";

// the registry reverts rather than answering for a request nobody has made, so a revert here is
// a fact about this key and not a failure
const existing = await verdictOnChain(publicClient, key).catch(() => undefined);
if (!existing || existing.validator === "0x0000000000000000000000000000000000000000") {
  console.log(`requested ${await requestValidation(builder, {
    runner: validator, agentId, evidenceURI: `${site}/job/${jobId}`, key,
  })}`);
} else {
  console.log("requested already asked for");
}

// 4. the verdict, which only the runner named in the request may write
const receiptHash = need("POD_DEMO_RECEIPT_HASH") as Hex;
console.log(`verdict  ${await writeVerdict(sender(validatorKey), {
  key, score: 100, receiptURI: `${site}/receipt/${jobId}`, receiptHash, tag: "pod.tests",
})}`);

// 5. read it back the way anybody else would
const written = await verdictOnChain(publicClient, key);
console.log(`\non chain: ${written.response}/100 under "${written.tag}", answered by ${written.validator}`);
const summary = await record(publicClient, agentId, "pod.tests", [validator]);
console.log(`the agent's record in that role: ${summary.count} verdict(s), average ${summary.average}`);
