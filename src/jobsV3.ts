/**
 * Talking to PodJobsV3, the contract on which the poster has the last word.
 *
 * Everything PodJobsV2 lets anybody ask or do is asked and done the same way here, through jobsV2.ts
 * and jobs.ts. This is only what the third contract adds: the validator reports what the checks found
 * and moves no money; the poster accepts or refuses with their own transaction; when the poster says
 * nothing in their time, anybody settles the job as the checks found; and the contract keeps count of
 * how every poster's and every agent's jobs ended.
 *
 * And how work comes to be graded there, which no seat can stop: the builder puts its own commit
 * forward, the other seats say whether they stand behind it while its review runs, and it is graded
 * when every seat that is taken is behind it or the time for reviewing has run out, whichever comes
 * first. A review is a share of the job's window, so a real job gets hours and a short one still fits.
 *
 * Like the others, it adds no rules of its own: the contract decides.
 */
import { parseAbi, type Address, type Hex } from "viem";
import { answersTo, MOST_BLOCKS_A_LOG_READ_COVERS, type Contract } from "./jobs.ts";
import type { ContractV2, VerdictOnChain } from "./jobsV2.ts";

export const podJobsV3Abi = parseAbi([
  "function putForward(uint256 jobId, bytes32 commitHash)",
  "function reviewBy(uint256) view returns (uint64)",
  "function reviewTimeOf(uint256 jobId) view returns (uint64)",
  "function REVIEW_SHARE_PERCENT() view returns (uint8)",
  "function report(uint256 jobId, bytes32 commitHash, uint8 verdict, bytes32 receiptHash)",
  "function accept(uint256 jobId)",
  "function refuse(uint256 jobId)",
  "function settleUnanswered(uint256 jobId)",
  "function answerBy(uint256) view returns (uint64)",
  "function answers(uint256) view returns (uint8)",
  "function answerTime() view returns (uint64)",
  "function REFUSAL_SHARE_PERCENT() view returns (uint8)",
  "function posters(address) view returns (uint32 posted, uint32 accepted, uint32 refusedPassed, uint32 refusedFailed, uint32 unanswered)",
  "function agents(address) view returns (uint32 accepted, uint32 paidUnanswered, uint32 refusedPassed, uint32 failed, uint32 undelivered)",
  "event PutForward(uint256 indexed jobId, address indexed builder, bytes32 commitHash, uint64 reviewBy)",
  "event Delivered(uint256 indexed jobId, bytes32 commitHash, uint8 verdict, bytes32 receiptHash, uint64 answerBy)",
  "event Accepted(uint256 indexed jobId, address indexed poster)",
  "event Refused(uint256 indexed jobId, address indexed poster, uint256 keptByThePod)",
  "event SettledUnanswered(uint256 indexed jobId, uint8 verdict)",
  // the contract's refusals these calls can meet, by name, so a reverted call says why
  "error NotPoster()",
  "error NotValidator()",
  "error WrongState()",
  "error CommitMismatch()",
  "error NotTheSeat()",
  "error Locked()",
  "error NotLocked()",
  "error NoVerdict()",
  "error TooLate()",
  "error TooEarly()",
]);

/**
 * What a pod keeps, in percent of each seat's pay, when its poster refuses work whose checks passed.
 * The contract's own constant, said here so a page can say it before anybody pays; a test holds the
 * two together.
 */
export const REFUSAL_SHARE_PERCENT = 25;

/**
 * How long the other seats have to say whether they stand behind what a builder put forward, in
 * percent of the job's window. The contract's own constant, said here so a page can say it before
 * anybody takes a seat; a test holds the two together.
 */
export const REVIEW_SHARE_PERCENT = 25;

/** The contract's own numbers for what the checks found, as jobsV2.ts names them */
const VERDICT_NUMBER: Record<VerdictOnChain, number> = { passed: 1, "hidden-failed": 2, "visible-failed": 3 };

/** How a poster's jobs have ended, as the contract counts them. */
export interface PosterRecord {
  readonly posted: number;
  readonly accepted: number;
  /** refused although its checks passed: the count an agent looks at before taking a seat */
  readonly refusedPassed: number;
  /** refused after its checks failed, which costs nobody anything they were owed */
  readonly refusedFailed: number;
  /** said nothing in time, so the checks decided */
  readonly unanswered: number;
}

/**
 * How the jobs an agent stood behind have ended, as the contract counts them: the ones it put forward
 * as their builder, and the ones it said yes to from another seat. A seat it held and said nothing
 * from is not counted.
 */
export interface AgentRecord {
  readonly accepted: number;
  /** the poster said nothing and the checks passed */
  readonly paidUnanswered: number;
  /** the poster refused although the checks passed */
  readonly refusedPassed: number;
  /** the checks failed, and the poster refused or said nothing */
  readonly failed: number;
  /** as the builder: the window closed with no work of its ever reaching grading */
  readonly undelivered: number;
  /** seats it stood behind work from and was kept from the pay of by the lead, where a contract lets a lead do that */
  readonly withheld?: number;
  /** jobs on which, as the lead, it kept pay from at least one seat, where a contract lets a lead do that */
  readonly withholdings?: number;
}

