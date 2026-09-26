import type { ReactElement } from "react";
import { explorerAddress } from "../../../market.ts";
import { Sheet } from "../../shared/index.ts";
import { COPY, type OnChainNow, type Refundable, type Standing } from "../state/index.ts";

/** The job, the money in it, who posted it, and where it stands. */
export function StandsSheet({ job, onChain, standing, coin, explorer }: {
  readonly job: Refundable;
  readonly onChain: OnChainNow;
  readonly standing: Standing;
  readonly coin: string;
  readonly explorer: string;
}): ReactElement {
  return (
    <Sheet number={1} id="stands" title={COPY.stands.title}>
      <p className="lede">{job.idea}</p>
      <dl className="facts">
        <dt>{COPY.stands.amount(onChain.price, coin)}</dt>
        <dd>{COPY.stands.posted} <a href={explorerAddress(explorer, onChain.poster)}><code>{onChain.poster}</code></a></dd>
      </dl>
      <p id="standing" className="refund-standing" data-standing={standing.kind}>{COPY.stands.said(standing)}</p>
    </Sheet>
  );
}
