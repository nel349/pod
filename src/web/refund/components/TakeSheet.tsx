import type { ReactElement } from "react";
import { isAddressEqual, type Address } from "viem";
import { explorerTransaction } from "../../../market.ts";
import { Sheet } from "../../shared/index.ts";
import { COPY, REFUND_STEPS, stepStates, type OnChainNow, type RefundStatus, type Standing } from "../state/index.ts";

interface TakeSheetProps {
  readonly onChain: OnChainNow;
  readonly standing: Standing;
  readonly coin: string;
  readonly explorer: string;
  readonly hasWallet: boolean;
  readonly connected: Address | undefined;
  readonly status: RefundStatus;
  readonly onRefund: () => void;
}

/** The button, and what happened. It is pressable only while the money is the poster's to take. */
export function TakeSheet({ onChain, standing, coin, explorer, hasWallet, connected, status, onRefund }: TakeSheetProps): ReactElement {
  const isWorking = status.kind === "working";
  const steps = stepStates(status);
  return (
    <Sheet number={2} id="take" title={COPY.take.title}>
      {connected && !isAddressEqual(connected, onChain.poster) && (
        <p id="not-poster" className="said-status">{COPY.take.notPoster(connected, onChain.poster)}</p>
      )}
      <button type="button" id="refund" className="primary" onClick={onRefund}
        disabled={!hasWallet || isWorking || status.kind === "sent" || standing.kind !== "ready"} data-busy={isWorking || undefined}>
        {isWorking ? COPY.take.busy : COPY.take.button(onChain.price, coin)}
      </button>
      <p id="said" className={status.kind === "sent" ? "said-status done" : "said-status"} role="status">
        {!hasWallet && COPY.noWallet}
        {status.kind === "stopped" && status.why}
        {status.kind === "sent" && <>{COPY.take.done(onChain.price, coin)} <a href={explorerTransaction(explorer, status.hash)}>{COPY.take.transaction}</a>.</>}
      </p>
      {status.kind !== "idle" && (
        <ol id="progress" className="progress" aria-live="polite">
          {REFUND_STEPS.map((step) => (
            <li key={step} data-state={steps[step]}>
              {COPY.take.steps[step]}
              <span className="sr-only">: {COPY.take.stepStates[steps[step]]}</span>
            </li>
          ))}
        </ol>
      )}
    </Sheet>
  );
}
