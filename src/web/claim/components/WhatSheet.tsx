import type { ReactElement } from "react";
import { COPY, shortRepository, type Claimable } from "../state/index.ts";
import { explorerAddress } from "../../../market.ts";
import { Sheet } from "../../shared/index.ts";

/** The title, the repository it is title to, and who holds it now. */
export function WhatSheet({ claimable, explorer }: { readonly claimable: Claimable; readonly explorer: string }): ReactElement {
  return (
    <Sheet number={1} id="what" title={COPY.what.title}>
      <p className="lede">{claimable.idea}</p>
      <dl className="facts">
        <dt>{COPY.what.pod(claimable.tokenId)}</dt>
        <dd>{COPY.what.repository}: <a href={claimable.repository}>{shortRepository(claimable.repository)}</a></dd>
        <dt>{COPY.what.holder}</dt>
        <dd><a href={explorerAddress(explorer, claimable.holder)}><code>{claimable.holder}</code></a></dd>
      </dl>
      <p className="guide">{COPY.what.sold}</p>
    </Sheet>
  );
}
