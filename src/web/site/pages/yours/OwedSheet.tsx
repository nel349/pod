import type { ReactElement } from "react";
import { formatEther, type Address } from "viem";
import type { MarketConfig } from "../../../../market.ts";
import { ROUTES } from "../../../../routes.ts";
import { Sheet, useOwed } from "../../../shared/index.ts";
import { SITE } from "../../copy.ts";

/** Money a payment could not deliver to this wallet, kept by the contract until it is withdrawn (V4). */
export function OwedSheet({ market, address }: { readonly market: MarketConfig; readonly address: Address }): ReactElement | null {
  const { owed } = useOwed(market, address);
  if (owed === undefined || owed === 0n) return null;
  return (
    <Sheet number={5} id="owed" title={SITE.yours.owedTitle} stamp={false}>
      <p className="lede">{SITE.yours.owed(`${formatEther(owed)} ${market.coin}`)}</p>
      <p className="actions"><a className="primary" href={ROUTES.refund}>{SITE.yours.withdraw}</a></p>
    </Sheet>
  );
}
