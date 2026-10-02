import type { ReactElement } from "react";
import { preparingPagePath, refundByNumberPath, ROUTES } from "../../../../routes.ts";
import { Sheet } from "../../../shared/index.ts";
import { SITE } from "../../copy.ts";
import type { KeptHere } from "../../hooks/index.ts";

/** A payment this browser sent and never finished: finish it, or take the money back. */
export function KeptSheet({ kept }: { readonly kept: KeptHere }): ReactElement {
  const isSetUp = kept.kind === "setUp";
  // a job never set up is taken back on its own page; one never published, on the refund page
  const takeBack = kept.onChainId === undefined ? undefined : isSetUp ? preparingPagePath(kept.onChainId) : refundByNumberPath(kept.onChainId);
  return (
    <Sheet number={1} id="kept" title={isSetUp ? SITE.yours.keptSetUpTitle : SITE.yours.keptTitle} stamp={false}>
      <p className="lede">{isSetUp ? SITE.yours.keptSetUp(kept.kept.name) : SITE.yours.kept(kept.kept.name)}</p>
      <p className="actions">
        <a className="primary" href={ROUTES.post}>{isSetUp ? SITE.yours.finishSetUp : SITE.yours.finish}</a>
        {takeBack && <a href={takeBack}>{SITE.job.money.takeBack}</a>}
      </p>
    </Sheet>
  );
}
