/**
 * Talking to PodJobs: the contract that holds the money and refuses to let go of it.
 *
 * Everything here is a thin, typed way to say what the contract already enforces. It adds no rules of
 * its own, because a rule that lives in a client is a rule an agent can skip: the contract is the one
 * that decides who may take a seat, whose approval counts, and whether anyone is paid.
 *
 * The role names are the ones the rest of the project uses. The contract's enum order is an
 * implementation detail of Solidity and is converted in exactly one place, below.
 */
import { parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import type { Role } from "./job.ts";
import { SEATS } from "./seal.ts";

export const podJobsAbi = parseAbi([
  "function post(bytes32 seal, uint64 endsAt, uint8 reviewers) payable returns (uint256)",
  "function takeSeat(uint256 jobId, uint8 role, address owner) payable",
  "function approve(uint256 jobId, uint8 role, bytes32 commitHash)",
  "function settle(uint256 jobId, bytes32 commitHash, bool passed)",
  "function reclaim(uint256 jobId)",
  "function policyMet(uint256 jobId, bytes32 commitHash) view returns (bool)",
  "function seatPay(uint256 jobId, uint8 role) view returns (uint256)",
  "function seatDeposit(uint256 jobId, uint8 role) view returns (uint256)",
  "function seatCount(uint256 jobId, uint8 role) view returns (uint256)",
  "function seatAt(uint256 jobId, uint8 role, uint256 index) view returns ((address agent, address owner, uint256 deposit, bool approved))",
  "function validator() view returns (address)",
  "function nextJobId() view returns (uint256)",
  "function jobs(uint256) view returns (address poster, uint256 price, bytes32 seal, uint64 endsAt, uint8 state, bytes32 commit, uint8 reviewers)",
  "event Posted(uint256 indexed jobId, address indexed poster, bytes32 seal, uint256 price, uint64 endsAt)",
  "event Approved(uint256 indexed jobId, uint8 role, address indexed agent, bytes32 commitHash)",
  "event Settled(uint256 indexed jobId, bytes32 commitHash, uint256 paid)",
  "event Refunded(uint256 indexed jobId, uint256 amount, string why)",
  // the contract's refusals, by name, so a reverted call says why rather than showing four bytes
  "error NotPoster()",
  "error NotValidator()",
  "error WrongState()",
  "error SeatFilled()",
  "error SeatEmpty()",
  "error OwnerAlreadySeated()",
  "error WrongDeposit()",
  "error NotTheSeat()",
  "error CommitMismatch()",
  "error PolicyNotMet()",
  "error TooLate()",
  "error TooEarly()",
]);

/** The contract's enum order, named once so nothing else has to know it. */
const ROLE_NUMBER: Record<Role, number> = { lead: 0, builder: 1, reviewer: 2, qa: 3, security: 4 };

export function roleNumber(role: Role): number {
  return ROLE_NUMBER[role];
}

/** What a job looks like once it is on chain. State is the contract's own enum. */
export type JobState = "open" | "working" | "settled" | "refunded";
const STATES: readonly JobState[] = ["open", "working", "settled", "refunded"];

export interface OnChainJob {
  readonly poster: Address;
  readonly price: bigint;
  readonly seal: Hex;
  readonly endsAt: bigint;
  readonly state: JobState;
  readonly commit: Hex;
  readonly reviewers: number;
}

export interface Contract {
  readonly address: Address;
  readonly publicClient: PublicClient;
  readonly wallet: WalletClient;
}

/** Wait for a transaction and refuse to carry on if the chain reverted it. */
async function sent(at: Contract, hash: Hex): Promise<Hex> {
  const receipt = await at.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`the chain rejected ${hash}`);
  return hash;
}

/** One seat that somebody holds: the key that signs for it, and who is behind that key. */
export interface HeldSeat {
  readonly role: Role;
  readonly agent: Address;
  readonly owner: Address;
  readonly approved: boolean;
}

/**
 * Every seat taken on a job, read from the contract, which is the only list of who is in a pod.
 *
 * The contract keeps a row per role, and only the reviewer row can hold more than one.
 */
