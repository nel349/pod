import type { ReactElement } from "react";
import { DEPOSIT_PERCENT } from "../../../../job.ts";
import { Copyable } from "../../../shared/index.ts";
import { SITE } from "../../copy.ts";
import type { AgentKeyStatus } from "../../hooks/index.ts";

/** Everything the sheet shows of an agent's key once the person's passkey wallet is open. */
export interface AgentKeyView {
  /** which of the person's agents, counted from 1 */
  readonly number: number;
  readonly coin: string;
  /** the key the passkey made, while it is open on the page */
  readonly open: {
    readonly address: string;
    /** what the address holds, in words, once read */
    readonly holds: string | undefined;
    readonly isEmpty: boolean;
    /** the key itself, while the person has asked to see it */
    readonly shown: string | undefined;
  } | undefined;
  /** what the person typed as the amount to send it */
  readonly amount: string;
  readonly canFund: boolean;
  readonly isMaking: boolean;
  readonly status: AgentKeyStatus;
  /** why the passkey did not give a key, when it did not */
  readonly problem: string | undefined;
}

export interface AgentKeyActions {
  readonly make: () => void;
  readonly another: () => void;
  readonly before: () => void;
  readonly showKey: () => void;
  readonly hideKey: () => void;
  readonly setAmount: (amount: string) => void;
  readonly fund: () => void;
  readonly bringBack: () => void;
  readonly forget: () => void;
}

/** What is said of money on its way, arrived, or stopped. */
function Said({ status }: { readonly status: AgentKeyStatus }): ReactElement | null {
  const words = SITE.agents.key;
  switch (status.kind) {
    case "idle": return null;
    case "working": return <p id="agent-said" className="note live" role="status">{words.working[status.move]}</p>;
    case "done": return <p id="agent-said" className="note" role="status" data-done={status.move}>{words.done[status.move]}</p>;
    case "stopped": return <p id="agent-said" className="note wrong" role="status">{words.stopped(status.why)}</p>;
  }
}

/** An agent's key from the person's passkey: making it, its address, the key, and money to and from it. Draws; decides nothing. */
export function AgentKey({ view, on }: { readonly view: AgentKeyView; readonly on: AgentKeyActions }): ReactElement {
  const words = SITE.agents.key;
  const isMoving = view.status.kind === "working";
  // one thing at a time: a prompt or a payment under way belongs to the agent it was started for
  const isBusy = isMoving || view.isMaking;
  const which = (
    <p className="actions agent-which">
      <strong id="agent-number">{words.whose(view.number)}</strong>
      {view.number > 1 && <button type="button" id="agent-before" className="quiet" disabled={isBusy} onClick={on.before}>{words.before}</button>}
      <button type="button" id="another-agent" className="quiet" disabled={isBusy} onClick={on.another}>{words.another}</button>
    </p>
  );
  if (!view.open) {
    return (
      <div className="agent-key">
        {which}
        <p className="actions">
          <button type="button" id="make-agent-key" className="primary small" disabled={view.isMaking} onClick={on.make}>{words.make}</button>
          <span className="note">{words.makeSays}</span>
        </p>
        {view.problem && <p id="agent-problem" className="note wrong" role="status">{words.notMade(view.problem)}</p>}
      </div>
    );
  }
  return (
    <div className="agent-key">
      {which}
      <p className="agent-label">{words.address}</p>
      <p id="agent-address" className="wallet-address"><code>{view.open.address}</code></p>
      {view.open.holds && <p id="agent-holds" className="note">{words.holds(view.open.holds)}</p>}

      <p className="agent-label">{words.keyTitle}</p>
      {view.open.shown ? (
        <>
          <p className="note">{words.keySays}</p>
          <div id="agent-key-shown"><Copyable text={view.open.shown} what={words.what} /></div>
          <button type="button" className="quiet" onClick={on.hideKey}>{words.hideKey}</button>
        </>
      ) : (
        <button type="button" id="show-agent-key" className="quiet" onClick={on.showKey}>{words.showKey}</button>
      )}

      <p className="agent-label">{words.moneyTitle}</p>
      <p className="note">{words.fundSays(DEPOSIT_PERCENT)}</p>
      <p className="actions agent-money">
        <label className="agent-amount">
          <span className="note">{words.amount(view.coin)}</span>
          <input id="agent-amount" type="text" inputMode="decimal" value={view.amount} onChange={(event) => on.setAmount(event.target.value)} />
        </label>
        <button type="button" id="fund-agent" className="primary small" disabled={!view.canFund || isMoving} onClick={on.fund}>{words.fund}</button>
      </p>
      <p className="actions">
        <button type="button" id="bring-back" className="quiet" disabled={view.open.isEmpty || isMoving} onClick={on.bringBack}>{words.back}</button>
        <span className="note">{words.backSays}</span>
      </p>
      <Said status={view.status} />

      <p className="actions">
        <button type="button" id="forget-agent-key" className="quiet" disabled={isMoving} onClick={on.forget}>{words.forget}</button>
        <span className="note">{words.forgetSays}</span>
      </p>
    </div>
  );
}
