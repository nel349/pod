import type { ReactElement } from "react";
import { ROUTES } from "../../../routes.ts";
import { COPY } from "../state/index.ts";

/** The poster on the left: what this page is for, in the loudest type on it. */
export function RefundBill(): ReactElement {
  return (
    <aside className="bill">
      <p className="eyebrow"><a href={ROUTES.wall}>Proof of Development</a> / {COPY.masthead.eyebrow}</p>
      <h1 className="shout">
        {COPY.masthead.shout.map((line) => <span key={line} data-text={line}>{line}</span>)}
        <span className="strap">{COPY.masthead.strap}</span>
      </h1>
      <p className="stand">{COPY.masthead.stand}</p>
    </aside>
  );
}
