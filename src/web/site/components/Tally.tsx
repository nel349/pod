import type { ReactElement } from "react";
import { countedAs, SITE, type Counted } from "../copy.ts";
import type { TileView } from "../views/index.ts";

/** every way a job is counted, in the order the wall says them, and whether a count of none is still said */
const TALLIED: readonly { readonly as: Counted; readonly shownWhenNone: boolean }[] = [
  { as: "open", shownWhenNone: false },
  { as: "delivered", shownWhenNone: false },
  { as: "paid", shownWhenNone: true },
  { as: "refused", shownWhenNone: false },
  { as: "failed", shownWhenNone: true },
  { as: "unsure", shownWhenNone: false },
  { as: "withdrawn", shownWhenNone: false },
];

/**
 * How many of each, failures and refusals counted as plainly as work that was paid for.
 * @param note a line under the count, such as that every one of them is on this page, where that is so
 */
export function Tally({ tiles, note }: { readonly tiles: readonly TileView[]; readonly note?: string }): ReactElement {
  const counted = TALLIED
    .map((kind) => ({ ...kind, count: tiles.filter((tile) => countedAs(tile) === kind.as).length }))
    .filter((kind) => kind.count > 0 || kind.shownWhenNone);
  return (
    <div className="so-far">
      <p className="so-far-title">{SITE.wall.tallyTitle}</p>
      <p className="tally">
        {counted.map((kind) => <span key={kind.as} className={kind.as}><b>{kind.count}</b>{` ${SITE.wall.tally[kind.as]}`}</span>)}
      </p>
      {note && <p className="so-far-note">{note}</p>}
    </div>
  );
}
