import type { ReactElement } from "react";
import { ROUTES } from "../../../routes.ts";
import { COPY, type Progress, type StepName } from "../state/index.ts";
import { ShardSeal } from "./ShardSeal.tsx";

interface BillProps {
  readonly progress?: Progress;
  readonly working?: StepName;
  readonly flash?: number;
}

/**
 * The poster on the left: what this is, in the loudest type on the page, and the seal assembling as
 * the job does. Under it, one line saying what to do next: the seal says how far, this says where.
 */
export function Bill({ progress, working, flash }: BillProps): ReactElement {
  return (
    <aside className="bill">
      <p className="eyebrow"><a href={ROUTES.wall}>Proof of Development</a> / {COPY.masthead.eyebrow}</p>
      <h1 className="shout">
        {COPY.masthead.shout.map((line) => <span key={line} data-text={line}>{line}</span>)}
        <span className="strap">{COPY.masthead.strap}</span>
      </h1>
      <p className="stand">{COPY.masthead.stand}</p>
      {progress && (
        <figure className="seal-figure">
          <ShardSeal progress={progress} working={working} flash={flash} />
          {progress.placed.has("pay") && <p className="sealed-stamp" aria-hidden="true">{COPY.stamp}</p>}
          <figcaption className="next">{COPY.next[progress.next ?? "done"]}</figcaption>
        </figure>
      )}
    </aside>
  );
}
