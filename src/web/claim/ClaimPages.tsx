import type { ReactElement } from "react";
import type { MarketConfig } from "../../market.ts";
import { usePath } from "../shared/index.ts";
import { ClaimBill } from "./components/index.ts";
import { ClaimPage } from "./ClaimPage.tsx";
import { COPY, jobIdFrom } from "./state/index.ts";

/** Claiming a repository, inside the one app: the job its own address names, or why it cannot be claimed here. */
export function ClaimPages({ market }: { readonly market: MarketConfig | undefined }): ReactElement {
  const jobId = jobIdFrom(usePath());
  if (!market) {
    return (
      <div className="poster">
        <ClaimBill />
        <main className="sheets"><section className="sheet notice"><p>{COPY.closed}</p></section></main>
      </div>
    );
  }
  return <ClaimPage key={jobId} jobId={jobId} market={market} />;
}
