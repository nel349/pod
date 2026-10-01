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
import { Bill } from "./components/index.ts";
import { PayFirstPage } from "./PayFirstPage.tsx";
import { PostJobPage } from "./PostJobPage.tsx";
import { PreparedJobPage } from "./PreparedJobPage.tsx";
import { COPY, preparedNumberIn } from "./state/index.ts";
import { SiteHeader, WalletStatus } from "../shared/index.ts";
import { ErrorBoundary, useMarket, walletConfig } from "../shared/index.ts";

/** The poster, with one sheet saying why there is no form: still loading, or nowhere to post. */
function Notice({ children }: { readonly children: string }): ReactElement {
  return (
    <>
      <SiteHeader current="post" />
      <div className="poster">
        <Bill />
        <main className="sheets"><section className="sheet notice"><p>{children}</p></section></main>
      </div>
    </>
  );
}

/**
 * A wallet connected to this one market, around the page that posts to it: on a contract that prepares
 * jobs, the pay-first page, or a paid job's own page at /post/<number>; otherwise the page that has
 * the checks written before paying.
 */
function OpenMarket({ market }: { readonly market: MarketConfig }): ReactElement {
  const config = useMemo(() => walletConfig(market), [market]);
  const paidJob = preparedNumberIn(window.location.pathname);
  let page: ReactElement = <PostJobPage market={market} />;
  if (market.writing) page = paidJob === undefined ? <PayFirstPage market={market} writing={market.writing} /> : <PreparedJobPage market={market} onChainId={paidJob} />;
  return (
    <WagmiProvider config={config}>
      <SiteHeader current="post" wallet={<WalletStatus market={market} />} />
      {page}
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
