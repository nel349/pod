import type { ReactElement } from "react";
import type { MarketConfig } from "../../../../market.ts";
import { refundByNumberPath, ROUTES } from "../../../../routes.ts";
import { Sheet } from "../../../shared/index.ts";
import { SITE } from "../../copy.ts";
import { useKeptPayment } from "../../hooks/index.ts";

/** A payment this browser sent and never published: finish it, or take the money back. */
export function KeptSheet({ market }: { readonly market: MarketConfig }): ReactElement | null {
  const kept = useKeptPayment(market);
  if (!kept) return null;
  return (
    <Sheet number={1} id="kept" title={SITE.yours.keptTitle} stamp={false}>
      <p className="lede">{SITE.yours.kept(kept.name)}</p>
      <p className="actions">
        <a className="primary" href={ROUTES.post}>{SITE.yours.finish}</a>
        {kept.payment.onChainId !== undefined && <a href={refundByNumberPath(kept.payment.onChainId)}>{SITE.job.money.takeBack}</a>}
      </p>
    </Sheet>
  );
}
