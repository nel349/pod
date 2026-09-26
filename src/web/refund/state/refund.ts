/**
 * What the refund page knows and says, with no browser and no chain: where a job stands for its
 * poster's money, and every sentence the page shows.
 *
 * The contract gives a poster their money back once the window has closed and the job was never
 * settled: nobody finished, a seat stayed empty, or the runs disagreed and the grader held it. Work
 * that failed is refunded by the grader on its own, and work that passed was paid for.
 */
import { formatEther, type Address } from "viem";
import { z } from "zod";
import type { JobState } from "../../../jobs.ts";
import { ROUTES } from "../../../routes.ts";

/** The job, as the server keeps it: enough to find it on the chain */
export const RefundableSchema = z.object({ jobId: z.string(), idea: z.string(), onChainId: z.string().regex(/^[0-9]+$/) });
export type Refundable = z.infer<typeof RefundableSchema>;
export const WhySchema = z.object({ why: z.string() });

/** The job as the chain has it right now, and the chain's own time */
export interface OnChainNow {
  readonly poster: Address;
  readonly price: bigint;
  readonly endsAt: bigint;
  readonly state: JobState;
  readonly now: bigint;
}

/** Where the poster's money is */
export type Standing =
  | { readonly kind: "too early"; readonly endsAt: bigint }
  | { readonly kind: "settled" }
  | { readonly kind: "refunded" }
  | { readonly kind: "ready" };

export function standingOf(job: OnChainNow): Standing {
  if (job.state === "settled") return { kind: "settled" };
  if (job.state === "refunded") return { kind: "refunded" };
  if (job.now < job.endsAt) return { kind: "too early", endsAt: job.endsAt };
  return { kind: "ready" };
}

/**
 * Which job the page's own address names: by its name on the wall, /refund/<job>, or, for a job paid
 * for and never published, by its number on the contract, /refund/?job=<n>, which the chain alone knows.
 */
export type RefundTarget =
  | { readonly by: "name"; readonly jobId: string }
  | { readonly by: "number"; readonly onChainId: string };

export function targetFrom(pathname: string, search: string): RefundTarget {
  const number = new URLSearchParams(search).get("job");
  if (number !== null && /^[0-9]+$/.test(number)) return { by: "number", onChainId: number };
  return { by: "name", jobId: decodeURIComponent(pathname.slice(ROUTES.refund.length).split("/")[0] ?? "") };
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

const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;
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
  closed: "This server answers to no chain, so there is nothing to take back here.",
  noWallet: "This browser has no wallet in it. Open this page where the wallet that posted the job lives.",
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
    },
    done: (price: bigint, coin: string) => `${formatEther(price)} ${coin} is on its way back, and every seat's deposit with it.`,
    transaction: "See the transaction",
  },
} as const;

/** A refusal the contract named, in words, if it is one a refund can meet. */
export function refusalWords(errorName: string): string | undefined {
  return REFUSED.get(errorName);
}

const REFUSED: ReadonlyMap<string, string> = new Map(Object.entries(COPY.take.refused));
