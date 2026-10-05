import type { ReactElement } from "react";
import { Sheet } from "../../../shared/index.ts";
import { THIS_SITE } from "../../../../jobpage.ts";
import { SITE } from "../../copy.ts";
import { useSite } from "../../hooks/index.ts";
import type { JobView } from "../../views/index.ts";

/** The run we did, written out so anybody can do it again, and the receipt that records it. */
export function RepeatSheet({ receipt }: { readonly receipt: NonNullable<JobView["receipt"]> }): ReactElement {
  const { site } = useSite();
  return (
    <Sheet number={6} id="repeat" title={SITE.job.repeatTitle} stamp={false}>
      <p className="guide">{SITE.job.repeatGuide}</p>
      {/* the receipt names this site's own copy of the code by its path; the reader copies the whole address */}
      <pre className="repeat">{receipt.repeat.replaceAll(THIS_SITE, site)}</pre>
      <p className="note"><a href={receipt.page}>{SITE.job.readReceipt}</a>, or <a href={receipt.file}>{SITE.job.signedFile}</a>.</p>
    </Sheet>
  );
}
