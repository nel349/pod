import type { ReactElement } from "react";
import { Sheet } from "../../../shared/index.ts";
import { SITE } from "../../copy.ts";
import type { AgentFactsView } from "../../views/index.ts";

type Seats = NonNullable<AgentFactsView["identity"]>["seats"];

/** The record ERC-8004 keeps of the agent, seat by seat, as our runner recorded it: counted, not averaged. */
export function ChainRecordSheet({ seats }: { readonly seats: Seats }): ReactElement | null {
  if (seats.length === 0) return null;
  const columns = SITE.agent.chainColumns;
  return (
    <Sheet number={3} id="on-chain" title={SITE.agent.chainTitle} stamp={false}>
      <p className="guide">{SITE.agent.chainGuide}</p>
      <div className="sideways">
        <table className="record">
          <thead>
            <tr>
              <th scope="col">{columns.seat}</th>
              <th scope="col">{columns.recorded}</th>
              <th scope="col">{columns.passed}</th>
              <th scope="col">{columns.unsure}</th>
            </tr>
          </thead>
          <tbody>
            {seats.map((seat) => (
              <tr key={seat.role}>
                <th scope="row">{seat.role}</th>
                <td>{seat.recorded}</td>
                <td>{seat.passed}</td>
                <td>{seat.unsure}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Sheet>
  );
}
