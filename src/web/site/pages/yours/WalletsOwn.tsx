import type { ReactElement } from "react";
import { Sheet } from "../../../shared/index.ts";
import { SITE } from "../../copy.ts";
import { useYours } from "../../hooks/index.ts";
import { YoursEntries } from "./YoursEntries.tsx";

/** What one wallet paid for and holds, as the server reads it from the chain. */
export function WalletsOwn({ address }: { readonly address: string }): ReactElement {
  const state = useYours(address);
  switch (state.kind) {
    case "loading": return <Sheet number={2} id="reading" title={SITE.yours.postedTitle} stamp={false}><p className="note">{SITE.yours.loading}</p></Sheet>;
    case "failed": return <Sheet number={2} id="reading" title={SITE.yours.postedTitle} stamp={false}><p className="said-status">{SITE.yours.failed(state.why)}</p></Sheet>;
    case "read": return (
      <>
        <Sheet number={2} id="posted" title={SITE.yours.postedTitle} stamp={false}>
          <YoursEntries entries={state.yours.posted} isHeld={false} none={SITE.yours.nothingPosted} />
          <p className="note">{SITE.yours.onlyThisBrowser}</p>
        </Sheet>
        <Sheet number={3} id="holds" title={SITE.yours.holdsTitle} stamp={false}>
          <YoursEntries entries={state.yours.holds} isHeld none={SITE.yours.nothingHeld} />
        </Sheet>
      </>
    );
  }
}
