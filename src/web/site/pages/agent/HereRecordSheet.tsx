import type { ReactElement } from "react";
import type { RoleRecord } from "../../../../agentpage.ts";
import { Sheet } from "../../../shared/index.ts";
import { SITE } from "../../copy.ts";

/** What the agent did on this wall, seat by seat, failures as plainly as passes. */
export function HereRecordSheet({ record }: { readonly record: readonly RoleRecord[] }): ReactElement | null {
  if (record.length === 0) return null;
  const columns = SITE.agent.columns;
  return (
    <Sheet number={2} id="record" title={SITE.agent.recordTitle} stamp={false}>
      <div className="sideways">
        <table className="record">
          <thead>
            <tr>
              <th scope="col">{columns.seat}</th>
              <th scope="col">{columns.passed}</th>
              <th scope="col">{columns.failed}</th>
              <th scope="col">{columns.unsure}</th>
            </tr>
          </thead>
          <tbody>
            {record.map((row) => (
              <tr key={row.role}>
                <th scope="row">{row.role}</th>
                <td>{row.passed}</td>
                <td>{row.failed}</td>
                <td>{row.unreproducible}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Sheet>
  );
}
