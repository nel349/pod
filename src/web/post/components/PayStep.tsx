import type { ReactElement } from "react";
import type { Mode } from "../../../job.ts";
import type { MarketConfig } from "../../../market.ts";
import { refundByNumberPath } from "../../../routes.ts";
import {
  canPress, COPY, paymentWords, POSTING_STEPS,
  type PayStatus, type Payment, type PostingStep, type SealedJob, type StepState,
} from "../state/index.ts";
import { SealDetails } from "./SealDetails.tsx";
import { Step } from "./Step.tsx";

/** Everything the pay step shows: the terms, where the payment is, and what will be sealed. */
export interface PaymentView {
  readonly price: bigint;
  readonly mode: Mode;
  readonly hasWallet: boolean;
  readonly sealed: SealedJob | undefined;
  readonly status: PayStatus;
  readonly steps: Partial<Record<PostingStep, StepState>>;
  /** the payment already sent, if any: from then on the button finishes that job */
  readonly paid: Payment | undefined;
  /** the form is being checked before anything is sent, which is no time to press again */
  readonly isSubmitting: boolean;
}

/** The terms in a sentence, the button, and, once pressed, every step the payment takes. */
export function PayStep({ market, payment }: { readonly market: MarketConfig; readonly payment: PaymentView }): ReactElement {
  const { status, steps, paid } = payment;
  const words = paymentWords({ ...payment, coin: market.coin, payment: paid });
  const isPosted = status.kind === "posted";

  return (
    <Step name="pay" title={COPY.pay.title}>
      <p className="terms-plain">{words.terms}</p>
      {words.paid && <p className="paid-as" id="paid-as">{words.paid}</p>}
      {paid?.onChainId !== undefined && !isPosted && (
        <p className="paid-as"><a href={refundByNumberPath(paid.onChainId)}>{COPY.pay.takeBack}</a>.</p>
      )}
      <button type="submit" id="submit" className="primary" data-state={status.kind}
        disabled={!canPress(status) || payment.isSubmitting}>
        {words.button}
      </button>
      <p id="said" className={isPosted ? "said-status done" : "said-status"} role="status">
        {status.kind === "posted" && <>{COPY.pay.done} <a href={status.url}>{COPY.pay.openJob}</a>. {COPY.pay.held}</>}
        {status.kind === "stopped" && status.why}
        {status.kind === "idle" && status.problem}
      </p>
      {status.kind !== "idle" && (
        <ol id="progress" className="progress" aria-live="polite">
          {POSTING_STEPS.map((step) => {
            const label = step === "chain" ? COPY.pay.steps.chain(market.chainName) : COPY.pay.steps[step];
            return (
              <li key={step} data-step={step} data-state={steps[step]}>
                {label}
                <span className="sr-only">: {COPY.pay.stepStates[steps[step] ?? "waiting"]}</span>
              </li>
            );
          })}
        </ol>
      )}
      <SealDetails market={market} sealed={paid?.sealed ?? payment.sealed} />
    </Step>
  );
}
