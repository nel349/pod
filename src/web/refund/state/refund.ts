/**
 * What the refund page knows and says, with no browser and no chain: where a job stands for its
 * poster's money, and every sentence the page shows.
 *
 * The contract gives a poster their money back once the window has closed and the job was never
 * settled: nobody finished, a seat stayed empty, or the runs disagreed and the grader held it. Work
 * that failed is refunded by the grader on its own, and work that passed was paid for.
 */
import { formatEther, isAddress, isAddressEqual, type Address } from "viem";
import { z } from "zod";
import type { JobState } from "../../../jobs.ts";
import type { MarketConfig } from "../../../market.ts";
import { preparingPagePath, QUERY, ROUTES } from "../../../routes.ts";
import { shortAddress } from "../../shared/copy.ts";

const AddressSchema = z.string().refine((value): value is Address => isAddress(value), "an address");

/** The job, as the server keeps it: enough to find it on the chain, the contract it is on included */
export const RefundableSchema = z.object({ jobId: z.string(), idea: z.string(), onChainId: z.string().regex(/^[0-9]+$/), jobs: AddressSchema });
export type Refundable = z.infer<typeof RefundableSchema>;
export const WhySchema = z.object({ why: z.string() });

/** The job as the chain has it right now, and the chain's own time */
export interface OnChainNow {
  readonly poster: Address;
  readonly price: bigint;
  readonly endsAt: bigint;
  readonly state: JobState;
  readonly now: bigint;
  /** the contract the job was read from, which is the one the poster's wallet is asked to call */
  readonly jobs: Address;
  /** the job's page on the wall, once it is on the wall */
  readonly page?: string;
}

/**
 * Which way out the job's contract has. The first contract gives the money back once the window has
 * closed. The one that prepares jobs also lets the poster take it back at once while nobody has taken a
 * seat, and closes a job anybody asks it to once its window has closed (V9).
 */
export type Way = "first" | "prepares";

export function wayOut(jobs: Address, market: Pick<MarketConfig, "jobs" | "writing">): Way {
  return market.writing !== undefined && isAddressEqual(jobs, market.jobs) ? "prepares" : "first";
}

/** Where the poster's money is */
export type Standing =
  | { readonly kind: "too early"; readonly endsAt: bigint }
  | { readonly kind: "settled" }
  | { readonly kind: "refunded" }
  | { readonly kind: "ready" }
  /** open, nobody seated: the poster may take it back now, on a contract that prepares jobs */
  | { readonly kind: "take back now" }
  /** still preparing: taken back on its own page, where its checks are */
  | { readonly kind: "preparing"; readonly page: string };

export function standingOf(job: OnChainNow, way: Way = "first", onChainId = ""): Standing {
  if (job.state === "settled") return { kind: "settled" };
  if (job.state === "refunded") return { kind: "refunded" };
  if (job.state === "preparing") return { kind: "preparing", page: preparingPagePath(onChainId) };
  if (job.now < job.endsAt) return way === "prepares" && job.state === "open" ? { kind: "take back now" } : { kind: "too early", endsAt: job.endsAt };
  return { kind: "ready" };
}

/** Whether there is no money left in the job to take: it was paid out, or taken back already. */
export const isOver = (standing: Standing): boolean => standing.kind === "settled" || standing.kind === "refunded";

/** Whether the button may be pressed: while the money is the poster's to take. */
export const canTake = (standing: Standing): boolean => standing.kind === "ready" || standing.kind === "take back now";

/**
 * Which job the page's own address names: by its name on the wall, /refund/<job>, or, for a job paid
 * for and never published, by its number on the contract, /refund/?job=<n>, which the chain alone knows.
 */
export type RefundTarget =
  | { readonly by: "name"; readonly jobId: string }
  /** on the contract named, or, when none is, the one jobs are posted to now */
  | { readonly by: "number"; readonly onChainId: string; readonly jobs?: Address }
  /** no job at all: the page only offers what a payment could not deliver */
  | { readonly by: "none" };

export function targetFrom(pathname: string, search: string): RefundTarget {
  const query = new URLSearchParams(search);
  const number = query.get(QUERY.job);
  const jobs = query.get(QUERY.jobs);
  if (number !== null && /^[0-9]+$/.test(number)) return { by: "number", onChainId: number, ...(jobs && isAddress(jobs) ? { jobs } : {}) };
  const jobId = decodeURIComponent(pathname.slice(ROUTES.refund.length).split("/")[0] ?? "");
  return jobId === "" ? { by: "none" } : { by: "name", jobId };
}

export type RefundStep = "wallet" | "send" | "confirm";
export const REFUND_STEPS: readonly RefundStep[] = ["wallet", "send", "confirm"];

export type RefundStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "working"; readonly step: RefundStep }
  | { readonly kind: "sent"; readonly hash: `0x${string}` }
  | { readonly kind: "stopped"; readonly step: RefundStep; readonly why: string };

export type StepState = "done" | "doing" | "failed" | "waiting";

