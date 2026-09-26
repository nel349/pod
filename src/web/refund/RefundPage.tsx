/**
 * Taking the money back for a job that was never settled. This wires hooks to sheets and holds no
 * rule of its own: the contract decides who may take it and when, and the page only says so first.
 */
import type { ReactElement } from "react";
import type { MarketConfig } from "../../market.ts";
import { useWalletPresent } from "../post/hooks/index.ts";
import { useConnectedAccount } from "../shared/index.ts";
import { RefundBill, StandsSheet, TakeSheet } from "./components/index.ts";
import { useRefund, useRefundable } from "./hooks/index.ts";
import { COPY, standingOf, type OnChainNow, type Refundable } from "./state/index.ts";

function Notice({ children }: { readonly children: string }): ReactElement {
  return <main className="sheets"><section className="sheet notice"><p>{children}</p></section></main>;
}

function Refunding({ job, onChain, market }: { readonly job: Refundable; readonly onChain: OnChainNow; readonly market: MarketConfig }): ReactElement {
  const hasWallet = useWalletPresent();
  const connected = useConnectedAccount();
  const { status, refund } = useRefund(job, market);
  const standing = standingOf(onChain);
  return (
    <main className="sheets">
      <StandsSheet job={job} onChain={onChain} standing={standing} coin={market.coin} explorer={market.explorer} />
      <TakeSheet onChain={onChain} standing={standing} coin={market.coin} explorer={market.explorer}
        hasWallet={hasWallet} connected={connected} status={status} onRefund={refund} />
    </main>
  );
}

export function RefundPage({ jobId, market }: { readonly jobId: string; readonly market: MarketConfig }): ReactElement {
  const state = useRefundable(jobId, market);
  return (
    <div className="poster">
      <RefundBill />
      {state.kind === "loading" && <Notice>{COPY.loading}</Notice>}
      {state.kind === "failed" && <Notice>{state.why}</Notice>}
      {state.kind === "ready" && <Refunding job={state.job} onChain={state.onChain} market={market} />}
    </div>
  );
}
