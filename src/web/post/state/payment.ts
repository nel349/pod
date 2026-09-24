/**
 * What the pay step says: the amount, the terms in one sentence, and what the button offers. Rules
 * rather than markup, so the words the poster reads before paying are tested without a browser.
 *
 * Once a payment exists, every one of these describes the job that was paid for, not the form as it
 * now stands: the poster may have changed the price since, and the chain holds what they paid.
 */
import { formatEther } from "viem";
import type { Mode } from "../../../job.ts";
import { COPY, windowInWords } from "./copy.ts";
import type { PayStatus, Payment } from "./posting.ts";

export interface PaymentWords {
  readonly amount: string;
  readonly terms: string;
  readonly button: string;
  /** where the paid-for job stands, when there is one */
  readonly paid: string | undefined;
}

export function paymentWords(input: {
  readonly price: bigint;
  readonly coin: string;
  readonly mode: Mode;
  readonly status: PayStatus;
  readonly hasWallet: boolean;
  readonly payment: Payment | undefined;
}): PaymentWords {
  const { payment } = input;
  const price = payment ? payment.sealed.spec.price : input.price;
  const mode = payment ? payment.sealed.spec.mode : input.mode;
  const amount = `${formatEther(price)} ${input.coin}`;

  let button: string = input.hasWallet ? COPY.pay.payAndPost(amount) : COPY.pay.connect;
  if (payment) button = COPY.pay.finish;
  if (input.status.kind === "posted") button = COPY.pay.posted;

  return {
    amount,
    terms: COPY.pay.plain(amount, windowInWords(mode)),
    button,
    paid: payment ? COPY.pay.paidAs(payment.onChainId, payment.hash) : undefined,
  };
}
