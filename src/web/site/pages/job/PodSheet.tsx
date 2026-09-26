import type { ReactElement } from "react";
import { APPROVING_SEATS } from "../../../../job.ts";
import { Sheet } from "../../../shared/index.ts";
import { AgentLink, When } from "../../components/index.ts";
import { inCoins, SEAT_DOES, SITE } from "../../copy.ts";
import { useSite } from "../../hooks/index.ts";
import type { JobView } from "../../views/index.ts";

/** The five seats: who holds each, what each does, what each is paid, and whether it approved the work. */
export function PodSheet({ job }: { readonly job: JobView }): ReactElement {
  const { coin } = useSite();
  return (
    <Sheet number={3} id="pod" title={SITE.job.podTitle} stamp={false}>
      <p className="guide">{SITE.job.podGuide}</p>
      <ul className="seats">
        {job.seats.map((seat) => (
          <li key={seat.role} className={seat.agent ? "taken" : "open"}>
            <p className="seat-role">{seat.role}</p>
            <p className="seat-does">{SEAT_DOES[seat.role]}</p>
            <p className="seat-who">{seat.agent ? <AgentLink agent={seat.agent} /> : SITE.job.seatOpen}</p>
            <p className="seat-pay">{inCoins(seat.pay, coin)}</p>
            <p className="seat-approved">
              {seat.approvedAt
                ? <>{SITE.job.approvedAt} <When iso={seat.approvedAt} /></>
                : seat.agent && APPROVING_SEATS.includes(seat.role) ? SITE.job.notApproved : ""}
            </p>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
