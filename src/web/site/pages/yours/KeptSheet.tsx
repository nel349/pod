import type { ReactElement } from "react";
import { refundByNumberPath, ROUTES } from "../../../../routes.ts";
import { Sheet } from "../../../shared/index.ts";
import type { Kept } from "../../../post/index.ts";
import { SITE } from "../../copy.ts";

/** A payment this browser sent and never published: finish it, or take the money back. */
export function KeptSheet({ kept }: { readonly kept: Kept }): ReactElement {
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
