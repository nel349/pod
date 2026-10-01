/**
 * Taking the money back for a job that was never settled, and withdrawing what a payment could not
 * deliver. This wires hooks to sheets and holds no rule of its own: the contract decides who may take
 * it and when, and the page only says so first.
 */
import type { ReactElement } from "react";
import type { MarketConfig } from "../../market.ts";
import { useConnectedAccount, useOwed, useWalletPresent } from "../shared/index.ts";
import { RefundBill, StandsSheet, TakeSheet, WithdrawSheet } from "./components/index.ts";
import { useRefund, useRefundable } from "./hooks/index.ts";
import { COPY, OWED, standingOf, wayOut, type OnChainNow, type Refundable, type RefundTarget } from "./state/index.ts";

function Notice({ children }: { readonly children: string }): ReactElement {
  return <section className="sheet notice"><p>{children}</p></section>;
}

/** Anything kept back for the connected wallet, offered after whatever else the page shows. */
function Owed({ market, number }: { readonly market: MarketConfig; readonly number: number }): ReactElement | null {
  const connected = useConnectedAccount();
  const { owed, status, withdraw } = useOwed(market, connected);
  if (owed === undefined || (owed === 0n && status.kind !== "done")) return null;
  return <WithdrawSheet number={number} owed={owed} coin={market.coin} status={status} onWithdraw={withdraw} />;
}

function Refunding({ job, onChain, market }: { readonly job: Refundable; readonly onChain: OnChainNow; readonly market: MarketConfig }): ReactElement {
  const hasWallet = useWalletPresent();
  const connected = useConnectedAccount();
  const way = wayOut(job.jobs, market);
  const standing = standingOf(onChain, way, job.onChainId);
  const { status, refund } = useRefund(job, market, way, standing);
  return (
    <>
      <StandsSheet job={job} onChain={onChain} standing={standing} coin={market.coin} explorer={market.explorer} />
      <TakeSheet onChain={onChain} standing={standing} coin={market.coin} explorer={market.explorer}
        hasWallet={hasWallet} connected={connected} status={status} onRefund={refund} />
    </>
  );
}

function ForAJob({ target, market }: { readonly target: Exclude<RefundTarget, { readonly by: "none" }>; readonly market: MarketConfig }): ReactElement {
  const state = useRefundable(target, market);
  return (
    <>
      {state.kind === "loading" && <Notice>{COPY.loading}</Notice>}
      {state.kind === "failed" && <Notice>{state.why}</Notice>}
      {state.kind === "ready" && <Refunding job={state.job} onChain={state.onChain} market={market} />}
    </>
  );
}

export function RefundPage({ target, market }: { readonly target: RefundTarget; readonly market: MarketConfig }): ReactElement {
  return (
    <div className="poster">
      <RefundBill />
      <main className="sheets">
        {target.by === "none" ? <Notice>{OWED.noJob}</Notice> : <ForAJob target={target} market={market} />}
        <Owed market={market} number={target.by === "none" ? 1 : 3} />
      </main>
    </div>
  );
}
