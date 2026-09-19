/**
 * Match the jobs on the wall to the jobs on the chain, by the seal both sides hold.
 *
 * A job that ran before the page carried its transactions has no link to the chain. Rather than
 * typing the numbers in from a terminal I still had open — which is how the last gap got in — this
 * asks the contract for every job it knows about and matches on the seal, which neither side can
 * have guessed.
 *
 *   bun run scripts/match-to-chain.ts
 */
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { podJobsAbi } from "../src/jobs.ts";
import { monadTestnet } from "../src/live.ts";
import { JobStore } from "../src/store.ts";
import { podTokenAbi } from "../src/token.ts";

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; is .env loaded?`);
  return value;
};

const publicClient = createPublicClient({
  chain: monadTestnet, transport: http(need("MONAD_TESTNET_RPC")),
}) as PublicClient;

const jobs = need("POD_JOBS_ADDRESS") as Address;
const tokenAt = need("POD_TOKEN_ADDRESS") as Address;
const store = new JobStore(need("POD_JOBS"));

const next = await publicClient.readContract({ address: jobs, abi: podJobsAbi, functionName: "nextJobId" });

// every job the contract knows, by the seal it was posted under
const bySeal = new Map<string, bigint>();
for (let id = 1n; id < next; id++) {
  const [, , seal] = await publicClient.readContract({
    address: jobs, abi: podJobsAbi, functionName: "jobs", args: [id],
  });
  bySeal.set(seal.toLowerCase(), id);
}
console.log(`the contract knows ${bySeal.size} jobs\n`);

for (const record of await store.all()) {
  if (record.chain) {
    console.log(`${record.jobId}: already matched to job ${record.chain.jobId}`);
    continue;
  }
  const onChain = bySeal.get(record.seal.toLowerCase());
  if (onChain === undefined) {
    console.log(`${record.jobId}: no job on the chain carries this seal, so nothing is linked`);
    continue;
  }

  const tokenId = await publicClient.readContract({
    address: tokenAt, abi: podTokenAbi, functionName: "tokenOfJob", args: [onChain],
  });

  await store.save({
    ...record,
    chain: {
      network: "monad-testnet",
      jobId: onChain.toString(),
      jobs,
      tokenId: tokenId > 0n ? tokenId.toString() : undefined,
    },
  }, {});
  console.log(`${record.jobId}: job ${onChain}${tokenId > 0n ? `, POD #${tokenId}` : ", no title"}`);
}
