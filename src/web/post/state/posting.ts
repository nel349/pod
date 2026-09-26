/**
 * Paying and posting, as states: the five steps it takes, where each one is, and how it can stop.
 *
 * The hook that does the paying lives in hooks/; this is what the page and that hook agree on.
 *
 * The rule everything here serves: money leaves the poster's wallet at most once per job. The moment
 * the wallet hands back a transaction, that is a payment, whatever happens next, and from then on the
 * page can only finish that job (wait for it, sign it, publish it), never pay for another.
 */
import type { Address, Hex } from "viem";
import type { SealedJob } from "./sealing.ts";

export const POSTING_STEPS = ["connect", "chain", "pay", "sign", "publish"] as const;
export type PostingStep = (typeof POSTING_STEPS)[number];
export type StepState = "doing" | "done" | "failed";

/**
 * A payment the wallet has sent. Kept from the moment there is a transaction, because from that
 * moment the money may be on the chain even if nothing after it succeeds.
 */
export interface Payment {
  readonly hash: Hex;
  readonly poster: Address;
  /** the job exactly as it was sealed and paid for, which is what must be published, not the form as it is now */
  readonly sealed: SealedJob;
  /** the job's number on the contract, once the chain has said which job the payment made */
  readonly onChainId?: string;
}

/** A posting that stopped, where, and whether money had left the wallet by then. */
export class PostingStopped extends Error {
  constructor(readonly step: PostingStep, message: string, readonly hasPaid: boolean) {
    super(message);
  }
}

export { NoWallet } from "../../shared/wallet/index.ts";

/** Where the posting is: not started (perhaps with a reason it cannot be), under way, done, or stopped. */
export type PayStatus =
  | { readonly kind: "idle"; readonly problem?: string }
  | { readonly kind: "posting" }
  | { readonly kind: "posted"; readonly url: string }
  /** stopped partway; once the money had moved, pressing again finishes that job rather than paying again */
  | { readonly kind: "stopped"; readonly why: string; readonly hasPaid: boolean };

/** Whether the button may be pressed: never while a posting is under way, and never once it is done. */
export function canPress(status: PayStatus): boolean {
  return status.kind !== "posting" && status.kind !== "posted";
}

/**
 * What pressing the button does next: pay for a new job, or finish the one already paid for. A job
 * that was paid for is finished even if the form has changed since, because what the chain holds is
 * the job as it was sealed then.
 */
export type NextPosting =
  | { readonly kind: "pay"; readonly sealed: SealedJob }
  | { readonly kind: "finish"; readonly payment: Payment };

export function nextPosting(payment: Payment | undefined, sealed: SealedJob): NextPosting {
  return payment ? { kind: "finish", payment } : { kind: "pay", sealed };
}
