import type { ReactElement } from "react";
import type { MarketConfig } from "../../market.ts";
import { usePath } from "../shared/index.ts";
import { Bill } from "./components/index.ts";
import { PayFirstPage } from "./PayFirstPage.tsx";
import { PostJobPage } from "./PostJobPage.tsx";
import { PreparedJobPage } from "./PreparedJobPage.tsx";
import { COPY, preparedNumberIn } from "./state/index.ts";

/** The poster, with one sheet saying why there is no form. */
function Notice({ children }: { readonly children: string }): ReactElement {
  return (
    <div className="poster">
      <Bill />
      <main className="sheets"><section className="sheet notice"><p>{children}</p></section></main>
    </div>
  );
}

/**
 * Posting, inside the one app: on a contract that prepares jobs, the pay-first page, or a paid job's own
 * page at /post/<number>; otherwise the page that has the checks written before paying.
 */
export function PostPages({ market }: { readonly market: MarketConfig | undefined }): ReactElement {
  const paidJob = preparedNumberIn(usePath());
  if (!market) return <Notice>{COPY.closed}</Notice>;
  if (!market.writing) return <PostJobPage market={market} />;
  return paidJob === undefined
    ? <PayFirstPage market={market} writing={market.writing} />
    : <PreparedJobPage key={paidJob} market={market} onChainId={paidJob} />;
}
