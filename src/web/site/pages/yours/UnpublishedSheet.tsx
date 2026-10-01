import type { ReactElement } from "react";
import { Sheet } from "../../../shared/index.ts";
import { inCoins, SITE } from "../../copy.ts";
import { useSite } from "../../hooks/index.ts";
import type { UnpublishedView } from "../../views/index.ts";
import { MoneyNext } from "./MoneyNext.tsx";

/** One job not on the wall: being prepared, never sent its lines, or paid and never published. */
function NotOnTheWall({ job, coin }: { readonly job: UnpublishedView; readonly coin: string }): ReactElement {
  const price = inCoins(job.price, coin);
  const { money } = job;
  switch (money.kind) {
    case "preparing": return (
      <>
        <p className="yours-idea">{SITE.yours.preparing(job.onChainId, price)}</p>
        <p><a className="primary small" href={money.page}>{SITE.yours.openPreparing}</a></p>
      </>
    );
    case "notSetUp": return (
      <>
        <p className="yours-idea">{SITE.yours.notSetUp(job.onChainId, price)}</p>
        <p><a className="primary small" href={money.page}>{SITE.yours.takeBackNotSetUp}</a></p>
      </>
    );
    default: return (
      <>
        <p className="yours-idea">{SITE.yours.unpublished(job.onChainId, price)}</p>
        <MoneyNext money={money} />
      </>
    );
  }
}

/**
 * Jobs this wallet paid for that are not on the wall, from whichever browser paid: being prepared, never
 * sent to be written, or paid and never published. Said when the chain could not be read, rather than
 * showing nothing, which would look like there is nothing.
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
            {unpublished.map((job) => <li key={job.onChainId}><NotOnTheWall job={job} coin={coin} /></li>)}
          </ul>
        )}
    </Sheet>
  );
}
