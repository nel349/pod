import type { ReactElement } from "react";
import { formatEther } from "viem";
import { Sheet } from "../../shared/index.ts";
import type { WithdrawStatus } from "../../shared/index.ts";
import { OWED } from "../state/index.ts";

/** What a payment could not deliver to this wallet, and the button that withdraws it. Draws; decides nothing. */
export function WithdrawSheet({ number, owed, coin, status, onWithdraw }: {
  readonly number: number;
  readonly owed: bigint;
  readonly coin: string;
  readonly status: WithdrawStatus;
  readonly onWithdraw: () => void;
}): ReactElement {
  const amount = `${formatEther(owed)} ${coin}`;
  // once withdrawn there is nothing left waiting: the sheet says so, and offers nothing more
  const isAllWithdrawn = owed === 0n;
  return (
    <Sheet number={number} id="owed" title={OWED.title}>
      {!isAllWithdrawn && <p className="lede">{OWED.says(amount)}</p>}
      {!isAllWithdrawn && <button type="button" id="withdraw" className="primary" disabled={status.kind === "working"} onClick={onWithdraw}>{OWED.button(amount)}</button>}
      <p id="withdrawn" className={status.kind === "done" ? "said-status done" : "said-status"} role="status">
        {status.kind === "done" && OWED.done}
        {status.kind === "stopped" && status.why}
      </p>
    </Sheet>
  );
}
