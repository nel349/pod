/**
 * A job the way the worker leaves one that passed: posted, every seat taken and approving one commit,
 * the pod paid, and the title minted to whoever paid. On a local chain, with real contracts.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sealSpec, type Spec } from "../../job.ts";
import { approve, post, settle, takeSeat } from "../../jobs.ts";
import { openJob } from "../../publish.ts";
import { commitToBytes32 } from "../../repo.ts";
import { SEATS } from "../../seal.ts";
import { JobStore } from "../../store.ts";
import { mintPod, tokenOfJob } from "../../token.ts";
import { ANVIL_KEYS, type Anvil } from "./anvil.ts";
import { COAT_IDEA, DRY, WET } from "./coat.ts";
import { aPod, VALIDATOR } from "./podServer.ts";

/** Who paid, and so who holds the title until it is sold */
export const POSTER = ANVIL_KEYS[1];

export const TITLED_SPEC: Spec = {
  idea: COAT_IDEA, kind: "service", mode: "flash", price: parseEther("1"),
  checks: [
    { says: WET, run: "node check-1.mjs", hidden: false, file: "check-1.mjs" },
    { says: DRY, run: "node check-2.mjs", hidden: true, file: "check-2.mjs" },
  ],
  allowed: [], salt: "a-number-nobody-can-guess",
};

export interface Titled {
  readonly store: JobStore;
  /** the jobs contract the job was posted on */
  readonly jobs: Address;
  readonly token: Address;
  readonly tokenId: bigint;
}

/** The job, titled, with its record kept in a fresh store and pointing at the repository given. */
export async function aTitledJob(anvil: Anvil, input: { readonly jobId: string; readonly commit: string; readonly repository: string }): Promise<Titled> {
  const validator = privateKeyToAccount(VALIDATOR).address;
  const jobs = await anvil.deploy("PodJobs", [validator]);
  const token = await anvil.deploy("PodToken", [validator]);
  const as = (key: Hex) => ({ address: jobs, publicClient: anvil.publicClient, wallet: anvil.wallet(key) });
  const pod = aPod();
  for (const agent of Object.values(pod)) await anvil.fund(agent.address);

  const now = (await anvil.publicClient.getBlock()).timestamp;
  const seal = await sealSpec(TITLED_SPEC);
  const onChainId = await post(as(POSTER), { seal, endsAt: now + 3600n, reviewers: 1, price: TITLED_SPEC.price });
  const commit = commitToBytes32(input.commit);
  for (const role of SEATS) await takeSeat(as(pod[role].key), onChainId, role, pod[role].address);
  for (const role of SEATS) await approve(as(pod[role].key), onChainId, role, commit);
  await settle(as(VALIDATOR), onChainId, commit, true);
  const minter = { address: token, publicClient: anvil.publicClient, wallet: anvil.wallet(VALIDATOR) };
  await mintPod(minter, {
    jobs: as(VALIDATOR), jobId: onChainId, seal, commit, receiptHash: `0x${"9e".repeat(32)}`,
    crew: SEATS.map((role) => ({ role, agent: pod[role].address })), uri: `https://pod.example/job/${input.jobId}`,
  });
  const tokenId = await tokenOfJob(minter, onChainId);

  const store = new JobStore(await mkdtemp(join(tmpdir(), "pod-titled-")));
  const opened = await openJob(store, { jobId: input.jobId, seal, spec: TITLED_SPEC, endsAt: new Date(Number(now + 3600n) * 1000), seats: [] });
  await store.save({ ...opened, repository: input.repository, chain: { network: "monad-testnet", jobId: String(onChainId), jobs, tokenId: tokenId.toString() } });
  return { store, jobs, token, tokenId };
}
