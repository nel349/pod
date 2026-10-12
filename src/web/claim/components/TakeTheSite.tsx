import type { ReactElement } from "react";
import { COPY, type SiteToTake } from "../state/index.ts";

/** The link that takes the job's live website into the holder's own account, shown to them alone. */
export function TakeTheSite({ site }: { readonly site: SiteToTake }): ReactElement {
  return (
    <div id="take-the-site" className="take-the-site">
      <p><a className="primary" href={site.takeIt}>{COPY.site.takeIt(site.host)}</a></p>
      <p className="note">{COPY.site.takeItSays(site.host)}</p>
    </div>
  );
}
