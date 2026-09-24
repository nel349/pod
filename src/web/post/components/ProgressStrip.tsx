import type { ReactElement } from "react";
import { COPY, type Progress, type StepName } from "../state/index.ts";
import { ShardSeal } from "./ShardSeal.tsx";

/**
 * On a phone the bill scrolls away before the form begins, and with it the seal. This strip keeps a
 * small copy and the next step pinned to the top while the poster works through the sheets. On a
 * wide screen the bill stays in view by itself, so this is not shown. It repeats the bill, so it is
 * hidden from screen readers, which already have the bill.
 */
export function ProgressStrip({ progress, working }: { readonly progress: Progress; readonly working?: StepName }): ReactElement {
  return (
    <div className="strip" aria-hidden="true">
      <ShardSeal progress={progress} working={working} />
      <p>{COPY.next[progress.next ?? "done"]}</p>
    </div>
  );
}
