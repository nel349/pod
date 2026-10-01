/**
 * Talking to PodJobsV2, the contract for jobs that are ready before a pod can start.
 *
 * What the server needs of it while a job is preparing: the job and its writing money as the chain
 * has them, the three things the writer key may do with that money, and the writer's signature over
 * the checks a poster approves. Like jobs.ts, it adds no rules of its own: the contract decides.
 *
 * The old contract keeps its own reader, jobs.ts, with its own shape, for the jobs already on it.
 */
import {
  encodeAbiParameters, keccak256, parseAbi, toBytes, type Account, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import type { Contract } from "./jobs.ts";

export const podJobsV2Abi = parseAbi([
  "function post(uint64 window, uint8 reviewers) payable returns (uint256)",
  "function topUp(uint256 jobId) payable",
  "function reserveWriting(uint256 jobId)",
  "function keepWriting(uint256 jobId)",
  "function releaseWriting(uint256 jobId)",
  "function approveChecks(uint256 jobId, bytes32 seal, bytes writerSignature)",
  "function takeBack(uint256 jobId)",
  "function checksDigest(uint256 jobId, bytes32 seal) view returns (bytes32)",
  "function jobs(uint256) view returns (address poster, uint256 price, bytes32 seal, uint64 endsAt, uint8 state, bytes32 commit, uint8 reviewers, uint64 window)",
  "function writings(uint256) view returns (uint256 balance, uint256 reserved, uint64 reservedAt, uint32 kept)",
  "function writingPrice() view returns (uint256)",
  "function writer() view returns (address)",
  "function nextJobId() view returns (uint256)",
  "function WRITINGS_INCLUDED() view returns (uint8)",
  "function settle(uint256 jobId, bytes32 commitHash, uint8 verdict, bytes32 receiptHash)",
  "function releaseLock(uint256 jobId)",
  "function close(uint256 jobId)",
  "function locked(uint256 jobId) view returns (bool)",
  "function reports(uint256) view returns (uint8 verdict, bytes32 receiptHash)",
  "event Created(uint256 indexed jobId, address indexed poster, uint256 price, uint64 window, uint256 forWriting)",
  "event Opened(uint256 indexed jobId, bytes32 seal, uint64 endsAt, uint256 returnedToPoster)",
  // the contract's refusals, by name, so a reverted call says why rather than showing four bytes
  "error NotPoster()",
  "error NotValidator()",
  "error NotWriter()",
  "error WrongState()",
  "error WrongAmount()",
  "error TooManyReviewers()",
  "error NoWindow()",
  "error NoSuchJob()",
  "error BuildersDoNotApprove()",
  "error NotWritten()",
  "error WritingUnderWay()",
  "error NoWritingUnderWay()",
  "error NothingToWriteWith()",
  "error SeatFilled()",
  "error OwnerAlreadySeated()",
  "error NotTheSeat()",
  "error CommitMismatch()",
  "error Locked()",
  "error NotLocked()",
  "error PolicyNotMet()",
  "error NoVerdict()",
  "error TooLate()",
  "error TooEarly()",
  "error NothingOwed()",
  "error PaymentFailed()",
]);

/** A job's state on the new contract, in the contract's order: preparing was added last. */
export type JobStateV2 = "open" | "working" | "settled" | "refunded" | "preparing";
const STATES_V2: readonly JobStateV2[] = ["open", "working", "settled", "refunded", "preparing"];

/** The contract's state number, in words, or an error for a number it never gives. */
export function stateOfV2(state: number): JobStateV2 {
  const known = STATES_V2[state];
  if (known === undefined) throw new Error(`the contract said a job is in state ${state}, which this contract has no word for`);
  return known;
}

export interface JobV2 {
  readonly poster: Address;
  /** what the pod is paid, without the money for writing its checks */
  readonly price: bigint;
  /** zero until the poster approves the checks */
  readonly seal: Hex;
  /** zero until the poster approves: the window starts then */
  readonly endsAt: bigint;
  readonly state: JobStateV2;
  readonly commit: Hex;
  readonly reviewers: number;
  /** how long the job stays open once approved, in seconds */
  readonly window: bigint;
}

/** The money for writing a job's checks, as the chain holds it. */
export interface WritingMoney {
  /** for writings not yet started */
  readonly balance: bigint;
  /** the price of the writing under way, or nothing */
  readonly reserved: bigint;
  readonly kept: number;
}

export interface ContractV2 {
  readonly address: Address;
  readonly publicClient: PublicClient;
}

/** The job at this number, or nothing when the contract has never numbered one so. */
export async function readJobV2(at: ContractV2, jobId: bigint): Promise<JobV2 | undefined> {
  const [poster, price, seal, endsAt, state, commit, reviewers, window] = await at.publicClient.readContract({
    address: at.address, abi: podJobsV2Abi, functionName: "jobs", args: [jobId],
  });
  // the contract answers zeroes for a number it never gave out, rather than refusing
  if (/^0x0{40}$/i.test(poster)) return undefined;
  return { poster, price, seal, endsAt, state: stateOfV2(state), commit, reviewers, window };
}

export async function readWritingMoney(at: ContractV2, jobId: bigint): Promise<WritingMoney> {
  const [balance, reserved, , kept] = await at.publicClient.readContract({
    address: at.address, abi: podJobsV2Abi, functionName: "writings", args: [jobId],
  });
  return { balance, reserved, kept };
}

export function readWritingPrice(at: ContractV2): Promise<bigint> {
  return at.publicClient.readContract({ address: at.address, abi: podJobsV2Abi, functionName: "writingPrice" });
}

/** What the writer's signature over an approval is for, exactly as the contract names it. */
const CHECKS_WRITTEN = keccak256(toBytes("pod.checks-written.v1"));

/**
 * What the writer signs to say it wrote the checks a seal fixes, for this job on this contract: the
 * contract's checksDigest, worked out here so signing needs no call to the chain.
 */
export function checksDigest(input: { readonly jobs: Address; readonly chainId: number; readonly jobId: bigint; readonly seal: Hex }): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
    [CHECKS_WRITTEN, input.jobs, BigInt(input.chainId), input.jobId, input.seal],
  ));
}

