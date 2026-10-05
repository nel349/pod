import type { ReactElement } from "react";
import type { MarketConfig } from "../../market.ts";
import { ClaimPages } from "../claim/index.ts";
import { PostPages } from "../post/index.ts";
import { RefundPages } from "../refund/index.ts";
import { ClientOnly, SiteHeader, WalletStatus, type Place } from "../shared/index.ts";
import { SiteContext } from "./hooks/index.ts";
import { AgentPage, AgentsPage, JobPage, MissingPage, ReceiptPage, WallPage, YoursPage } from "./pages/index.ts";
import type { SiteData, SitePage } from "./views/index.ts";

function Page({ data, market }: { readonly data: SitePage; readonly market: MarketConfig | undefined }): ReactElement {
  switch (data.page) {
    case "wall": return <WallPage tiles={data.tiles} />;
    case "job": return <JobPage job={data.job} />;
    case "agent": return <AgentPage data={data} />;
    case "receipt": return <ReceiptPage receipt={data.receipt} />;
    case "yours": return <YoursPage />;
    case "agents": return <AgentsPage />;
    case "missing": return <MissingPage why={data.why} />;
    // drawn by the browser alone: the server sends the header, and the browser the rest
    case "post": return <ClientOnly><PostPages market={market} /></ClientOnly>;
    case "refund": return <ClientOnly><RefundPages market={market} /></ClientOnly>;
    case "claim": return <ClientOnly><ClaimPages market={market} /></ClientOnly>;
  }
}

const PLACE_OF: Partial<Record<SitePage["page"], Place>> = { wall: "wall", yours: "yours", post: "post", agents: "agents" };

/**
 * Every server-drawn page: the header, with the wallet in it once the page is in the browser, and the
 * page itself. The server draws it with no wallet at all; the browser wraps it in one and takes over.
 */
export function SiteApp({ data, address }: { readonly data: SiteData; readonly address?: string }): ReactElement {
  const { market, coin, drawnAt, site } = data;
  const place = PLACE_OF[data.page];
  return (
    <SiteContext.Provider value={{ ...(market ? { market } : {}), coin, drawnAt, site }}>
      <SiteHeader
        {...(place ? { current: place } : {})}
        wallet={market ? <ClientOnly><WalletStatus market={market} /></ClientOnly> : undefined}
      />
      {/* a new page starts afresh, while the header, and the wallet in it, stay as they are */}
      <Page key={address} data={data} market={market} />
    </SiteContext.Provider>
  );
}
