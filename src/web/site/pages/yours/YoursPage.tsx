import type { ReactElement } from "react";
import type { MarketConfig } from "../../../../market.ts";
import { Sheet, useConnectedAccount } from "../../../shared/index.ts";
import { InTheBrowser, PageBill, Poster } from "../../components/index.ts";
import { SITE } from "../../copy.ts";
import { useSite } from "../../hooks/index.ts";
import { ConnectSheet } from "./ConnectSheet.tsx";
import { KeptSheet } from "./KeptSheet.tsx";
import { WalletsOwn } from "./WalletsOwn.tsx";

function ForTheWallet({ market }: { readonly market: MarketConfig }): ReactElement {
  const account = useConnectedAccount();
  return (
    <>
      <KeptSheet market={market} />
      {account ? <WalletsOwn address={account} /> : <ConnectSheet />}
    </>
  );
}

/** A wallet's own page: what it posted, what it holds, and the one thing to do next on each. */
export function YoursPage(): ReactElement {
  const { market } = useSite();
  const bill = <PageBill words={{ eyebrow: SITE.yours.eyebrow, shout: SITE.yours.shout, strap: SITE.yours.strap, stand: SITE.yours.stand }} />;
  return (
    <Poster bill={bill}>
      {market
        ? <InTheBrowser fallback={<ConnectSheet />}><ForTheWallet market={market} /></InTheBrowser>
        : <Sheet number={1} id="closed" title={SITE.yours.connectTitle} stamp={false}><p className="lede">{SITE.yours.noChain}</p></Sheet>}
    </Poster>
  );
}