/**
 * The writer key: the one key that reserves, keeps and releases writing money, and signs the checks
 * it wrote. It can move no other money. It lives on the web server, apart from the validator's key,
 * which stays with the worker.
 *
 * It sends one transaction at a time, since two sent together from one key can take the same nonce
 * and one of them be lost.
 */
export class WriterKey {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly at: ContractV2 & { readonly wallet: WalletClient & { readonly account: Account } }) {}

  get address(): Address {
    return this.at.wallet.account.address;
  }

  /** A writing starts: its price is set aside on the chain before anything is written. */
  reserve(jobId: bigint): Promise<Hex> {
    return this.send("reserveWriting", jobId);
  }

  /** The writing was done: its price is kept, for the validator. */
  keep(jobId: bigint): Promise<Hex> {
    return this.send("keepWriting", jobId);
  }

  /** The writing failed on our side: its price goes back, to the job while it prepares or its poster after. */
  release(jobId: bigint): Promise<Hex> {
    return this.send("releaseWriting", jobId);
  }

  /** The writer's word that it wrote the checks this seal fixes, for this job, which the poster's approval carries. */
  sign(jobId: bigint, seal: Hex): Promise<Hex> {
    const digest = checksDigest({ jobs: this.at.address, chainId: this.chainId(), jobId, seal });
    return this.at.wallet.signMessage({ account: this.at.wallet.account, message: { raw: digest } });
  }

  private chainId(): number {
    const id = this.at.wallet.chain?.id ?? this.at.publicClient.chain?.id;
    if (id === undefined) throw new Error("the writer key's wallet names no chain, so it cannot say which chain it signs for");
    return id;
  }

  private send(functionName: "reserveWriting" | "keepWriting" | "releaseWriting", jobId: bigint): Promise<Hex> {
    const sending = this.queue.then(async () => {
      const { request } = await this.at.publicClient.simulateContract({
        address: this.at.address, abi: podJobsV2Abi, functionName, args: [jobId], account: this.at.wallet.account,
      });
      const hash = await this.at.wallet.writeContract(request);
      const receipt = await this.at.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`the chain rejected ${functionName} for job ${jobId}: ${hash}`);
      return hash;
    });
    // the next one waits for this one whether it worked or not
    this.queue = sending.catch(() => undefined);
    return sending;
  }
}

/**
 * What the validator found, as the contract takes it: passed, failed only on a check the pod could not
 * see, or failed on one it could. The last is the one that costs the seats that approved.
 */
export type VerdictOnChain = "passed" | "hidden-failed" | "visible-failed";
const VERDICT_NUMBER: Record<VerdictOnChain, number> = { passed: 1, "hidden-failed": 2, "visible-failed": 3 };

/** Wait for a transaction and refuse to carry on if the chain reverted it. */
async function sent(at: Contract, hash: Hex): Promise<Hex> {
  const receipt = await at.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`the chain rejected ${hash}`);
  return hash;
}

async function call(at: Contract, functionName: "releaseLock" | "close", jobId: bigint): Promise<Hex> {
  const { request } = await at.publicClient.simulateContract({
    address: at.address, abi: podJobsV2Abi, functionName, args: [jobId], account: at.wallet.account!,
  });
  return sent(at, await at.wallet.writeContract(request));
}

/** The verdict reaching the money, with the receipt it rests on, on the job's current commit only. */
export async function settleV2(at: Contract, jobId: bigint, commit: Hex, verdict: VerdictOnChain, receiptHash: Hex): Promise<Hex> {
  const { request } = await at.publicClient.simulateContract({
    address: at.address, abi: podJobsV2Abi, functionName: "settle",
    args: [jobId, commit, VERDICT_NUMBER[verdict], receiptHash], account: at.wallet.account!,
  });
  return sent(at, await at.wallet.writeContract(request));
}

/** Let go of a locked job the validator held or could not grade: its commit and approvals are cleared. */
export function releaseLock(at: Contract, jobId: bigint): Promise<Hex> {
  return call(at, "releaseLock", jobId);
}

/** Close a job whose window ended with no verdict: the poster's money and every deposit go home. */
export function closeJob(at: Contract, jobId: bigint): Promise<Hex> {
  return call(at, "close", jobId);
}

export function isLocked(at: ContractV2, jobId: bigint): Promise<boolean> {
  return at.publicClient.readContract({ address: at.address, abi: podJobsV2Abi, functionName: "locked", args: [jobId] });
}

/** What the validator reported for a job, as the contract recorded it: nothing until it settles. */
export async function readReport(at: ContractV2, jobId: bigint): Promise<{ readonly verdict: VerdictOnChain | undefined; readonly receiptHash: Hex }> {
  const [verdict, receiptHash] = await at.publicClient.readContract({ address: at.address, abi: podJobsV2Abi, functionName: "reports", args: [jobId] });
  const named = (Object.keys(VERDICT_NUMBER) as VerdictOnChain[]).find((name) => VERDICT_NUMBER[name] === verdict);
  return { verdict: named, receiptHash };
}
