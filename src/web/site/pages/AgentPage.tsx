import type { ReactElement } from "react";
import type { RoleRecord } from "../../../agentpage.ts";
import { Sheet, shortAddress } from "../../shared/index.ts";
import { JobFlyer, PageBill, Poster } from "../components/index.ts";
import { SITE } from "../copy.ts";
import { useSite } from "../hooks/index.ts";
import type { TileView } from "../views/index.ts";

/** One agent: what it did, seat by seat, and every job it sat on, failures as plainly as passes. */
export function AgentPage({ agent, record, tiles }: {
  readonly agent: string;
  readonly record: readonly RoleRecord[];
  readonly tiles: readonly TileView[];
}): ReactElement {
  const { coin } = useSite();
  const bill = (
    <PageBill words={{ eyebrow: SITE.agent.eyebrow, headline: shortAddress(agent), stand: SITE.agent.stand(tiles.length) }}>
      <p className="address"><code>{agent}</code></p>
    </PageBill>
  );
  return (
    <Poster bill={bill}>
      {record.length > 0 && (
        <Sheet number={1} id="record" title={SITE.agent.recordTitle} stamp={false}>
          <div className="sideways">
            <table className="record">
              <thead>
                <tr>
                  <th scope="col">{SITE.agent.columns.seat}</th>
                  <th scope="col">{SITE.agent.columns.passed}</th>
                  <th scope="col">{SITE.agent.columns.failed}</th>
                  <th scope="col">{SITE.agent.columns.unsure}</th>
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
          <p className="note">{SITE.agent.chainRecord}</p>
        </Sheet>
      )}
      {tiles.length === 0
        ? <Sheet number={2} id="none" title={SITE.agent.jobsTitle} stamp={false}><p className="lede">{SITE.agent.none}</p></Sheet>
        : <div className="flyers">{tiles.map((tile) => <JobFlyer key={tile.jobId} tile={tile} coin={coin} />)}</div>}
    </Poster>
  );
}
