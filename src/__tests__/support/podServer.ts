/**
 * A server with every door open and one job posted on a real local chain: what a pod of agents
 * needs to exist before it can do anything, set up the way the posting page leaves it.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CheckWriting, ProvenChecks } from "../../checkwriting/index.ts";
import { CreditBook, CreditDoor, doorChainFor, Doorkeeper, GitDoor, JobList, NoteBoard, type DoorChain } from "../../door/index.ts";
import { sealSpec, type Role, type Spec } from "../../job.ts";
import { policyMet, post, readJob, readSeats, readTerms } from "../../jobs.ts";
import { checksDigest, podJobsV2Abi } from "../../jobsV2.ts";
import { openJob } from "../../publish.ts";
import type { Registries } from "../../registry.ts";
import { PLAIN_GIT } from "../../plainGit.ts";
import { bytes32ToCommit } from "../../repo.ts";
import { serve } from "../../server.ts";
import { JobStore } from "../../store.ts";
import { ANVIL_KEYS, startAnvil, type Anvil } from "./anvil.ts";
import { GOOD_REPLY, replying, writerWith } from "./coat.ts";
import { deployRegistries } from "./registries.ts";

/** The key the contracts answer to: it settles, mints, and signs every receipt */
export const VALIDATOR = ANVIL_KEYS[6];
/** The key that writes checks and signs what a poster approves, on the contract that prepares jobs */
export const WRITER = ANVIL_KEYS[4];
const WRITING_PRICE = parseEther("0.05");
const PAYOUT_GAS = 100_000n;
const POSTER = ANVIL_KEYS[1];

/** A job paid for on the contract that prepares jobs, its checks signed by the writer and approved by its poster. */
async function postPrepared(anvil: Anvil, jobs: Address, seal: Hex, window: bigint, price: bigint): Promise<{ readonly onChainId: bigint; readonly endsAt: bigint }> {
  const poster = anvil.wallet(POSTER);
  const posted = await anvil.publicClient.simulateContract({
    address: jobs, abi: podJobsV2Abi, functionName: "post", args: [window, 1], value: price + 3n * WRITING_PRICE, account: poster.account,
  });
  await anvil.publicClient.waitForTransactionReceipt({ hash: await poster.writeContract(posted.request) });
  const onChainId = posted.result;
  const writer = anvil.wallet(WRITER);
  const signature = await writer.signMessage({ account: writer.account, message: { raw: checksDigest({ jobs, chainId: 31337, jobId: onChainId, seal }) } });
  const approving = await anvil.publicClient.simulateContract({
    address: jobs, abi: podJobsV2Abi, functionName: "approveChecks", args: [onChainId, seal, signature], account: poster.account,
  });
  await anvil.publicClient.waitForTransactionReceipt({ hash: await poster.writeContract(approving.request) });
  return { onChainId, endsAt: (await readJob({ address: jobs, publicClient: anvil.publicClient }, onChainId)).endsAt };
}

export interface Agent {
  readonly key: Hex;
  readonly address: Address;
}

export function anAgent(): Agent {
  const key = generatePrivateKey();
  return { key, address: privateKeyToAccount(key).address };
}

/**
 * The chain as the doors read it, on a local chain. A test that counts the reads says what to count.
 */
export function doorChainOn(anvil: Anvil, jobs: Address, counting: { readonly jobRead?: () => void; readonly seatsRead?: () => void } = {}): DoorChain {
  const reading = { address: jobs, publicClient: anvil.publicClient };
  return doorChainFor({
    jobs,
    readJob: (id) => { counting.jobRead?.(); return readJob(reading, id); },
    readSeats: (id) => { counting.seatsRead?.(); return readSeats(reading, id); },
    readTerms: (id) => readTerms(reading, id),
    latestBlockTime: async () => (await anvil.publicClient.getBlock()).timestamp,
  });
}

/** Five fresh keys, one per seat. */
export function aPod(): Readonly<Record<Role, Agent>> {
  return { lead: anAgent(), builder: anAgent(), reviewer: anAgent(), qa: anAgent(), security: anAgent() };
}

export interface RunningPodServer {
  readonly anvil: Anvil;
  readonly jobs: Address;
  /** the contract jobs were posted on first: the same as `jobs` unless the job was prepared */
  readonly earlierJobs: Address;
  /** the title contract, minted on by the validator */
  readonly token: Address;
  /** the ERC-8004 team's registries, deployed here and named in the market so agents know where to ask */
  readonly registries: Registries;
  readonly store: JobStore;
  readonly repositories: string;
  readonly base: string;
  readonly onChainId: bigint;
  readonly reading: { readonly address: Address; readonly publicClient: PublicClient };
  /** which GitHub account each agent's work is credited to, as the doors read it */
  readonly credit: CreditBook;
  /** git, run against the job's bare repository on the server's own disk */
  git(args: readonly string[]): Promise<string>;
  stop(): void;
}

