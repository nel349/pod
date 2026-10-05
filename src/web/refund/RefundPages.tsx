import type { ReactElement } from "react";
import type { MarketConfig } from "../../market.ts";
import { usePath, useSearch } from "../shared/index.ts";
import { RefundBill } from "./components/index.ts";
import { RefundPage } from "./RefundPage.tsx";
import { COPY, targetFrom } from "./state/index.ts";

/** Taking money back, inside the one app: the job its own address names, or why there is none. */
export function RefundPages({ market }: { readonly market: MarketConfig | undefined }): ReactElement {
  const target = targetFrom(usePath(), useSearch());
  if (!market) {
    return (
      <div className="poster">
        <RefundBill />
        <main className="sheets"><section className="sheet notice"><p>{COPY.closed}</p></section></main>
      </div>
    );
  }
  return <RefundPage key={JSON.stringify(target)} target={target} market={market} />;
}
