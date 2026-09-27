import type { ReactElement } from "react";
import { Sheet } from "../../../shared/index.ts";
import { inCoins, SITE } from "../../copy.ts";
import { useSite } from "../../hooks/index.ts";
import type { UnpublishedView } from "../../views/index.ts";
import { MoneyNext } from "./MoneyNext.tsx";

/**
 * Jobs this wallet paid for that never reached the wall, from whichever browser paid: the money is in
 * the contract, and the one thing to do is take it back once the window closes. Said when the chain
 * could not be read, rather than showing nothing, which would look like there is nothing.
 */
export function UnpublishedSheet({ unpublished }: { readonly unpublished: readonly UnpublishedView[] | undefined }): ReactElement | null {
  const { coin } = useSite();
  if (unpublished?.length === 0) return null;
  return (
    <Sheet number={3} id="unpublished" title={SITE.yours.unpublishedTitle} stamp={false}>
      {unpublished === undefined
        ? <p className="said-status">{SITE.yours.unpublishedUnread}</p>
        : (
          <ul className="yours-list">
            {unpublished.map((job) => (
              <li key={job.onChainId}>
                <p className="yours-idea">{SITE.yours.unpublished(job.onChainId, inCoins(job.price, coin))}</p>
                <MoneyNext money={job.money} />
              </li>
            ))}
          </ul>
        )}
    </Sheet>
  );
}
