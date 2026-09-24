/**
 * The posting app: it reads which market it posts to, then connects a wallet to that market.
 *
 * The market comes from the server rather than being baked into the bundle, so one build serves any
 * chain the server is pointed at, and a server with no contract says so instead of showing a form
 * that could never be submitted.
 */
import { useMemo, type ReactElement } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import type { MarketConfig } from "../../market.ts";
import { Bill, ErrorBoundary } from "./components/index.ts";
import { useMarket } from "./hooks/index.ts";
import { PostJobPage } from "./PostJobPage.tsx";
import { COPY } from "./state/index.ts";
import { walletConfig } from "./wallet/index.ts";

/** The poster, with one sheet saying why there is no form: still loading, or nowhere to post. */
function Notice({ children }: { readonly children: string }): ReactElement {
  return (
    <div className="poster">
      <Bill />
      <main className="sheets"><section className="sheet notice"><p>{children}</p></section></main>
    </div>
  );
}

/** A wallet connected to this one market, around the page that posts to it. */
function OpenMarket({ market }: { readonly market: MarketConfig }): ReactElement {
  const config = useMemo(() => walletConfig(market), [market]);
  return (
    <WagmiProvider config={config}>
      <PostJobPage market={market} />
    </WagmiProvider>
  );
}

function Market(): ReactElement {
  const state = useMarket();
  switch (state.kind) {
    case "loading": return <Notice>{COPY.loading}</Notice>;
    case "failed": return <Notice>{state.why}</Notice>;
    case "closed": return <Notice>{COPY.closed}</Notice>;
    case "open": return <OpenMarket market={state.market} />;
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
