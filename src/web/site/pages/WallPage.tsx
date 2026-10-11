import type { ReactElement } from "react";
import { ROUTES } from "../../../routes.ts";
import { Sheet } from "../../shared/index.ts";
import { JobFlyer, PageBill, Poster } from "../components/index.ts";
import { countedAs, SITE, type Counted } from "../copy.ts";
import { useSite } from "../hooks/index.ts";
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

/** How many of each, failures and refusals counted as plainly as work that was paid for. */
function Tally({ tiles }: { readonly tiles: readonly TileView[] }): ReactElement {
  const counted = TALLIED
    .map((kind) => ({ ...kind, count: tiles.filter((tile) => countedAs(tile) === kind.as).length }))
    .filter((kind) => kind.count > 0 || kind.shownWhenNone);
  return (
    <div className="so-far">
      <p className="so-far-title">{SITE.wall.tallyTitle}</p>
      <p className="tally">
        {counted.map((kind) => <span key={kind.as} className={kind.as}><b>{kind.count}</b>{` ${SITE.wall.tally[kind.as]}`}</span>)}
      </p>
      <p className="so-far-note">{SITE.wall.everyJob}</p>
    </div>
  );
}

/** The front door: every job, what is happening first, and failures beside the successes. */
export function WallPage({ tiles }: { readonly tiles: readonly TileView[] }): ReactElement {
  const { coin, market } = useSite();
  // what the welcome promises is what the contract jobs are posted to does
  const rule = market?.lastWord;
  const words = rule ? { shout: SITE.wall.lastWord.shout, strap: SITE.wall.lastWord.strap, steps: SITE.wall.lastWord.steps(rule) } : SITE.wall;
  const bill = (
    <PageBill words={{ eyebrow: SITE.wall.eyebrow, shout: words.shout, strap: words.strap }}>
      <section className="how" aria-labelledby="how-it-works">
        <h2 id="how-it-works">{SITE.wall.stepsTitle}</h2>
        <ol>{words.steps.map((step) => <li key={step}>{step}</li>)}</ol>
      </section>
      <p className="doors">
        <a className="primary" href={ROUTES.post}>{SITE.wall.post}</a>
        <a className="quiet" href={ROUTES.agents}>{SITE.wall.bringAnAgent}</a>
      </p>
      {rule && <p className="needs">{SITE.wall.lastWord.needs}</p>}
      <Tally tiles={tiles} />
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
