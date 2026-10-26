import { z } from "zod";
import { shareOf, type Role } from "../../../job.ts";
import { NoteSchema, type Note } from "../../../note.ts";
import { repeatCommand } from "../../../jobpage.ts";
import type { Tile } from "../../../gallery.ts";
import { standingOf } from "./tile.ts";
import type { OnChainJob } from "../../../posting.ts";
import { checksPath, claimPath, receiptFilePath, receiptPath, referencePath } from "../../../routes.ts";
import { SEATS } from "../../../seal.ts";
import { hasTriage, QuestionSchema, questionsOf, type TriageAnswer } from "../../../triage.ts";
import type { SignedReceipt } from "../../../receipt.ts";
import { isCodePublic, isPublished, type JobRecord } from "../../../store.ts";
import { AgentRecordSchema, answerOf, AnswerSchema, deliveryOf, DeliveryViewSchema, PosterRecordSchema, type AgentRecordView, type PosterRecordView } from "./answer.ts";
import { MODES, VerdictSchema, WEI } from "./kinds.ts";
import { MoneyViewSchema, moneyOf } from "./money.ts";

/** One seat of a pod: who holds it, what the seat is paid, and when it approved the work. */
export const SeatViewSchema = z.object({
  role: z.enum(SEATS),
  agent: z.string().optional(),
  /** in wei: the seat's share of the price */
  pay: WEI,
  approvedAt: z.string().optional(),
  /** it stands behind the work, and the lead, naming who is paid, did not name it */
  isKeptFromPay: z.boolean().optional(),
  /** how the jobs its agent held a seat on have ended, where the contract keeps count */
  record: AgentRecordSchema.optional(),
});
export type SeatView = z.infer<typeof SeatViewSchema>;

/** A job's title: its number, who holds it now, and where its holder claims the repository. */
export const TitleViewSchema = z.object({
  tokenId: z.string(),
  /** as the chain says now; absent when the chain could not be read */
  holder: z.string().optional(),
  claim: z.string().optional(),
  invited: z.object({ account: z.string(), by: z.string(), at: z.string() }).optional(),
  /** who has the code on GitHub, once it has left POD's account: nothing is left to claim here */
  handed: z.object({ account: z.string(), at: z.string() }).optional(),
});
export type TitleView = z.infer<typeof TitleViewSchema>;

const CheckSaidSchema = z.object({ says: z.string(), hidden: z.boolean(), exitCode: z.number().int().optional(), said: z.string().optional(), answered: z.string().optional() });

/** One job, opened: everything its page shows. */
export const JobViewSchema = z.object({
  jobId: z.string(),
  idea: z.string(),
  verdict: VerdictSchema,
  /** where it stands with its poster, once delivered on the contract where they have the last word */
  answer: AnswerSchema.optional(),
  /** whether its poster has the last word on what its pod delivers, which its contract decides */
  hasLastWord: z.boolean().optional(),
  /** the lead names who is paid on its contract: each seat leaves an account, and the lead says who earned their pay */
  leadNames: z.boolean().optional(),
  /** its delivery: until when the poster may answer, what a refusal leaves the pod, and how it ended */
  delivery: DeliveryViewSchema.optional(),
  standing: z.string(),
  mode: z.enum(MODES),
  price: WEI,
  seal: z.string(),
  commit: z.string().optional(),
  howItIsAsked: z.string().optional(),
  /** what the poster pointed the pod at, each with where to open it */
  references: z.array(z.object({ name: z.string(), type: z.string(), bytes: z.number(), url: z.string(), from: z.string() })).optional(),
  /** whether a job of this length lets its pod ask its poster before building: a week does, less does not */
  asksItsPoster: z.boolean().optional(),
  /** what its pod asked its poster, in the order asked, each with the answer once there is one */
  questions: z.array(QuestionSchema).optional(),
  /** how many checks nobody but the grader may read until the verdict */
  sealedChecks: z.number().int(),
  /** the lines their poster kept to judge themselves, which no check decides */
  mine: z.array(z.string()).optional(),
  /** the checks anybody may read now: the visible ones while the job runs, all of them after */
  checks: z.array(CheckSaidSchema),
  checksPath: z.string(),
  seats: z.array(SeatViewSchema),
  /** what the pod said to each other, published with the verdict and not before */
  notes: z.array(NoteSchema),
  receipt: z.object({ page: z.string(), file: z.string(), finishedAt: z.string(), repeat: z.string() }).optional(),
  chain: z.object({
    jobId: z.string(), jobs: z.string(), settled: z.string().optional(), minted: z.string().optional(),
    /** the validator's report of what the checks found, where the poster has the last word */
    reported: z.string().optional(),
  }).optional(),
  money: MoneyViewSchema.optional(),
  title: TitleViewSchema.optional(),
  repository: z.string().optional(),
  /** the pod's code cannot be fetched yet: its poster has the last word and has not accepted it */
  isCodePrivate: z.boolean().optional(),
  /** where the delivered website is live, or that it was taken down, or why it never went live */
  live: z.union([
    z.object({ isDown: z.literal(false), url: z.string(), host: z.string() }),
    // taken down: its old address is not handed on, since nothing answers there now
    z.object({ isDown: z.literal(true), host: z.string() }),
  ]).optional(),
  notLiveBecause: z.string().optional(),
  /** who paid for it, when the chain could say */
  poster: z.string().optional(),
  /** how the jobs its poster paid for have ended, where the contract keeps count */
  posterRecord: PosterRecordSchema.optional(),
  /** why the worker is holding back a job whose pod says it is done */
  waitingBecause: z.string().optional(),
  /** work its builder has put forward, while the other seats may still sign on and before it is graded */
  review: z.object({
    putForwardAt: z.string().optional(),
    reviewBy: z.string(),
    /** the seats other than its builder that stand behind it so far, and the ones taken that do not yet */
    behind: z.array(z.enum(SEATS)),
    notYet: z.array(z.enum(SEATS)),
  }).optional(),
  /** why it was taken off the wall, when it was */
  retired: z.string().optional(),
});
export type JobView = z.infer<typeof JobViewSchema>;

