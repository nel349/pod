/**
 * The claim app: it reads which chain the server answers to, connects a wallet to it, and shows the
 * claim for the job its own address names.
 */
import { useMemo, type ReactElement } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import type { MarketConfig } from "../../market.ts";
import { ErrorBoundary } from "../post/components/index.ts";
import { useMarket } from "../post/hooks/index.ts";
import { walletConfig } from "../post/wallet/index.ts";
import { ClaimBill } from "./components/index.ts";
import { ClaimPage } from "./ClaimPage.tsx";
import { COPY, jobIdFrom } from "./state/index.ts";

function Notice({ children }: { readonly children: string }): ReactElement {
  return (
    <div className="poster">
      <ClaimBill />
      <main className="sheets"><section className="sheet notice"><p>{children}</p></section></main>
    </div>
  );
}

function OnTheChain({ market }: { readonly market: MarketConfig }): ReactElement {
  const config = useMemo(() => walletConfig(market), [market]);
  return (
    <WagmiProvider config={config}>
      <ClaimPage jobId={jobIdFrom(window.location.pathname)} market={market} />
    </WagmiProvider>
  );
}

function Market(): ReactElement {
  const state = useMarket();
  switch (state.kind) {
    case "loading": return <Notice>{COPY.loading}</Notice>;
    case "failed": return <Notice>{state.why}</Notice>;
    case "closed": return <Notice>{"This server answers to no chain, so nothing can be claimed here."}</Notice>;
    case "open": return <OnTheChain market={state.market} />;
  }
}

export function App({ client }: { readonly client: QueryClient }): ReactElement {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={client}>
        <Market />
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
