import type { ReactElement } from "react";
import { explorerAddress, explorerTransaction } from "../../../../market.ts";
import { Sheet, shortAddress } from "../../../shared/index.ts";
import { InTheBrowser, When } from "../../components/index.ts";
import { SITE } from "../../copy.ts";
import { useIsViewer, useSite } from "../../hooks/index.ts";
import type { JobView, TitleView } from "../../views/index.ts";

function You({ holder }: { readonly holder: string }): ReactElement | null {
  const isViewer = useIsViewer();
  return isViewer(holder) ? <> ({SITE.job.you})</> : null;
}

function Title({ title }: { readonly title: TitleView }): ReactElement {
  const { market } = useSite();
  return (
    <>
      <p>{SITE.job.title(title.tokenId)}</p>
      <p>
        {title.holder
          ? <>{SITE.job.heldBy} {market
            ? <a href={explorerAddress(market.explorer, title.holder)} title={title.holder}><code>{shortAddress(title.holder)}</code></a>
            : <code title={title.holder}>{shortAddress(title.holder)}</code>}
            <InTheBrowser><You holder={title.holder} /></InTheBrowser>.</>
          : SITE.job.holderUnread}
      </p>
      {title.invited && <p className="note">{SITE.job.invitedTo(title.invited.account)} <When iso={title.invited.at} />. {SITE.job.invitationLasts}</p>}
      {title.claim && <p><a className="primary" href={title.claim}>{SITE.job.claim}</a></p>}
    </>
  );
}

/** Where the work is, who holds the title to it, and where to read the same on the chain. */
export function OwnsSheet({ job }: { readonly job: JobView }): ReactElement | null {
  const { market } = useSite();
  const hasSomething = job.repository || job.title || job.chain || job.verdict === "passed";
  if (!hasSomething) return null;
  const transaction = (hash: string, words: string): ReactElement =>
    market ? <a href={explorerTransaction(market.explorer, hash)}>{words}</a> : <span title={hash}>{words}</span>;
  return (
    <Sheet number={7} id="owns" title={SITE.job.ownsTitle} stamp={false}>
      {job.repository && (
        <p className="lede"><a href={job.repository}>{job.repository.replace(/^https:\/\/github\.com\//, "")}</a> {SITE.job.work}</p>
      )}
      {job.title ? <Title title={job.title} /> : job.verdict === "passed" && <p>{SITE.job.noTitle}</p>}
      {job.chain && (
        <p className="note">
          {market ? <a href={explorerAddress(market.explorer, job.chain.jobs)}>{SITE.job.onChain(job.chain.jobId)}</a> : SITE.job.onChain(job.chain.jobId)}
          {job.chain.settled && <>; {transaction(job.chain.settled, SITE.job.settledTx)}</>}
          {job.chain.minted && <>; {transaction(job.chain.minted, SITE.job.mintedTx)}</>}.
        </p>
      )}
    </Sheet>
  );
}
