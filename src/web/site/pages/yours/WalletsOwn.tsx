import type { ReactElement } from "react";
import { Sheet } from "../../../shared/index.ts";
import { SITE } from "../../copy.ts";
import { useYours } from "../../hooks/index.ts";
import { UnpublishedSheet } from "./UnpublishedSheet.tsx";
import { YoursEntries } from "./YoursEntries.tsx";

/**
 * What one wallet paid for and holds, as the server reads it from the chain. A payment this browser
 * kept has its own sheet, where it can be finished, so it is not listed a second time.
 */
export function WalletsOwn({ address, keptOnChainId }: { readonly address: string; readonly keptOnChainId: string | undefined }): ReactElement {
  const state = useYours(address);
  switch (state.kind) {
    case "loading": return <Sheet number={2} id="reading" title={SITE.yours.postedTitle} stamp={false}><p className="note">{SITE.yours.loading}</p></Sheet>;
    case "failed": return <Sheet number={2} id="reading" title={SITE.yours.postedTitle} stamp={false}><p className="said-status">{SITE.yours.failed(state.why)}</p></Sheet>;
    case "read": return (
      <>
        <Sheet number={2} id="posted" title={SITE.yours.postedTitle} stamp={false}>
          <YoursEntries entries={state.yours.posted} isHeld={false} none={SITE.yours.nothingPosted} />
        </Sheet>
        <UnpublishedSheet unpublished={state.yours.unpublished?.filter((job) => job.onChainId !== keptOnChainId)} />
        <Sheet number={4} id="holds" title={SITE.yours.holdsTitle} stamp={false}>
          <YoursEntries entries={state.yours.holds} isHeld none={SITE.yours.nothingHeld} />
        </Sheet>
      </>
    );
  }
}
