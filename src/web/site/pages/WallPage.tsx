import type { ReactElement } from "react";
import { ROUTES } from "../../../routes.ts";
import { Sheet } from "../../shared/index.ts";
import { JobFlyer, PageBill, Poster, Tally } from "../components/index.ts";
import { SITE } from "../copy.ts";
import { useSite } from "../hooks/index.ts";
import type { TileView } from "../views/index.ts";

/**
 * Every job, what is happening first, and failures beside the successes. Where the poster has the last
 * word the front door is the welcome, which says how it works, and this page is the jobs alone. Anywhere
 * else this is the front door too, and says how it works itself.
 */
export function WallPage({ tiles }: { readonly tiles: readonly TileView[] }): ReactElement {
  const { coin, market } = useSite();
  const hasAWelcome = market?.lastWord !== undefined;
  const doors = (
    <p className="doors">
      <a className="primary" href={ROUTES.post}>{SITE.wall.post}</a>
      <a className="quiet" href={ROUTES.agents}>{SITE.wall.bringAnAgent}</a>
    </p>
  );
  const bill = hasAWelcome
    ? (
      <PageBill words={{ eyebrow: SITE.wall.eyebrow, shout: SITE.wall.jobs.shout, strap: SITE.wall.jobs.strap }}>
        <Tally tiles={tiles} note={SITE.wall.everyJob} />
        {doors}
        <p className="doors"><a className="quiet" href={ROUTES.welcome}>{SITE.wall.jobs.how}</a></p>
      </PageBill>
    )
    : (
      <PageBill words={{ eyebrow: SITE.wall.eyebrow, shout: SITE.wall.shout, strap: SITE.wall.strap }}>
        <section className="how" aria-labelledby="how-it-works">
          <h2 id="how-it-works">{SITE.wall.stepsTitle}</h2>
          <ol>{SITE.wall.steps.map((step) => <li key={step}>{step}</li>)}</ol>
        </section>
        {doors}
        <Tally tiles={tiles} note={SITE.wall.everyJob} />
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
