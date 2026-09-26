import type { ReactElement } from "react";
import { ROUTES } from "../../../routes.ts";
import { Sheet } from "../../shared/index.ts";
import { JobFlyer, PageBill, Poster } from "../components/index.ts";
import { SITE } from "../copy.ts";
import { useSite } from "../hooks/index.ts";
import type { TileView, Verdict } from "../views/index.ts";

const TALLIED: readonly { readonly verdict: Verdict; readonly word: string; readonly shownWhenNone: boolean }[] = [
  { verdict: "running", word: SITE.wall.tally.open, shownWhenNone: false },
  { verdict: "passed", word: SITE.wall.tally.paid, shownWhenNone: true },
  { verdict: "failed", word: SITE.wall.tally.refused, shownWhenNone: true },
  { verdict: "not-reproducible", word: SITE.wall.tally.unsure, shownWhenNone: false },
];

/** How many of each, failures counted as plainly as passes. */
function Tally({ tiles }: { readonly tiles: readonly TileView[] }): ReactElement {
  const counted = TALLIED
    .map((kind) => ({ ...kind, count: tiles.filter((tile) => tile.verdict === kind.verdict).length }))
    .filter((kind) => kind.count > 0 || kind.shownWhenNone);
  return (
    <p className="tally">
      {counted.map((kind) => <span key={kind.verdict} className={kind.verdict}><b>{kind.count}</b>{` ${kind.word}`}</span>)}
    </p>
  );
}

/** The front door: every job, what is happening first, and failures beside the successes. */
export function WallPage({ tiles }: { readonly tiles: readonly TileView[] }): ReactElement {
  const { coin } = useSite();
  const bill = (
    <PageBill words={{ eyebrow: SITE.wall.eyebrow, shout: SITE.wall.shout, strap: SITE.wall.strap, stand: SITE.wall.stand }}>
      <Tally tiles={tiles} />
      <p><a className="primary" href={ROUTES.post}>{SITE.wall.post}</a></p>
    </PageBill>
  );
  return (
    <Poster bill={bill}>
      {tiles.length === 0
        ? (
          <Sheet number={1} id="nothing-yet" title={SITE.wall.emptyTitle} stamp={false}>
            <p className="lede">{SITE.wall.empty}</p>
          </Sheet>
        )
        : <div className="flyers">{tiles.map((tile) => <JobFlyer key={tile.jobId} tile={tile} coin={coin} />)}</div>}
    </Poster>
  );
}