/** Wait for a transaction and refuse to carry on if the chain reverted it. */
async function sent(at: Contract, hash: Hex): Promise<Hex> {
  const receipt = await at.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`the chain rejected ${hash}`);
  return hash;
}

async function call(at: Contract, functionName: "accept" | "refuse" | "settleUnanswered", jobId: bigint): Promise<Hex> {
  const { request } = await at.publicClient.simulateContract({
    address: at.address, abi: podJobsV3Abi, functionName, args: [jobId], account: at.wallet.account!,
  });
  return sent(at, await at.wallet.writeContract(request));
}

/**
 * Whether the poster has the last word on this contract: asked of the contract itself, which answers
 * how long a poster has only if it is one that gives them the time.
 */
export function hasTheLastWord(at: ContractV2): Promise<boolean> {
  return answersTo(at.publicClient.readContract({ address: at.address, abi: podJobsV3Abi, functionName: "answerTime" }));
}

/**
 * Whether work is graded on this contract without any seat being able to hold it back: asked of the
 * contract itself, which says what share of a job's window a review is only if a builder puts its
 * own work forward there.
 */
export function isPutForwardByItsBuilder(at: ContractV2): Promise<boolean> {
  return answersTo(at.publicClient.readContract({ address: at.address, abi: podJobsV3Abi, functionName: "REVIEW_SHARE_PERCENT" }));
}

/** How long a review is, in percent of the job's window. */
export function readReviewShare(at: ContractV2): Promise<number> {
  return at.publicClient.readContract({ address: at.address, abi: podJobsV3Abi, functionName: "REVIEW_SHARE_PERCENT" });
}

/** How long the other seats have to say whether they stand behind work put forward on one job, in seconds. */
export function readReviewTimeOf(at: ContractV2, jobId: bigint): Promise<bigint> {
  return at.publicClient.readContract({ address: at.address, abi: podJobsV3Abi, functionName: "reviewTimeOf", args: [jobId] });
}

/**
 * Until when the other seats may stand behind the commit put forward, in the chain's seconds, after
 * which it is graded whoever does; nothing while no commit is put forward.
 */
export async function readReviewBy(at: ContractV2, jobId: bigint): Promise<bigint | undefined> {
  const until = await at.publicClient.readContract({ address: at.address, abi: podJobsV3Abi, functionName: "reviewBy", args: [jobId] });
  return until === 0n ? undefined : until;
}

/** The builder puts its work forward, as one exact commit, to be reviewed and graded. Only the job's builder can. */
export async function putForward(at: Contract, jobId: bigint, commit: Hex): Promise<Hex> {
  const { request } = await at.publicClient.simulateContract({
    address: at.address, abi: podJobsV3Abi, functionName: "putForward", args: [jobId, commit], account: at.wallet.account!,
  });
  return sent(at, await at.wallet.writeContract(request));
}

/**
 * When a commit was last put forward, read from the contract's own record of it, backwards from the
 * newest block in slices the node allows; nothing if it was longer ago than was looked.
 */
export async function readWhenPutForward(
  at: ContractV2, jobId: bigint, commit: Hex, mostBlocksBack: bigint,
): Promise<{ readonly builder: Address; readonly at: bigint } | undefined> {
  const latest = await at.publicClient.getBlockNumber({ cacheTime: 0 });
  const floor = latest > mostBlocksBack ? latest - mostBlocksBack : 0n;
  for (let to = latest; to >= floor;) {
    const from = to - floor >= MOST_BLOCKS_A_LOG_READ_COVERS ? to - MOST_BLOCKS_A_LOG_READ_COVERS + 1n : floor;
    const logs = await at.publicClient.getContractEvents({
      address: at.address, abi: podJobsV3Abi, eventName: "PutForward", args: { jobId }, fromBlock: from, toBlock: to, strict: true,
    });
    const last = [...logs].reverse().find((log) => log.args.commitHash.toLowerCase() === commit.toLowerCase());
    if (last) return { builder: last.args.builder, at: (await at.publicClient.getBlock({ blockHash: last.blockHash })).timestamp };
    if (from === 0n) break;
    to = from - 1n;
  }
  return undefined;
}

/** The validator's report of what the checks found, with the receipt it rests on. No money moves. */
export async function report(at: Contract, jobId: bigint, commit: Hex, verdict: VerdictOnChain, receiptHash: Hex): Promise<Hex> {
  const { request } = await at.publicClient.simulateContract({
    address: at.address, abi: podJobsV3Abi, functionName: "report",
    args: [jobId, commit, VERDICT_NUMBER[verdict], receiptHash], account: at.wallet.account!,
  });
  return sent(at, await at.wallet.writeContract(request));
}

