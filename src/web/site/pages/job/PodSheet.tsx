import type { ReactElement } from "react";
import { APPROVING_SEATS } from "../../../../job.ts";
import { Sheet } from "../../../shared/index.ts";
import { AgentLink, When } from "../../components/index.ts";
import { agentRecordWords, inCoins, seatDoes, SITE } from "../../copy.ts";
import { useSite } from "../../hooks/index.ts";
import type { JobView, SeatView } from "../../views/index.ts";

/**
 * What a seat said of the work. Where the builder puts its own work forward: that it did, that a seat
 * stands behind it, or that it did not, once the work is delivered and nobody can sign on any more.
 * On the contracts before: whether a seat whose approval was waited for has given it.
 */
function WhatItSaid({ seat, job }: { readonly seat: SeatView; readonly job: JobView }): ReactElement | null {
  if (!seat.agent) return null;
  // delivered: who stands behind it is settled, and is what its poster's answer pays
  if (job.delivery) {
    if (!seat.approvedAt) return <>{SITE.job.behind.doesNot}</>;
    return <>{seat.role === "builder" ? SITE.job.behind.putForward : SITE.job.behind.stands} <When iso={seat.approvedAt} />{seat.isKeptFromPay && <>. {SITE.job.behind.keptFromPay}</>}</>;
  }
  // still being built or reviewed there: who stands behind it is the contract's to say, and may yet change
  if (job.hasLastWord) return null;
  if (seat.approvedAt) return <>{SITE.job.approvedAt} <When iso={seat.approvedAt} /></>;
  return APPROVING_SEATS.includes(seat.role) ? <>{SITE.job.notApproved}</> : null;
}

/** The five seats: who holds each, what each does, what each is paid, and what it said of the work. */
export function PodSheet({ job }: { readonly job: JobView }): ReactElement {
  const { coin } = useSite();
  return (
    <Sheet number={3} id="pod" title={SITE.job.podTitle} stamp={false}>
      <p className="guide">{job.leadNames ? SITE.job.podGuideWhereTheLeadNames : job.hasLastWord ? SITE.job.podGuideForAnAnswer : SITE.job.podGuide}</p>
      <ul className="seats">
        {job.seats.map((seat) => (
          <li key={seat.role} className={seat.agent ? "taken" : "open"}>
            <p className="seat-role">{seat.role}</p>
            <p className="seat-does">{seatDoes(seat.role, job.hasLastWord === true, job.leadNames === true)}</p>
            <p className="seat-who">
              {seat.agent ? <AgentLink agent={seat.agent} /> : SITE.job.seatOpen}
              {seat.record && <span className="seat-record">{agentRecordWords(seat.record)}</span>}
            </p>
            {/* a seat the lead did not name is paid none of its share, and the page says where that money goes instead */}
            <p className={seat.isKeptFromPay ? "seat-pay kept" : "seat-pay"}>
              {inCoins(seat.pay, coin)}
              {seat.isKeptFromPay && <span className="seat-pay-kept">{SITE.job.behind.payGoesBack}</span>}
            </p>
            <p className="seat-approved"><WhatItSaid seat={seat} job={job} /></p>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