/** What the chain said about a job when its page was drawn, read by whoever draws it. */
export interface ChainSays {
  readonly poster?: string;
  readonly holder?: string;
  /** the job on the contract now, read only when the record alone cannot say where the money is */
  readonly onChain?: Pick<OnChainJob, "state" | "endsAt">;
  /** the job is on a contract that lets its poster take the money back at once while nobody is seated */
  readonly takesBackBeforeASeat?: boolean;
  /** how its poster's jobs have ended, where the contract keeps count */
  readonly posterRecord?: PosterRecordView;
  /** how each seated agent's jobs have ended, by the agent's address in lower case, where the contract keeps count */
  readonly agentRecords?: Readonly<Record<string, AgentRecordView>>;
}

/**
 * @param answers what the job's poster answered its pod. Questions are asked in the open, so they are
 *                shown while the job runs, though the rest of the pod's notes wait for the verdict
 */
export function jobView(record: JobRecord, notes: readonly Note[], chainSays: ChainSays, answers: readonly TriageAnswer[] = []): JobView {
  // money taken back before any verdict closes the job, whether or not the worker has written it down yet
  const isWithdrawn = record.tile.verdict === "running" && chainSays.onChain?.state === "refunded";
  const tile: Tile = isWithdrawn ? { ...record.tile, verdict: "withdrawn" } : record.tile;
  const isRunning = tile.verdict === "running";
  // what is sealed follows the one publishing rule, which the server serves the checks and notes by
  const isSealed = !isPublished(record);
  const money = moneyOf(record, chainSays.onChain, chainSays.takesBackBeforeASeat === true);
  const tokenId = record.chain?.tokenId;
  const answer = isSealed ? undefined : answerOf(record);
  const delivery = isSealed ? undefined : deliveryOf(record);
  const asksItsPoster = hasTriage(tile.mode) && record.brief !== undefined;
  const questions = record.brief ? questionsOf({ mode: tile.mode, endsAt: new Date(record.brief.endsAt) }, notes, answers) : [];
  return {
    jobId: tile.jobId, idea: tile.idea, verdict: tile.verdict,
    ...(answer ? { answer } : {}),
    ...(record.chain?.lastWord ? { hasLastWord: true } : {}),
    ...(record.chain?.leadNames ? { leadNames: true } : {}),
    ...(delivery ? { delivery } : {}),
    standing: standingOf(tile, answer), mode: tile.mode,
    price: tile.price.toString(), seal: record.seal,
    ...(tile.commit ? { commit: tile.commit } : {}),
    ...(record.brief?.howItIsAsked ? { howItIsAsked: record.brief.howItIsAsked } : {}),
    ...(record.brief?.references?.length
      ? { references: record.brief.references.map(({ name, type, bytes, from }) => ({ name, type, bytes, from, url: referencePath(record.jobId, name) })) }
      : {}),
    ...(asksItsPoster ? { asksItsPoster: true } : {}),
    ...(questions.length > 0 ? { questions: [...questions] } : {}),
    sealedChecks: isSealed ? record.brief?.sealedChecks ?? record.checksSaid.filter((check) => check.hidden).length : 0,
    ...(record.brief?.mine?.length ? { mine: [...record.brief.mine] } : {}),
    checks: isSealed ? record.checksSaid.filter((check) => !check.hidden) : [...record.checksSaid],
    checksPath: checksPath(tile.jobId),
    seats: seatsOf(record, chainSays.agentRecords),
    notes: isSealed ? [] : [...notes],
    ...(record.signed ? { receipt: receiptParts(record.jobId, record.signed, record.repository) } : {}),
    ...(record.chain ? { chain: {
      jobId: record.chain.jobId, jobs: record.chain.jobs,
      ...(record.chain.settled ? { settled: record.chain.settled } : {}),
      ...(record.chain.minted ? { minted: record.chain.minted } : {}),
      ...(record.chain.reported ? { reported: record.chain.reported } : {}),
    } } : {}),
    ...(money ? { money } : {}),
    ...(tokenId !== undefined ? { title: {
      tokenId,
      ...(chainSays.holder ? { holder: chainSays.holder } : {}),
      // once the code has moved, the claim page has one thing left to give: a live website's link, to its holder
      ...(record.repository && (!record.handed || (record.live && !record.live.removedAt && !record.live.takenAt)) ? { claim: claimPath(tile.jobId) } : {}),
      ...(record.invited && !record.handed ? { invited: record.invited } : {}),
      ...(record.handed ? { handed: record.handed } : {}),
    } } : {}),
    ...(record.repository ? { repository: record.repository } : {}),
    ...(isCodePublic(record) ? {} : { isCodePrivate: true }),
    ...(record.live && !isSealed ? { live: liveView(record.live) } : {}),
    ...(record.notLiveBecause && !isSealed ? { notLiveBecause: record.notLiveBecause } : {}),
    ...(record.review && record.tile.verdict === "running" ? { review: reviewView(record.review, record.tile.pod) } : {}),
    ...(chainSays.poster ? { poster: chainSays.poster } : {}),
    ...(chainSays.posterRecord ? { posterRecord: chainSays.posterRecord } : {}),
    ...(record.waitingBecause && isRunning ? { waitingBecause: record.waitingBecause } : {}),
    ...(record.retired ? { retired: record.retired.why } : {}),
  };
}