export async function readSeats(at: Omit<Contract, "wallet">, jobId: bigint): Promise<readonly HeldSeat[]> {
  const rows = await Promise.all(SEATS.map(async (role) => {
    const count = await at.publicClient.readContract({
      address: at.address, abi: podJobsAbi, functionName: "seatCount", args: [jobId, roleNumber(role)],
    });
    return Promise.all(Array.from({ length: Number(count) }, async (_, index) => {
      const seat = await at.publicClient.readContract({
        address: at.address, abi: podJobsAbi, functionName: "seatAt", args: [jobId, roleNumber(role), BigInt(index)],
      });
      return { role, agent: seat.agent, owner: seat.owner, approved: seat.approved };
    }));
  }));
  return rows.flat();
}

/**
 * The widest range of blocks Monad's public node reads events from in one go. Every reading of events
 * here goes in slices this wide, whatever the chain, so what works on a local chain works on Monad.
 */
export const MOST_BLOCKS_A_LOG_READ_COVERS = 100n;

/** How far back the approvals of a commit are looked for: about two hours of Monad's blocks */
export const MOST_BLOCKS_LOOKED_BACK_FOR_APPROVALS = 20_000n;

/** One approval as the contract recorded it: which seat, which key, and when its block was made. */
export interface ApprovalOnChain {
  readonly role: Role;
  readonly agent: Address;
  readonly commit: Hex;
  /** seconds since 1970, the time of the block the approval is in */
  readonly at: bigint;
}

export interface ApprovalsFound {
  /** the latest approval of the commit from each seat asked about, as far back as they were looked for */
  readonly found: readonly ApprovalOnChain[];
  /** the time of the oldest block read: a seat not found approved before it */
  readonly lookedBackTo: bigint;
}

/**
 * When each of these seats approved one commit, read from the contract's own record of it.
 *
 * Read backwards from the newest block, in slices Monad's node allows, and stopped as soon as every
 * seat is found: the approvals a grading needs are the ones that met the policy, which is recent, so
 * this is usually a slice or two rather than the whole chain.
 */
export async function readApprovals(
  at: Omit<Contract, "wallet">, jobId: bigint, commit: Hex, seats: readonly { readonly role: Role; readonly agent: Address }[],
  mostBlocksBack: bigint = MOST_BLOCKS_LOOKED_BACK_FOR_APPROVALS,
): Promise<ApprovalsFound> {
  const key = (role: Role, agent: Address): string => `${role}:${agent.toLowerCase()}`;
  const wanted = new Set(seats.map((seat) => key(seat.role, seat.agent)));
  const found = new Map<string, ApprovalOnChain>();
  const latest = await at.publicClient.getBlockNumber({ cacheTime: 0 });
  const floor = latest > mostBlocksBack ? latest - mostBlocksBack : 0n;
  let to = latest;
  let from = latest;
  while (found.size < wanted.size && to >= floor) {
    from = to - floor >= MOST_BLOCKS_A_LOG_READ_COVERS ? to - MOST_BLOCKS_A_LOG_READ_COVERS + 1n : floor;
    const logs = await at.publicClient.getContractEvents({
      address: at.address, abi: podJobsAbi, eventName: "Approved", args: { jobId }, fromBlock: from, toBlock: to, strict: true,
    });
    // newest first, so each seat is found at its latest approval
    for (const log of [...logs].reverse()) {
      if (log.args.commitHash.toLowerCase() !== commit.toLowerCase()) continue;
      const role = SEATS.find((named) => roleNumber(named) === log.args.role);
      if (!role || !wanted.has(key(role, log.args.agent)) || found.has(key(role, log.args.agent))) continue;
      const block = await at.publicClient.getBlock({ blockHash: log.blockHash });
      found.set(key(role, log.args.agent), { role, agent: log.args.agent, commit: log.args.commitHash, at: block.timestamp });
    }
    if (from === 0n) break;
    to = from - 1n;
  }
  const oldest = await at.publicClient.getBlock({ blockNumber: from });
  return { found: [...found.values()], lookedBackTo: oldest.timestamp };
}

