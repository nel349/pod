import type { ReactElement } from "react";
import { Sheet } from "../../../shared/index.ts";
import { InTheBrowser } from "../../components/index.ts";
import { SITE } from "../../copy.ts";
import { useIsViewer } from "../../hooks/index.ts";
import type { JobView } from "../../views/index.ts";

/** What the poster's answer does to the live website, said to them as "you" when the wallet here is theirs. */
function StaysOrGoes({ poster }: { readonly poster: string | undefined }): ReactElement {
  const isViewer = useIsViewer();
  return <>{isViewer(poster) ? SITE.job.live.staysOrGoesYours : SITE.job.live.staysOrGoes}</>;
}

/**
 * The door to what was built: a delivered website at its own address, first on the page, since a
 * poster decides by opening the work. Nothing is drawn for work that has no address to open.
 */
export function OpenSheet({ job }: { readonly job: JobView }): ReactElement | null {
  const { live, notLiveBecause } = job;
  if (!live && !notLiveBecause) return null;
  const isAwaited = job.delivery?.answer === "awaited";
  return (
    <Sheet number={1} id="open" title={SITE.job.live.title} stamp={false}>
      {live && !live.isDown && (
        <div id="live" className="live-site">
          <p className="lede">{SITE.job.live.says(live.host)}</p>
          <p><a className="primary" href={live.url} rel="noopener noreferrer">{SITE.job.live.open}</a> <a href={live.url} rel="noopener noreferrer">{live.url.replace(/^https?:\/\//, "")}</a></p>
          {isAwaited && <p className="note"><InTheBrowser fallback={SITE.job.live.staysOrGoes}><StaysOrGoes poster={job.poster} /></InTheBrowser></p>}
        </div>
      )}
      {live?.isDown && <p className="note">{SITE.job.live.down}</p>}
      {notLiveBecause && <p className="note">{SITE.job.live.not(notLiveBecause.replace(/\.$/, ""))}</p>}
    </Sheet>
  );
}