/** The poster accepts the delivered work: the pod is paid, whatever the checks found. */
export function accept(at: Contract, jobId: bigint): Promise<Hex> {
  return call(at, "accept", jobId);
}

/** The poster refuses the delivered work, within their time to answer. */
export function refuse(at: Contract, jobId: bigint): Promise<Hex> {
  return call(at, "refuse", jobId);
}

/** The poster said nothing in their time: the job is settled as the checks found. Anybody may send it. */
export function settleUnanswered(at: Contract, jobId: bigint): Promise<Hex> {
  return call(at, "settleUnanswered", jobId);
}

/** Until when a delivered job's poster may refuse, in the chain's seconds; nothing for a job not delivered. */
export async function readAnswerBy(at: ContractV2, jobId: bigint): Promise<bigint | undefined> {
  const until = await at.publicClient.readContract({ address: at.address, abi: podJobsV3Abi, functionName: "answerBy", args: [jobId] });
  return until === 0n ? undefined : until;
}

/** How long a poster has to answer a delivery, in seconds. */
export function readAnswerTime(at: ContractV2): Promise<bigint> {
  return at.publicClient.readContract({ address: at.address, abi: podJobsV3Abi, functionName: "answerTime" });
}

/** What a pod keeps, in percent of each seat's pay, when its poster refuses work whose checks passed. */
export function readRefusalShare(at: ContractV2): Promise<number> {
  return at.publicClient.readContract({ address: at.address, abi: podJobsV3Abi, functionName: "REFUSAL_SHARE_PERCENT" });
}

export async function readPosterRecord(at: ContractV2, poster: Address): Promise<PosterRecord> {
  const [posted, accepted, refusedPassed, refusedFailed, unanswered] = await at.publicClient.readContract({
    address: at.address, abi: podJobsV3Abi, functionName: "posters", args: [poster],
  });
  return { posted, accepted, refusedPassed, refusedFailed, unanswered };
}

export async function readAgentRecord(at: ContractV2, agent: Address): Promise<AgentRecord> {
  const [accepted, paidUnanswered, refusedPassed, failed, undelivered] = await at.publicClient.readContract({
    address: at.address, abi: podJobsV3Abi, functionName: "agents", args: [agent],
  });
  return { accepted, paidUnanswered, refusedPassed, failed, undelivered };
}

/** How a delivered job ended: what its poster said, or that they said nothing in time and the checks decided. */
export type HowItEnded = "accepted" | "refused" | "unanswered";
/** the contract's own numbers for it, in its order; zero is a job not answered, or never delivered */
const ENDINGS: readonly (HowItEnded | undefined)[] = [undefined, "accepted", "refused", "unanswered"];

/** How a delivered job ended, asked of the contract; nothing while it waits for its poster, or was never delivered. */
export async function readHowItEnded(at: ContractV2, jobId: bigint): Promise<HowItEnded | undefined> {
  const answer = await at.publicClient.readContract({ address: at.address, abi: podJobsV3Abi, functionName: "answers", args: [jobId] });
  if (answer >= ENDINGS.length) throw new Error(`the contract said job ${jobId} ended in way ${answer}, which this contract has no word for`);
  return ENDINGS[answer];
}

/**
 * The transaction that ended a delivered job, and what the pod kept when it was a refusal, read from
 * the contract's events between two blocks, in slices as wide as the node allows. For a link on the
 * job's page: how the job ended is asked of the contract itself, and never rests on this.
 */
export async function readTheAnswersTransaction(
  at: ContractV2, jobId: bigint, range: { readonly fromBlock: bigint; readonly toBlock: bigint; readonly sliceBlocks: bigint },
): Promise<{ readonly hash: Hex; readonly keptByThePod?: bigint } | undefined> {
  for (let from = range.fromBlock; from <= range.toBlock; from += range.sliceBlocks) {
    const to = from + range.sliceBlocks - 1n > range.toBlock ? range.toBlock : from + range.sliceBlocks - 1n;
    const slice = { address: at.address, abi: podJobsV3Abi, args: { jobId }, fromBlock: from, toBlock: to, strict: true } as const;
    const [accepted, refused, unanswered] = await Promise.all([
      at.publicClient.getContractEvents({ ...slice, eventName: "Accepted" }),
      at.publicClient.getContractEvents({ ...slice, eventName: "Refused" }),
      at.publicClient.getContractEvents({ ...slice, eventName: "SettledUnanswered" }),
    ]);
    if (accepted[0]) return { hash: accepted[0].transactionHash };
    if (refused[0]) return { hash: refused[0].transactionHash, keptByThePod: refused[0].args.keptByThePod };
    if (unanswered[0]) return { hash: unanswered[0].transactionHash };
  }
  return undefined;
}
