import type { ReactElement } from "react";
import type { Mode } from "../../../job.ts";
import type { MarketConfig } from "../../../market.ts";
import {
  canPress, COPY, PAY_FIRST_POSTING_STEPS, payFirstWords,
  type KeptSetUp, type PayFirstStep as PayingStep, type PayStatus, type StepState, type WhatIsPaid,
} from "../state/index.ts";
import { Step } from "./Step.tsx";

/** Everything the pay sheet shows, when the poster pays before the checks are written. */
export interface PayFirstView {
  readonly paid: WhatIsPaid;
  readonly mode: Mode;
  readonly status: PayStatus;
  readonly steps: Partial<Record<PayingStep, StepState>>;
  /** the payment already sent and not yet set up: from then on the button finishes that job */
  readonly kept: KeptSetUp | undefined;
  /** the form is being checked before anything is sent, which is no time to press again */
  readonly isSubmitting: boolean;
}

/** What paying covers and what happens after, the button, and, once pressed, every step it takes. */
export function PayFirstStep({ market, view }: { readonly market: MarketConfig; readonly view: PayFirstView }): ReactElement {
  const { status, steps, kept } = view;
  const words = payFirstWords(view.paid, market.coin, view.mode);
  return (
    <Step name="pay" title={COPY.payFirst.title}>
      <p className="terms-plain">{words.terms}</p>
      {kept && (
        <p className="paid-as" id="paid-as">
          {COPY.payFirst.paidAs(kept.onChainId, kept.hash)}{status.kind === "idle" ? `. ${COPY.payFirst.comeBack}` : ""}
        </p>
      )}
      <button type="submit" id="submit" className="primary" data-state={status.kind} disabled={!canPress(status) || view.isSubmitting}>
        {kept ? COPY.payFirst.finish : words.button}
      </button>
      <p id="said" className="said-status" role="status">
        {status.kind === "stopped" && status.why}
        {status.kind === "idle" && status.problem}
      </p>
      {status.kind !== "idle" && (
        <ol id="progress" className="progress" aria-live="polite">
          {PAY_FIRST_POSTING_STEPS.map((step) => (
            <li key={step} data-step={step} data-state={steps[step]}>
              {step === "chain" ? COPY.payFirst.steps.chain(market.chainName) : COPY.payFirst.steps[step]}
              <span className="sr-only">: {COPY.pay.stepStates[steps[step] ?? "waiting"]}</span>
            </li>
          ))}
        </ol>
      )}
    </Step>
  );
}
