import type { ReactElement } from "react";
import { jobPath } from "../../../routes.ts";
import { inCoins, lengthOf, SITE, stampOf } from "../copy.ts";
import type { TileView } from "../views/index.ts";
import { AgentLink } from "./AgentLink.tsx";
import { Seal } from "./Seal.tsx";

/**
 * One job as a flyer on the wall. The whole flyer opens the job: its heading carries the link for a
 * keyboard and a screen reader, and the link's cover spreads over the flyer for a mouse, under the
 * agents' and the receipt's own links.
 */
export function JobFlyer({ tile, coin }: { readonly tile: TileView; readonly coin: string }): ReactElement {
  const facts = [
    inCoins(tile.price, coin),
    tile.mode,
    ...(tile.seconds ? [SITE.tile.ranIn(lengthOf(tile.seconds))] : []),
  ];
  return (
    <article className={`flyer ${tile.verdict}`}>
      <p className="flyer-stamp" aria-hidden="true">{stampOf(tile)}</p>
      <Seal tile={tile} />
      <div className="flyer-said">
        <h2><a href={jobPath(tile.jobId)}>{tile.idea}</a></h2>
        <p className="standing">{tile.standing}</p>
        {(tile.pod.length > 0 || tile.openSeats > 0) && (
          <ul className="pod">
            {tile.pod.map((seat) => (
              <li key={`${seat.role}-${seat.agent}`}><span className="role">{seat.role}</span> <AgentLink agent={seat.agent} /></li>
            ))}
            {tile.openSeats > 0 && <li className="waiting">{SITE.tile.seatsOpen(tile.openSeats)}</li>}
          </ul>
        )}
        <p className="flyer-facts">
          {facts.join(" · ")}
          {tile.commit && <> · {SITE.tile.commit} <code>{tile.commit.slice(0, 7)}</code></>}
        </p>
        <p className="flyer-links">
          {tile.receipt ? <a href={tile.receipt}>{SITE.tile.receipt}</a> : <span className="none">{SITE.tile.noReceipt}</span>}
        </p>
      </div>
    </article>
  );
}