/** Work under review, as its page says it: who other than its builder stands behind it, and who has yet to say. */
function reviewView(review: NonNullable<JobRecord["review"]>, pod: Tile["pod"]): NonNullable<JobView["review"]> {
  const others = SEATS.filter((role) => role !== "builder" && pod.some((seat) => seat.role === role));
  return {
    ...(review.putForwardAt ? { putForwardAt: review.putForwardAt } : {}),
    reviewBy: review.reviewBy,
    behind: others.filter((role) => review.behind.includes(role)),
    notYet: others.filter((role) => !review.behind.includes(role)),
  };
}

function liveView(live: NonNullable<JobRecord["live"]>): NonNullable<JobView["live"]> {
  return live.removedAt === undefined ? { isDown: false, url: live.url, host: live.host } : { isDown: true, host: live.host };
}

function receiptParts(jobId: string, signed: SignedReceipt, repository: string | undefined): NonNullable<JobView["receipt"]> {
  return {
    page: receiptPath(jobId), file: receiptFilePath(jobId), finishedAt: signed.receipt.finishedAt,
    repeat: repeatCommand(signed.receipt, jobId, repository),
  };
}

/**
 * Every seat, taken or open, with the share of the price it is paid. Jobs posted here have one seat
 * of each kind, so each share is the contract's share for that seat.
 */
function seatsOf(record: JobRecord, records: ChainSays["agentRecords"] = {}): SeatView[] {
  const { tile, approvals } = record;
  return SEATS.map((role: Role): SeatView => {
    const pay = shareOf(tile.price, role).toString();
    const seat = tile.pod.find((one) => one.role === role);
    if (!seat) return { role, pay };
    const approval = approvals.find((one) => one.role === role && one.agent.toLowerCase() === seat.agent.toLowerCase());
    const counted = records[seat.agent.toLowerCase()];
    return { role, agent: seat.agent, pay, ...(approval ? { approvedAt: approval.at } : {}), ...(approval?.isKeptFromPay ? { isKeptFromPay: true } : {}), ...(counted ? { record: counted } : {}) };
  });
}
