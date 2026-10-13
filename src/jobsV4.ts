/**
 * Talking to PodJobsV4, the contract on which the lead names who is paid.
 *
 * Everything PodJobsV3 lets anybody ask or do is asked and done the same way here, through jobsV3.ts,
 * jobsV2.ts and jobs.ts. This is only what the fourth contract adds: a seat's yes carries the
 * fingerprint of the account it wrote of what it did; the lead speaks last, stands behind the work by
 * concluding its review, and names which of the seats behind it earned their pay; pay kept from a
 * seat goes back to the poster, and is counted for the seat and for the lead who kept it.
 *
 * Like the others, it adds no rules of its own: the contract decides.
 */
import { keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { answersTo, roleNumber, type Contract } from "./jobs.ts";
import type { Role } from "./job.ts";
import type { ContractV2 } from "./jobsV2.ts";

export const podJobsV4Abi = parseAbi([
  "function approve(uint256 jobId, uint8 role, bytes32 commitHash, bytes32 account)",
  "function conclude(uint256 jobId, bytes32 commitHash, uint256 earnedSeats, bytes32 account)",
  "function seatBit(uint8 role, uint256 index) pure returns (uint256)",
  "function earns(uint256 jobId, uint8 role, uint256 index) view returns (bool)",
  "function accounts(uint256 jobId, uint8 role, uint256 index) view returns (bytes32)",
  "function concluded(uint256) view returns (bool)",
  "function earned(uint256) view returns (uint256)",
  "function cuts(address) view returns (uint32 withheld, uint32 withholdings)",
  "event Accounted(uint256 indexed jobId, uint8 role, address indexed agent, bytes32 commitHash, bytes32 account)",
  "event Concluded(uint256 indexed jobId, address indexed lead, bytes32 commitHash, uint256 earned, bytes32 account)",
  "event PayKept(uint256 indexed jobId, uint8 role, address indexed agent, uint256 amount)",
  // the contract's refusals these calls can meet, by name, so a reverted call says why
  "error BuildersDoNotApprove()",
  "error LeadsConclude()",
  "error NoAccount()",
  "error AccountBound()",
  "error LeadComesFirst()",
  "error NotBehind()",
  "error WrongState()",
  "error CommitMismatch()",
  "error NotTheSeat()",
  "error Locked()",
  "error TooLate()",
  "error TooEarly()",
]);

/** The seats a lead may name or leave out: the builder's pay follows the work, and the lead's its own conclusion. */
export const NAMED_BY_THE_LEAD = ["reviewer", "qa", "security"] as const satisfies readonly Role[];
export type NamedByTheLead = (typeof NAMED_BY_THE_LEAD)[number];

/** How many seats of one role the contract's bits leave room for, which is more than any role has */
const SEATS_TO_A_ROLE = 8n;

/**
 * The bit that stands for a seat in what the lead names: eight to a role, in the contract's order of
 * roles. The contract's own rule, said here so a lead need not ask the chain for each seat; a test
 * holds the two together.
 */
export function seatBit(role: NamedByTheLead, index: number): bigint {
  return 1n << (BigInt(roleNumber(role)) * SEATS_TO_A_ROLE + BigInt(index));
}

/** A seat as the lead names it: its role, and which seat of that role when a job has several. */
export interface NamedSeat {
  readonly role: NamedByTheLead;
  readonly index: number;
}

/** The seats a lead names, as the one number the contract takes. */
export function earnedSeats(seats: readonly NamedSeat[]): bigint {
  return seats.reduce((bits, seat) => bits | seatBit(seat.role, seat.index), 0n);
}

/**
 * The fingerprint of a written account, which is what a seat binds to its yes and a lead to its
 * conclusion: of the exact sentence the seat signed for its note, so anybody holding the published
 * note can make the same fingerprint and see it is the one on the chain.
 */
export function accountOf(signedNote: string): Hex {
  return keccak256(toHex(signedNote));
}

/** Wait for a transaction and refuse to carry on if the chain reverted it. */
async function sent(at: Contract, hash: Hex): Promise<Hex> {
  const receipt = await at.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`the chain rejected ${hash}`);
  return hash;
}

/**
 * Whether the lead names who is paid on this contract: asked of the contract itself, which says
 * whether a job's review was concluded only if a lead can conclude one there.
 */
export function doesTheLeadNameWhoIsPaid(at: ContractV2): Promise<boolean> {
  return answersTo(at.publicClient.readContract({ address: at.address, abi: podJobsV4Abi, functionName: "concluded", args: [0n] }));
}

/** Stand behind the commit put forward, as a reviewer, QA or security seat, binding the account written of it. */
export async function approveWithAccount(at: Contract, jobId: bigint, role: Role, commit: Hex, account: Hex): Promise<Hex> {
  const { request } = await at.publicClient.simulateContract({
    address: at.address, abi: podJobsV4Abi, functionName: "approve",
    args: [jobId, roleNumber(role), commit, account], account: at.wallet.account!,
  });
  return sent(at, await at.wallet.writeContract(request));
}

/** The lead concludes the review: it stands behind the commit, names the seats that earned their pay, and binds its reasons. */
export async function conclude(at: Contract, jobId: bigint, commit: Hex, seats: readonly NamedSeat[], account: Hex): Promise<Hex> {
  const { request } = await at.publicClient.simulateContract({
    address: at.address, abi: podJobsV4Abi, functionName: "conclude",
    args: [jobId, commit, earnedSeats(seats), account], account: at.wallet.account!,
  });
  return sent(at, await at.wallet.writeContract(request));
}

/** Whether the lead has concluded the review of the commit put forward on a job. */
export function readConcluded(at: ContractV2, jobId: bigint): Promise<boolean> {
  return at.publicClient.readContract({ address: at.address, abi: podJobsV4Abi, functionName: "concluded", args: [jobId] });
}

/** Whether a seat would be paid if the pod were: behind the work, and named where a lead concluded. */
export function readEarns(at: ContractV2, jobId: bigint, role: Role, index: number): Promise<boolean> {
  return at.publicClient.readContract({ address: at.address, abi: podJobsV4Abi, functionName: "earns", args: [jobId, roleNumber(role), BigInt(index)] });
}

/** The fingerprint a seat bound to its yes, or the lead to its conclusion; nothing where none is bound. */
export async function readAccount(at: ContractV2, jobId: bigint, role: Role, index: number): Promise<Hex | undefined> {
  const account = await at.publicClient.readContract({ address: at.address, abi: podJobsV4Abi, functionName: "accounts", args: [jobId, roleNumber(role), BigInt(index)] });
  return /^0x0+$/.test(account) ? undefined : account;
}

/** Pay kept by a lead, as the contract counts it for one agent. */
export interface CutRecord {
  /** seats this agent stood behind work from and was kept from the pay of */
  readonly withheld: number;
  /** jobs on which, as the lead, it kept pay from at least one seat */
  readonly withholdings: number;
}

export async function readCutRecord(at: ContractV2, agent: Address): Promise<CutRecord> {
  const [withheld, withholdings] = await at.publicClient.readContract({ address: at.address, abi: podJobsV4Abi, functionName: "cuts", args: [agent] });
  return { withheld, withholdings };
}
