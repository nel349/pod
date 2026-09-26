import { z } from "zod";
import { shareOf, type Role } from "../../../job.ts";
import { NoteSchema, type Note } from "../../../note.ts";
import { repeatCommand } from "../../../jobpage.ts";
import { standingWords } from "../../../gallery.ts";
import type { OnChainJob } from "../../../posting.ts";
import { checksPath, claimPath, receiptFilePath, receiptPath } from "../../../routes.ts";
import { SEATS } from "../../../seal.ts";
import type { SignedReceipt } from "../../../receipt.ts";
import type { JobRecord } from "../../../store.ts";
import { MODES, VerdictSchema, WEI } from "./kinds.ts";
import { MoneyViewSchema, moneyOf } from "./money.ts";

/** One seat of a pod: who holds it, what the seat is paid, and when it approved the work. */
export const SeatViewSchema = z.object({
  role: z.enum(SEATS),
  agent: z.string().optional(),
  /** in wei: the seat's share of the price */
  pay: WEI,
  approvedAt: z.string().optional(),
});
export type SeatView = z.infer<typeof SeatViewSchema>;

/** A job's title: its number, who holds it now, and where its holder claims the repository. */
export const TitleViewSchema = z.object({
  tokenId: z.string(),
  /** as the chain says now; absent when the chain could not be read */
  holder: z.string().optional(),
  claim: z.string().optional(),
  invited: z.object({ account: z.string(), by: z.string(), at: z.string() }).optional(),
});
export type TitleView = z.infer<typeof TitleViewSchema>;

const CheckSaidSchema = z.object({ says: z.string(), hidden: z.boolean(), exitCode: z.number().int().optional() });

/** One job, opened: everything its page shows. */
export const JobViewSchema = z.object({
  jobId: z.string(),
  idea: z.string(),
  verdict: VerdictSchema,
  standing: z.string(),
  mode: z.enum(MODES),
  price: WEI,
  seal: z.string(),
  commit: z.string().optional(),
  howItIsAsked: z.string().optional(),
  /** how many checks nobody but the grader may read until the verdict */
  sealedChecks: z.number().int(),
  /** the checks anybody may read now: the visible ones while the job runs, all of them after */
  checks: z.array(CheckSaidSchema),
  checksPath: z.string(),
  seats: z.array(SeatViewSchema),
  /** what the pod said to each other, published with the verdict and not before */
  notes: z.array(NoteSchema),
  receipt: z.object({ page: z.string(), file: z.string(), finishedAt: z.string(), repeat: z.string() }).optional(),
  chain: z.object({ jobId: z.string(), jobs: z.string(), settled: z.string().optional(), minted: z.string().optional() }).optional(),
  money: MoneyViewSchema.optional(),
  title: TitleViewSchema.optional(),
  repository: z.string().optional(),
  /** who paid for it, when the chain could say */
  poster: z.string().optional(),
  /** why the worker is holding back a job whose pod says it is done */
  waitingBecause: z.string().optional(),
});
export type JobView = z.infer<typeof JobViewSchema>;

/** What the chain said about a job when its page was drawn, read by whoever draws it. */
export interface ChainSays {
  readonly poster?: string;
  readonly holder?: string;
  /** the job on the contract now, read only when the record alone cannot say where the money is */
  readonly onChain?: Pick<OnChainJob, "state" | "endsAt">;
}

export function jobView(record: JobRecord, notes: readonly Note[], chainSays: ChainSays): JobView {
  const { tile } = record;
  const isRunning = tile.verdict === "running";
  const money = moneyOf(record, chainSays.onChain);
  const tokenId = record.chain?.tokenId;
  return {
    jobId: tile.jobId, idea: tile.idea, verdict: tile.verdict, standing: standingWords(tile), mode: tile.mode,
    price: tile.price.toString(), seal: record.seal,
    ...(tile.commit ? { commit: tile.commit } : {}),
    ...(record.brief?.howItIsAsked ? { howItIsAsked: record.brief.howItIsAsked } : {}),
    sealedChecks: isRunning ? record.brief?.sealedChecks ?? record.checksSaid.filter((check) => check.hidden).length : 0,
    checks: isRunning ? record.checksSaid.filter((check) => !check.hidden) : [...record.checksSaid],
    checksPath: checksPath(tile.jobId),
    seats: seatsOf(record),
    notes: isRunning ? [] : [...notes],
    ...(record.signed ? { receipt: receiptParts(record.jobId, record.signed, record.repository) } : {}),
    ...(record.chain ? { chain: {
      jobId: record.chain.jobId, jobs: record.chain.jobs,
      ...(record.chain.settled ? { settled: record.chain.settled } : {}),
      ...(record.chain.minted ? { minted: record.chain.minted } : {}),
    } } : {}),
    ...(money ? { money } : {}),
    ...(tokenId !== undefined ? { title: {
      tokenId,
      ...(chainSays.holder ? { holder: chainSays.holder } : {}),
      ...(record.repository ? { claim: claimPath(tile.jobId) } : {}),
      ...(record.invited ? { invited: record.invited } : {}),
    } } : {}),
    ...(record.repository ? { repository: record.repository } : {}),
    ...(chainSays.poster ? { poster: chainSays.poster } : {}),
    ...(record.waitingBecause && isRunning ? { waitingBecause: record.waitingBecause } : {}),
  };
}

function receiptParts(jobId: string, signed: SignedReceipt, repository: string | undefined): NonNullable<JobView["receipt"]> {
  return {
    page: receiptPath(jobId), file: receiptFilePath(jobId), finishedAt: signed.receipt.finishedAt,
    repeat: repeatCommand(signed.receipt, checksPath(jobId), repository),
  };
}

/**
 * Every seat, taken or open, with the share of the price it is paid. Jobs posted here have one seat
 * of each kind, so each share is the contract's share for that seat.
 */
function seatsOf(record: JobRecord): SeatView[] {
  const { tile, approvals } = record;
  return SEATS.map((role: Role): SeatView => {
    const pay = shareOf(tile.price, role).toString();
    const seat = tile.pod.find((one) => one.role === role);
    if (!seat) return { role, pay };
    const approval = approvals.find((one) => one.role === role && one.agent.toLowerCase() === seat.agent.toLowerCase());
    return { role, agent: seat.agent, pay, ...(approval ? { approvedAt: approval.at } : {}) };
  });
}
