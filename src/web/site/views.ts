/**
 * What each server-drawn page shows, worked out from a job's record, as plain data.
 *
 * The same data draws the page on the server and brings it to life in the browser, so both say exactly
 * the same thing. It crosses the network, in the page and from the job's own address as it is
 * followed, so it is a schema: the browser reads it through these rather than trusting it. Money is in
 * wei as a decimal string and times are ISO strings, because JSON has neither.
 */
import { z } from "zod";
import { shareOf, type Role } from "../../job.ts";
import { MarketConfigSchema } from "../../market.ts";
import { NoteSchema, type Note } from "../../note.ts";
import { repeatCommand } from "../../jobpage.ts";
import { standingWords, type Tile } from "../../gallery.ts";
import type { OnChainJob } from "../../posting.ts";
import { checksPath, claimPath, receiptFilePath, receiptPath, refundPath } from "../../routes.ts";
import { SEATS } from "../../seal.ts";
import type { SignedReceipt } from "../../receipt.ts";
import type { JobRecord } from "../../store.ts";

const VERDICTS = ["passed", "failed", "not-reproducible", "running"] as const satisfies readonly Tile["verdict"][];
const MODES = ["flash", "sprint", "project"] as const satisfies readonly Tile["mode"][];
const WEI = z.string().regex(/^[0-9]+$/, "an amount in wei");
const WHEN = z.iso.datetime({ offset: true });

export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof VerdictSchema>;

/** A job on the wall, an agent's page or your own page. */
export const TileViewSchema = z.object({
  jobId: z.string(),
  idea: z.string(),
  verdict: VerdictSchema,
  standing: z.string(),
  mode: z.enum(MODES),
  price: WEI,
  commit: z.string().optional(),
  seconds: z.number().optional(),
  pod: z.array(z.object({ role: z.string(), agent: z.string() })),
  openSeats: z.number().int(),
  /** the receipt's page, when there is one */
  receipt: z.string().optional(),
});
export type TileView = z.infer<typeof TileViewSchema>;

/** @param hasReceipt whether a signed receipt is kept for it: a tile that names one is not enough */
export function tileView(tile: Tile, hasReceipt: boolean): TileView {
  return {
    jobId: tile.jobId, idea: tile.idea, verdict: tile.verdict, standing: standingWords(tile), mode: tile.mode,
    price: tile.price.toString(),
    ...(tile.commit ? { commit: tile.commit } : {}),
    ...(tile.seconds ? { seconds: tile.seconds } : {}),
    pod: tile.pod.map((seat) => ({ role: seat.role, agent: seat.agent })),
    openSeats: tile.verdict === "running" ? SEATS.filter((role) => !tile.pod.some((seat) => seat.role === role)).length : 0,
    ...(hasReceipt ? { receipt: receiptPath(tile.jobId) } : {}),
  };
}

/** One seat of a pod: who holds it, what the seat is paid, and when it approved the work. */
export const SeatViewSchema = z.object({
  role: z.enum(SEATS),
  agent: z.string().optional(),
  /** in wei: the seat's share of the price */
  pay: WEI,
  approvedAt: z.string().optional(),
});
export type SeatView = z.infer<typeof SeatViewSchema>;

/**
 * Where the poster's money is. It sits in the contract while the pod works; the verdict pays the pod
 * or gives it back; and money nobody settled is the poster's to take back once the window closes.
 */
export const MoneyViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("held"), endsAt: WHEN, takeBack: z.string() }),
  z.object({ kind: z.literal("returnable"), takeBack: z.string() }),
  z.object({ kind: z.literal("paid") }),
  z.object({ kind: z.literal("refunded") }),
]);
export type MoneyView = z.infer<typeof MoneyViewSchema>;

/** Money held past its window is returnable: the page works this out again as the clock moves. */
export function moneyAt(money: MoneyView, now: Date): MoneyView {
  return money.kind === "held" && new Date(money.endsAt) <= now ? { kind: "returnable", takeBack: money.takeBack } : money;
}

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

/**
 * Whether the record alone can say where the money is. A job still in its window, or settled, can;
 * one past its window, or one the runs disagreed on, may have been taken back since, and only the
 * contract knows.
 */
export function needsTheChainForMoney(record: JobRecord, now: Date): boolean {
  if (!record.chain || record.chain.settled) return false;
  if (record.tile.verdict === "not-reproducible") return true;
  return record.tile.verdict === "running" && (!record.brief || new Date(record.brief.endsAt) <= now);
}

