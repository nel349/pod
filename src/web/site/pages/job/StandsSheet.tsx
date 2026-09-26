import type { ReactElement } from "react";
import { Sheet } from "../../../shared/index.ts";
import { InTheBrowser, When } from "../../components/index.ts";
import { SITE, timeLeft, whatHappensNext } from "../../copy.ts";
import { useIsViewer, useNow } from "../../hooks/index.ts";
import { moneyAt, type JobView, type MoneyView } from "../../views/index.ts";

/** A line only the poster reads: that money held is theirs to take back if the window closes first. */
function IfYours({ poster }: { readonly poster: string | undefined }): ReactElement | null {
  const isViewer = useIsViewer();
  return isViewer(poster) ? <> {SITE.job.money.heldYours}</> : null;
}

function Money({ money, poster }: { readonly money: MoneyView; readonly poster: string | undefined }): ReactElement {
  const now = useNow();
  const standing = moneyAt(money, now);
  switch (standing.kind) {
    case "held":
      return (
        <p className="money">
          {SITE.job.money.heldUntil} <When iso={standing.endsAt} />, {timeLeft(standing.endsAt, now)}. {SITE.job.money.onlyTheVerdict}
          <InTheBrowser><IfYours poster={poster} /></InTheBrowser>
        </p>
      );
    case "returnable":
      return (
        <>
          <p className="money">{SITE.job.money.returnable}</p>
          <p><a className="primary" href={standing.takeBack}>{SITE.job.money.takeBack}</a></p>
        </>
      );
    case "paid": return <p className="money">{SITE.job.money.paid}</p>;
    case "refunded": return <p className="money">{SITE.job.money.refunded}</p>;
  }
}

/** Where the job stands, what happens next, and where the money is, kept current while it runs. */
export function StandsSheet({ job, lostTouch }: { readonly job: JobView; readonly lostTouch: boolean }): ReactElement {
  const isRunning = job.verdict === "running";
  return (
    <Sheet number={2} id="stands" title={SITE.job.standsTitle} stamp={false}>
      <p className="lede">{whatHappensNext(job.verdict, job.seats.filter((seat) => seat.agent).length)}</p>
      {job.waitingBecause && <p className="note">{SITE.job.waitingBecause(job.waitingBecause)}</p>}
      {job.money && <Money money={job.money} poster={job.poster} />}
      {isRunning && <p className="note live" role="status">{lostTouch ? SITE.job.lostTouch : SITE.job.follows}</p>}
    </Sheet>
  );
}
