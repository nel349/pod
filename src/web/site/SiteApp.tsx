import type { ReactElement } from "react";
import { ClientOnly, SiteHeader, WalletStatus, type Place } from "../shared/index.ts";
import { SiteContext } from "./hooks/index.ts";
import { AgentPage, JobPage, MissingPage, ReceiptPage, WallPage, YoursPage } from "./pages/index.ts";
import type { SiteData, SitePage } from "./views/index.ts";

function Page({ data }: { readonly data: SitePage }): ReactElement {
  switch (data.page) {
    case "wall": return <WallPage tiles={data.tiles} />;
    case "job": return <JobPage job={data.job} />;
    case "agent": return <AgentPage agent={data.agent} record={data.record} tiles={data.tiles} />;
    case "receipt": return <ReceiptPage receipt={data.receipt} />;
    case "yours": return <YoursPage />;
    case "missing": return <MissingPage why={data.why} />;
  }
}

const PLACE_OF: Partial<Record<SitePage["page"], Place>> = { wall: "wall", yours: "yours" };

/**
 * Every server-drawn page: the header, with the wallet in it once the page is in the browser, and the
 * page itself. The server draws it with no wallet at all; the browser wraps it in one and takes over.
 */
export function SiteApp({ data }: { readonly data: SiteData }): ReactElement {
  const { market, coin, drawnAt } = data;
  const place = PLACE_OF[data.page];
  return (
    <SiteContext.Provider value={{ ...(market ? { market } : {}), coin, drawnAt }}>
      <SiteHeader
        {...(place ? { current: place } : {})}
        wallet={market ? <ClientOnly><WalletStatus market={market} /></ClientOnly> : undefined}
      />
      <Page data={data} />
    </SiteContext.Provider>
  );
}
