import type { ReactElement } from "react";
import { ROUTES } from "../../../../routes.ts";
import { Sheet } from "../../../shared/index.ts";
import { JobFlyer, PageBill, Poster, Tally } from "../../components/index.ts";
import { SITE, type LastWord } from "../../copy.ts";
import { useSite } from "../../hooks/index.ts";
import type { TileView } from "../../views/index.ts";
import { Film } from "./Film.tsx";
import { FilmControls } from "./FilmControls.tsx";
import { stepOf, STEPS } from "./story.ts";
import { useStory } from "./useStory.ts";

/** how many of the newest jobs the front door shows, as proof that the film is not only a film */
const NEWEST_SHOWN = 2;

/**
 * The front door, for somebody who has never been here: what POD is, as a film of one job from its
 * poster's first word to their last, the same steps in words, and the newest jobs really built here.
 */
export function WelcomePage({ tiles, rule }: { readonly tiles: readonly TileView[]; readonly rule: LastWord }): ReactElement {
  const { coin } = useSite();
  const story = useStory();
  const words = SITE.welcome;
  const steps = words.steps(rule);
  const bill = (
    <PageBill words={{ eyebrow: words.eyebrow, shout: words.shout, strap: words.strap }}>
      <p className="doors">
        <a className="primary" href={ROUTES.post}>{SITE.wall.post}</a>
        <a className="quiet" href={ROUTES.agents}>{SITE.wall.bringAnAgent}</a>
      </p>
      <p className="needs">{words.needs}</p>
      <p className="doors"><a className="quiet" href={ROUTES.wall}>{words.everyJob}</a></p>
    </PageBill>
  );
  return (
    <Poster bill={bill}>
      <section className="film" id="film" aria-label={words.controls.label}>
        <FilmControls current={stepOf(story.beat)} isOn={story.isOn} steps={steps} on={{ toggle: story.toggle, goTo: story.goTo }} />
        <Film beat={story.beat} rule={rule} coin={coin} isHeld={!story.isOn} stage={story.stage} />
      </section>
      <Sheet number={1} id="steps" title={words.stepsTitle} stamp={false}>
        <ol className="story-steps">
          {STEPS.map((step) => <li key={step}><b>{steps[step].title}.</b> {steps[step].says}</li>)}
        </ol>
      </Sheet>
      {/* what has really been built here, once anything has: a heading over nothing is no reason to stay */}
      {tiles.length > 0 && (
        <section className="built-here" aria-labelledby="built-here-title">
          <h2 id="built-here-title">{words.builtTitle}</h2>
          <Tally tiles={tiles} />
          <div className="flyers">{tiles.slice(0, NEWEST_SHOWN).map((tile) => <JobFlyer key={tile.jobId} tile={tile} coin={coin} />)}</div>
          <p><a href={ROUTES.wall}>{words.everyJob}</a></p>
        </section>
      )}
    </Poster>
  );
}