export async function aPodServer(input: {
  readonly jobId: string;
  readonly spec: Spec;
  readonly files: Readonly<Record<string, string>>;
  readonly fund: readonly Agent[];
  readonly hours?: number;
  /**
   * Post on the contract that prepares jobs: paid with its writings, the checks signed by the writer
   * and approved by the poster, as the server and the page leave it. The first contract is deployed
   * beside it as the earlier one, as on Monad after the switch.
   */
  readonly prepared?: boolean;
}): Promise<RunningPodServer> {
  const anvil = await startAnvil();
  const validator = privateKeyToAccount(VALIDATOR).address;
  const earlierJobs = await anvil.deploy("PodJobs", [validator]);
  const jobs = input.prepared
    ? await anvil.deploy("PodJobsV2", [validator, privateKeyToAccount(WRITER).address, 1n, WRITING_PRICE, PAYOUT_GAS])
    : earlierJobs;
  const token = await anvil.deploy("PodToken", [privateKeyToAccount(VALIDATOR).address]);
  const registries = await deployRegistries(anvil);
  for (const agent of input.fund) await anvil.fund(agent.address);
  const store = new JobStore(await mkdtemp(join(tmpdir(), "pod-jobs-")));
  const repositories = await mkdtemp(join(tmpdir(), "pod-repositories-"));
  const reading = { address: jobs, publicClient: anvil.publicClient };

  const now = (await anvil.publicClient.getBlock()).timestamp;
  const seconds = BigInt(Math.round((input.hours ?? 1) * 3600));
  const seal = await sealSpec(input.spec);
  const { onChainId, endsAt } = input.prepared
    ? await postPrepared(anvil, jobs, seal, seconds, input.spec.price)
    : { onChainId: await post({ ...reading, wallet: anvil.wallet(ANVIL_KEYS[1]) }, { seal, endsAt: now + seconds, reviewers: 1, price: input.spec.price }), endsAt: now + seconds };
  const opened = await openJob(store, { jobId: input.jobId, seal, spec: input.spec, endsAt: new Date(Number(endsAt) * 1000), seats: [] });
  await store.save({ ...opened, chain: { network: "monad-testnet", jobId: String(onChainId), jobs } }, input.files);
  await store.saveSpec(input.jobId, input.spec);

  const keeper = new Doorkeeper({ store, chain: doorChainOn(anvil, jobs) });
  const credit = new CreditBook(await mkdtemp(join(tmpdir(), "pod-credit-")));
  const proven = new ProvenChecks(await mkdtemp(join(tmpdir(), "pod-proven-")));
  const server = serve(store, 0, {
    // the market is here for what agents read first: which chain, which contract
    market: {
      page: { chainId: 31337, chainName: "a local chain", rpc: anvil.rpc, jobs, explorer: "http://explorer.invalid", coin: "ETH", registries },
      chain: { jobs, job: async () => undefined, now: async () => (await anvil.publicClient.getBlock()).timestamp },
      writing: new CheckWriting({ writer: writerWith(replying(GOOD_REPLY).model), proven }),
      proven,
    },
    door: new GitDoor({ repositories, keeper, credit }),
    notes: new NoteBoard({ keeper, store }),
    jobList: new JobList({ keeper, store }),
    credit: new CreditDoor({ book: credit }),
  });

  return {
    anvil, jobs, earlierJobs, token, registries, store, repositories, reading, onChainId, credit,
    base: `http://127.0.0.1:${server.port}`,
    async git(args) {
      const child = Bun.spawn(["git", "--git-dir", join(repositories, `${input.jobId}.git`), ...args], {
        stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...PLAIN_GIT },
      });
      const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(child.stderr).text()}`);
      return out;
    },
    stop() {
      server.stop();
      anvil.stop();
    },
  };
}

/** Wait until the contract says every approval the policy asks for is on one commit, and hand back which. */
export async function untilThePolicyIsMet(running: RunningPodServer, seconds: number): Promise<string | undefined> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const job = await readJob(running.reading, running.onChainId);
    if (!/^0x0{64}$/i.test(job.commit) && (await policyMet(running.reading, running.onChainId, job.commit))) return bytes32ToCommit(job.commit);
    await Bun.sleep(500);
  }
  return undefined;
}
