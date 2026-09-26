import type { ReactElement } from "react";
import { Sheet } from "../../../shared/index.ts";
import { SITE } from "../../copy.ts";
import type { JobView } from "../../views.ts";

/** What was asked for, in the poster's words, and the fingerprint that fixed them before anybody started. */
export function AskedSheet({ job }: { readonly job: JobView }): ReactElement {
  return (
    <Sheet number={1} id="asked" title={job.verdict === "running" ? SITE.job.asked.running : SITE.job.asked.done} stamp={false}>
      <p className="lede">{job.idea}</p>
      {job.howItIsAsked && <p className="how-asked"><b>{SITE.job.howItIsAsked}:</b> {job.howItIsAsked}</p>}
      <details className="behind">
        <summary>{SITE.job.sealedBefore}</summary>
        <p>{SITE.job.sealedMeans}</p>
        <p><code>{job.seal}</code></p>
      </details>
    </Sheet>
  );
}
