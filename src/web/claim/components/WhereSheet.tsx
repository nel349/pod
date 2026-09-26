import { useState, type FormEvent, type ReactElement } from "react";
import type { Address } from "viem";
import { isAddressEqual } from "viem";
import { CLAIM_STEPS, COPY, stepStates, type Claimable, type ClaimStatus } from "../state/index.ts";
import { Sheet } from "./Sheet.tsx";

interface WhereSheetProps {
  readonly claimable: Claimable;
  readonly hasWallet: boolean;
  readonly connected: Address | undefined;
  readonly status: ClaimStatus;
  readonly onClaim: (toAccount: string) => void;
}

/** The account it goes to, the button, and what happened. */
export function WhereSheet({ claimable, hasWallet, connected, status, onClaim }: WhereSheetProps): ReactElement {
  const [account, setAccount] = useState("");
  const isWorking = status.kind === "working";
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (account.trim()) onClaim(account.trim());
  };
  const steps = stepStates(status);

  return (
    <Sheet number={2} id="where" title={COPY.where.title}>
      <p className="guide">{COPY.where.guide}</p>
      <form onSubmit={submit} noValidate>
        <label className="field" htmlFor="account">
          {COPY.where.label}
          <input id="account" type="text" autoComplete="off" spellCheck={false} placeholder={COPY.where.placeholder}
            value={account} onChange={(event) => setAccount(event.target.value)} disabled={isWorking} />
        </label>
        {connected && !isAddressEqual(connected, claimable.holder) && (
          <p id="not-holder" className="said-status">{COPY.where.notHolder(connected, claimable.holder)}</p>
        )}
        <button type="submit" id="claim" className="primary" disabled={!hasWallet || isWorking || !account.trim()} data-busy={isWorking || undefined}>
          {isWorking ? COPY.where.busy : COPY.where.button}
        </button>
      </form>
      <p id="said" className={status.kind === "sent" ? "said-status done" : "said-status"} role="status">
        {!hasWallet && COPY.noWallet}
        {status.kind === "stopped" && status.why}
        {status.kind === "sent" && COPY.sent(status.invited, claimable.repository)}
        {status.kind === "idle" && claimable.invited && COPY.before(claimable.invited)}
      </p>
      {status.kind !== "idle" && (
        <ol id="progress" className="progress" aria-live="polite">
          {CLAIM_STEPS.map((step) => (
            <li key={step} data-state={steps[step]}>
              {COPY.where.steps[step]}
              <span className="sr-only">: {COPY.where.stepStates[steps[step]]}</span>
            </li>
          ))}
        </ol>
      )}
    </Sheet>
  );
}