export function stepStates(status: RefundStatus): Record<RefundStep, StepState> {
  const at = status.kind === "working" || status.kind === "stopped" ? REFUND_STEPS.indexOf(status.step)
    : status.kind === "sent" ? REFUND_STEPS.length : -1;
  const now: StepState = status.kind === "stopped" ? "failed" : "doing";
  const stateAt = (index: number): StepState => (index < at ? "done" : index === at ? now : "waiting");
  return { wallet: stateAt(0), send: stateAt(1), confirm: stateAt(2) };
}

const when = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

export const COPY = {
  masthead: {
    eyebrow: "the money",
    shout: ["Take it", "back"],
    strap: "a job nobody finished pays nobody",
    stand: "When a job's window closes and it was never settled, the money is the poster's again, and every deposit goes home. The poster's wallet sends for it; nobody here holds it.",
  },
  loading: "Reading the job from the chain…",
  /** what a job known only by its number is called, having no idea published for it */
  unpublished: (onChainId: string) => `Job ${onChainId} on the contract, paid for and never published`,
  onTheWall: (onChainId: string) => `Job ${onChainId} on the contract`,
  seeItOnTheWall: "See it on the wall",
  closed: "This server answers to no chain, so there is nothing to take back here.",
  notThisContract: (jobs: string) => `This job is not on the contract this link names (${jobs}), so nothing is sent from here.`,
  noWallet: "Connect the wallet that posted the job at the top of the page: its passkey, or the browser wallet it lives in.",
  stands: {
    title: "Where the job stands",
    amount: (price: bigint, coin: string) => `${formatEther(price)} ${coin}`,
    posted: "Posted by",
    said: (standing: Standing) => {
      switch (standing.kind) {
        case "too early": return `The window is open until ${when(standing.endsAt)}. Until then the pod can still finish, and the money stays with the job.`;
        case "settled": return "The job was settled: the pod was paid for work that passed, or the money came back on its own when the work failed. There is nothing to take back.";
        case "refunded": return "The money has gone back to the poster already.";
        case "ready": return "The window has closed and the job was never settled. The money is the poster's to take back.";
        case "take back now": return "Nobody has taken a seat yet, so the poster can take the money back now, without waiting for the window to close.";
        case "preparing": return "Its checks are still being written and read. The money is taken back on its own page, where the checks are.";
      }
    },
  },
  take: {
    title: "Take the money back",
    button: (price: bigint, coin: string) => `Take back ${formatEther(price)} ${coin}`,
    busy: "Sending…",
    notPoster: (connected: string, poster: string) =>
      `The wallet connected here is ${shortAddress(connected)}, and the job was posted by ${shortAddress(poster)}. The contract gives the money back only to whoever posted it: connect that wallet.`,
    steps: { wallet: "Connect the wallet", send: "Send the request to the contract", confirm: "Wait for the chain to confirm it" } satisfies Record<RefundStep, string>,
    stepStates: { done: "done", doing: "under way", failed: "stopped here", waiting: "not yet" } satisfies Record<StepState, string>,
    /** the contract's own refusals, by name, in words */
    refused: {
      NotPoster: "The contract gives the money back only to the wallet that posted the job, and this is not it.",
      TooEarly: "The window has not closed yet, so the contract keeps the money with the job.",
      WrongState: "The job was settled or refunded already, so there is nothing left to take.",
      NoSuchJob: "The contract has no job by that number.",
    },
    /** on the contract that prepares jobs, a job can also move on by somebody taking a seat */
    refusedPrepared: {
      WrongState: "A seat has been taken since, or the job was settled or refunded already, so the money stays with the job until its window closes.",
    },
    openPreparing: "Go to its page",
    done: (price: bigint, coin: string) => `The contract has paid ${formatEther(price)} ${coin} back to the poster, and every seat's deposit home. A payment a wallet could not take is kept for it, to withdraw on this page.`,
    transaction: "See the transaction",
  },
} as const;

/** A refusal the contract named, in words, if it is one a refund can meet. */
export function refusalWords(errorName: string, way: Way = "first"): string | undefined {
  return (way === "prepares" ? REFUSED_PREPARED.get(errorName) : undefined) ?? REFUSED.get(errorName);
}

const REFUSED: ReadonlyMap<string, string> = new Map(Object.entries(COPY.take.refused));
const REFUSED_PREPARED: ReadonlyMap<string, string> = new Map(Object.entries(COPY.take.refusedPrepared));

/** What a payment could not deliver, waiting to be withdrawn (V4). */
export const OWED = {
  title: "Waiting for you",
  says: (amount: string) => `${amount} is waiting for this wallet: a payment to it could not be delivered, so the contract kept it. Withdraw it to this wallet.`,
  button: (amount: string) => `Withdraw ${amount}`,
  done: "Withdrawn.",
  noJob: "Open this page from a job to take its money back. Anything a payment could not deliver to your wallet is withdrawn here.",
} as const;
