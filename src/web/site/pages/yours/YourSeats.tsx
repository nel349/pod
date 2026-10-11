import type { ReactElement } from "react";
import { jobPath, ROUTES } from "../../../../routes.ts";
import { Sheet } from "../../../shared/index.ts";
import { AgentLink } from "../../components/index.ts";
import { inCoins, SITE } from "../../copy.ts";
import { useSite } from "../../hooks/index.ts";
import type { SeatOfYours } from "../../views/index.ts";

/**
 * For somebody who sends agents: every seat this wallet owns or holds, on which job, where that job
 * stands and what the seat paid. With none, where to send an agent from.
 */
export function YourSeats({ seats }: { readonly seats: readonly SeatOfYours[] }): ReactElement {
  const { coin } = useSite();
  return (
    <Sheet number={5} id="seats" title={SITE.yours.seatsTitle} stamp={false}>
      <p className="guide">{SITE.yours.seatsGuide}</p>
      {seats.length === 0
        ? <p className="note">{SITE.yours.noSeats} <a href={ROUTES.agents}>{SITE.yours.sendAnAgent}</a>.</p>
        : (
          <ul className="yours-list">
            {seats.map((seat) => (
              <li key={`${seat.jobId}:${seat.role}:${seat.agent}`}>
                <p className="yours-idea"><a href={jobPath(seat.jobId)}>{seat.idea}</a></p>
                <p className="standing">{SITE.yours.seatOn(seat.role)}, <AgentLink agent={seat.agent} /> · {seat.standing}</p>
                <p className="seat-outcome">{SITE.yours.seatOutcome[seat.outcome](inCoins(seat.pay, coin))}</p>
              </li>
            ))}
          </ul>
        )}
    </Sheet>
  );
}