/** What each seat on a job pays and costs to take, read from the contract rather than worked out here. */
export async function readTerms(at: Omit<Contract, "wallet">, jobId: bigint): Promise<Readonly<Record<Role, { readonly pay: bigint; readonly deposit: bigint }>>> {
  const terms = await Promise.all(SEATS.map(async (role) => {
    const [pay, deposit] = await Promise.all([seatPay(at, jobId, role), seatDeposit(at, jobId, role)]);
    return [role, { pay, deposit }] as const;
  }));
  return Object.fromEntries(terms) as Record<Role, { readonly pay: bigint; readonly deposit: bigint }>;
}

export async function readJob(at: Omit<Contract, "wallet">, jobId: bigint): Promise<OnChainJob> {
  const [poster, price, seal, endsAt, state, commit, reviewers] = await at.publicClient.readContract({
    address: at.address, abi: podJobsAbi, functionName: "jobs", args: [jobId],
  });
  return { poster, price, seal, endsAt, state: STATES[state] ?? "open", commit, reviewers };
}

export function seatDeposit(at: Omit<Contract, "wallet">, jobId: bigint, role: Role): Promise<bigint> {
  return at.publicClient.readContract({
    address: at.address, abi: podJobsAbi, functionName: "seatDeposit", args: [jobId, roleNumber(role)],
  });
}

export function seatPay(at: Omit<Contract, "wallet">, jobId: bigint, role: Role): Promise<bigint> {
  return at.publicClient.readContract({
    address: at.address, abi: podJobsAbi, functionName: "seatPay", args: [jobId, roleNumber(role)],
  });
}

export function policyMet(at: Omit<Contract, "wallet">, jobId: bigint, commit: Hex): Promise<boolean> {
  return at.publicClient.readContract({
    address: at.address, abi: podJobsAbi, functionName: "policyMet", args: [jobId, commit],
  });
}

/** Post a job with the money attached, and hand back the id the chain gave it. */
export async function post(at: Contract, input: {
  readonly seal: Hex;
  readonly endsAt: bigint;
  readonly reviewers: number;
  readonly price: bigint;
}): Promise<bigint> {
  const { request, result } = await at.publicClient.simulateContract({
    address: at.address, abi: podJobsAbi, functionName: "post",
    args: [input.seal, input.endsAt, input.reviewers],
    value: input.price,
    account: at.wallet.account!,
  });
  await sent(at, await at.wallet.writeContract(request));
  return result;
}

/**
 * Take a seat, with the deposit the contract asks for.
 *
 * The deposit is read from the chain rather than worked out here: the contract's percentage is the
 * one that counts, and a client that calculates its own would eventually disagree with it.
 */
export async function takeSeat(at: Contract, jobId: bigint, role: Role, owner: Address): Promise<Hex> {
  const deposit = await seatDeposit(at, jobId, role);
  const { request } = await at.publicClient.simulateContract({
    address: at.address, abi: podJobsAbi, functionName: "takeSeat",
    args: [jobId, roleNumber(role), owner],
    value: deposit,
    account: at.wallet.account!,
  });
  return sent(at, await at.wallet.writeContract(request));
}

export async function approve(at: Contract, jobId: bigint, role: Role, commit: Hex): Promise<Hex> {
  const { request } = await at.publicClient.simulateContract({
    address: at.address, abi: podJobsAbi, functionName: "approve",
    args: [jobId, roleNumber(role), commit],
    account: at.wallet.account!,
  });
  return sent(at, await at.wallet.writeContract(request));
}

/**
 * The verdict reaching the money.
 *
 * Only the validator the contract was deployed with may call this, and a verdict that did not pass
 * refunds the poster rather than paying anyone. Both of those are the contract's rules, not ours.
 */
export async function settle(at: Contract, jobId: bigint, commit: Hex, passed: boolean): Promise<Hex> {
  const { request } = await at.publicClient.simulateContract({
    address: at.address, abi: podJobsAbi, functionName: "settle",
    args: [jobId, commit, passed],
    account: at.wallet.account!,
  });
  return sent(at, await at.wallet.writeContract(request));
}
