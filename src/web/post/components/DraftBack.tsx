import type { ReactElement } from "react";
import { COPY } from "../state/index.ts";

/** Said once, above a draft the page brought back: that it is the poster's own, and how to throw it away. */
export function DraftBack({ onStartAgain }: { readonly onStartAgain: () => void }): ReactElement {
  return (
    <p className="draft-back" role="status">
      {COPY.draftBack.says} <button type="button" className="quiet" onClick={onStartAgain}>{COPY.draftBack.startAgain}</button>
    </p>
  );
}
