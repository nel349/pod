import type { ReactElement, ReactNode } from "react";
import { ROUTES } from "../../../routes.ts";
import { SITE } from "../copy.ts";

/** What a bill says: where you are, the loud part, and a sentence under it. */
export interface BillWords {
  readonly eyebrow: string;
  /** a few short words, one to a line, misprinted */
  readonly shout?: readonly string[];
  /** a longer line, such as a job's idea, set big but free to wrap */
  readonly headline?: string;
  readonly strap?: string;
  readonly stand?: string;
}

/** The yellow bill on the left of every page: the loudest type on it, and whatever the page adds under it. */
export function PageBill({ words, children }: { readonly words: BillWords; readonly children?: ReactNode }): ReactElement {
  return (
    <aside className="bill">
      <p className="eyebrow"><a href={ROUTES.wall}>{SITE.eyebrow}</a> / {words.eyebrow}</p>
      {words.shout && (
        <h1 className="shout">
          {words.shout.map((line) => <span key={line} data-text={line}>{line}</span>)}
          {words.strap && <span className="strap">{words.strap}</span>}
        </h1>
      )}
      {words.headline && <h1 className="headline">{words.headline}</h1>}
      {words.headline && words.strap && <p className="strap-line">{words.strap}</p>}
      {words.stand && <p className="stand">{words.stand}</p>}
      {children}
    </aside>
  );
}