function moneyOf(record: JobRecord, onChain: ChainSays["onChain"]): MoneyView | undefined {
  if (!record.chain) return undefined;
  const takeBack = refundPath(record.jobId);
  if (onChain?.state === "refunded") return { kind: "refunded" };
  if (onChain?.state === "settled") return record.tile.verdict === "failed" ? { kind: "refunded" } : { kind: "paid" };
  if (record.tile.verdict === "passed") return { kind: "paid" };
  if (record.tile.verdict === "failed") return { kind: "refunded" };
  const endsAt = onChain ? new Date(Number(onChain.endsAt) * 1000).toISOString() : record.brief?.endsAt;
  return endsAt ? { kind: "held", endsAt, takeBack } : { kind: "returnable", takeBack };
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

/** A job on your own page, with what its money and its title let you do. */
export const YoursEntrySchema = z.object({
  tile: TileViewSchema,
  money: MoneyViewSchema.optional(),
  title: TitleViewSchema.optional(),
});
export type YoursEntry = z.infer<typeof YoursEntrySchema>;

/** A wallet's own page: the jobs it paid for, and the titles it holds. */
export const YoursViewSchema = z.object({
  address: z.string(),
  posted: z.array(YoursEntrySchema),
  holds: z.array(YoursEntrySchema),
});
export type YoursView = z.infer<typeof YoursViewSchema>;

export function yoursEntry(record: JobRecord, chainSays: ChainSays): YoursEntry {
  const view = jobView(record, [], chainSays);
  return { tile: tileView(record.tile, record.signed !== undefined), ...(view.money ? { money: view.money } : {}), ...(view.title ? { title: view.title } : {}) };
}

/** A receipt, for a person: what was run, what it said, and the signed file behind it. */
export const ReceiptViewSchema = z.object({
  jobId: z.string(),
  idea: z.string(),
  job: z.string(),
  file: z.string(),
  verdict: z.enum(["passed", "failed", "not-reproducible"]),
  commit: z.string(),
  repository: z.string(),
  tree: z.string(),
  image: z.string(),
  start: z.string(),
  runs: z.number().int(),
  checks: z.array(z.object({ says: z.string(), command: z.string(), exitCode: z.number().int(), seconds: z.number(), hidden: z.boolean() })),
  allowedHosts: z.array(z.string()),
  undeclaredCalls: z.array(z.string()),
  runner: z.string(),
  finishedAt: z.string(),
  hash: z.string(),
  signature: z.string(),
});
export type ReceiptView = z.infer<typeof ReceiptViewSchema>;

export function receiptView(record: JobRecord, signed: SignedReceipt, job: string): ReceiptView {
  const { receipt } = signed;
  return {
    jobId: record.jobId, idea: record.tile.idea, job, file: receiptFilePath(record.jobId),
    verdict: receipt.verdict, commit: receipt.commit, repository: receipt.repository, tree: receipt.tree,
    image: receipt.image, start: receipt.start, runs: receipt.runs,
    checks: receipt.checks.map((check) => ({ ...check })),
    allowedHosts: [...receipt.allowedHosts], undeclaredCalls: [...receipt.undeclaredCalls],
    runner: receipt.runner, finishedAt: receipt.finishedAt, hash: signed.hash, signature: signed.signature,
  };
}

/** An agent's record in one seat, counted rather than averaged. */
export const RoleRecordSchema = z.object({
  role: z.string(), passed: z.number().int(), failed: z.number().int(), unreproducible: z.number().int(), running: z.number().int(),
});

export const SitePageSchema = z.discriminatedUnion("page", [
  z.object({ page: z.literal("wall"), tiles: z.array(TileViewSchema) }),
  z.object({ page: z.literal("job"), job: JobViewSchema }),
  z.object({ page: z.literal("agent"), agent: z.string(), record: z.array(RoleRecordSchema), tiles: z.array(TileViewSchema) }),
  z.object({ page: z.literal("receipt"), receipt: ReceiptViewSchema }),
  z.object({ page: z.literal("yours") }),
  z.object({ page: z.literal("missing"), why: z.string() }),
]);
export type SitePage = z.infer<typeof SitePageSchema>;

/** What every page carries besides its own: the chain it answers to, for the wallet, and when it was drawn. */
export const SiteCommonSchema = z.object({
  market: MarketConfigSchema.optional(),
  /** what the money is called, which a server with no chain still has to name */
  coin: z.string(),
  /** the server's time when it drew the page, so the browser's first drawing says the same */
  drawnAt: WHEN,
});
export type SiteCommon = z.infer<typeof SiteCommonSchema>;

export const SiteDataSchema = z.intersection(SitePageSchema, SiteCommonSchema);
export type SiteData = z.infer<typeof SiteDataSchema>;
