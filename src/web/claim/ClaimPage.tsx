/**
 * Claiming a POD's repository: what is claimed, and where it goes. This wires hooks to sheets and
 * holds no rule of its own: what may be claimed, and by whom, is the server's and the chain's.
 */
import type { ReactElement } from "react";
import type { MarketConfig } from "../../market.ts";
import { useWalletPresent } from "../post/hooks/index.ts";
import { ClaimBill, WhatSheet, WhereSheet } from "./components/index.ts";
import { useConnectedAccount } from "../shared/index.ts";
import { useClaim, useClaimable } from "./hooks/index.ts";
import { COPY, type Claimable } from "./state/index.ts";

function Notice({ children }: { readonly children: string }): ReactElement {
  return <main className="sheets"><section className="sheet notice"><p>{children}</p></section></main>;
}

function Claiming({ claimable, market }: { readonly claimable: Claimable; readonly market: MarketConfig }): ReactElement {
  const hasWallet = useWalletPresent();
  const connected = useConnectedAccount();
  const { status, claim } = useClaim(claimable);
  return (
    <main className="sheets">
      <WhatSheet claimable={claimable} explorer={market.explorer} />
      <WhereSheet claimable={claimable} hasWallet={hasWallet} connected={connected} status={status} onClaim={claim} />
    </main>
  );
}

export function ClaimPage({ jobId, market }: { readonly jobId: string; readonly market: MarketConfig }): ReactElement {
  const state = useClaimable(jobId);
  return (
    <div className="poster">
      <ClaimBill />
      {state.kind === "loading" && <Notice>{COPY.loading}</Notice>}
      {state.kind === "failed" && <Notice>{state.why}</Notice>}
      {state.kind === "ready" && <Claiming claimable={state.claimable} market={market} />}
    </div>
  );
}
