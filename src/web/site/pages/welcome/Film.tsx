import type { ReactElement, RefObject } from "react";
import { SEATS } from "../../../../seal.ts";
import { inCoins, lengthOf, SITE, type LastWord } from "../../copy.ts";
import {
  endingOf, exampleMoney, sceneOf, stepOf,
  type Beat, type ExampleMoney, type KeptState, type LineState, type Scene, type SeatState,
} from "./story.ts";

/** what the example job is posted for: one whole coin, so every share of it reads at a glance */
const EXAMPLE_PRICE = 10n ** 18n;

/** what is written beside a line: nothing while it is only a line, then that it is a check, then that it passed */
const TAG_OF: Record<LineState | KeptState, string | undefined> = {
  written: undefined, check: SITE.welcome.check, covered: SITE.welcome.check, passed: SITE.welcome.passed,
};

/** what a seat says of the work, once there is work: the builder put it forward, the others stand behind it */
function seatSays(state: SeatState, isBuilder: boolean): string | undefined {
  if (state === "empty" || state === "seated") return undefined;
  return isBuilder ? SITE.welcome.seat.forward : SITE.welcome.seat.behind;
}

/** One line of the job, with what has become of it. */
function Line({ text, state, order, note }: {
  readonly text: string; readonly state: LineState | KeptState; readonly order: number; readonly note?: string;
}): ReactElement {
  const tag = TAG_OF[state];
  return (
    <li data-state={state} style={{ "--i": order }}>
      <span className="film-mark" />
      <span className="film-line">
        <span className="film-line-text">{text}<span className="film-cover" /></span>
        {note && <em>{note}</em>}
      </span>
      {tag && <span className="film-tag" key={state}>{tag}</span>}
    </li>
  );
}

/** The job itself, as a sheet on the wall: what was asked, its checks, what was stamped on it, and the poster's two answers. */
function Ticket({ scene, price, answerBy }: { readonly scene: Scene; readonly price: string; readonly answerBy: string }): ReactElement {
  const { example } = SITE.welcome;
  return (
    <div className="ticket">
      <span className="tape" />
      <p className="ticket-label">{example.label}</p>
      <p className="ticket-idea">{example.idea}</p>
      <p className="ticket-price">{price}</p>
      <ul className="ticket-lines">
        {example.lines.map((line, at) => <Line key={line} text={line} state={scene.lines} order={at} />)}
        <Line text={example.kept} state={scene.kept} order={example.lines.length} note={scene.kept === "written" ? example.keptBack : example.hidden} />
      </ul>
      <div className="ticket-foot">
        <span className="ticket-open" data-on={scene.canOpen ? "" : undefined}>{SITE.tile.open}</span>
        <span className="ticket-answers" data-state={scene.answer}>
          <span className="film-answer accept">{SITE.welcome.answers.accept}</span>
          <span className="film-answer refuse">{SITE.welcome.answers.refuse}</span>
          <span className="film-clock"><i />{answerBy}</span>
        </span>
      </div>
      {scene.stamp && <p className="ticket-stamp" key={scene.stamp} data-stamp={scene.stamp}>{SITE.welcome.stamp[scene.stamp]}</p>}
    </div>
  );
}

/** The five seats, each empty until an agent takes it, then saying what it did and what it was paid. */
function Seats({ scene, money, coin }: { readonly scene: Scene; readonly money: ExampleMoney; readonly coin: string }): ReactElement {
  return (
    <ul className="film-seats">
      {SEATS.map((role, at) => {
        const state = scene.seats[role];
        const says = seatSays(state, role === "builder");
        const pay = state === "paid" ? money.pay[role] : state === "keptPart" ? money.kept[role] : undefined;
        return (
          <li key={role} data-state={state} data-role={role} style={{ "--i": at }}>
            <span className="film-seat-name">{role}</span>
            <span className="film-chip">
              <span className="film-agent"><i /><i /></span>
              <b>{role}</b>
              {says && <span className="film-seat-says">{says}</span>}
              {pay !== undefined && <span className="film-seat-pay" key={state}>+{inCoins(pay.toString(), coin)}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Where the money is: with the poster, held, or with the pod, and a line saying so. */
function Rail({ beat, scene, money, coin }: { readonly beat: Beat; readonly scene: Scene; readonly money: ExampleMoney; readonly coin: string }): ReactElement {
  const words = SITE.welcome;
  const coins = (wei: bigint): string => inCoins(wei.toString(), coin);
  const isShared = scene.money === "shared";
  const says = isShared ? words.money.shared(coins(money.comesBack), coins(money.podKeeps)) : words.money[scene.money](coins(money.price));
  return (
    <div className="film-rail" data-money={scene.money}>
      <span className="film-station you">{words.rail.you}</span>
      <span className="film-station held">{words.rail.held}</span>
      <span className="film-station the-pod">{words.rail.pod}</span>
      {/* two coins that travel as one until a refusal parts them: drawn afresh each beat, so each sets out from where it was held */}
      <span className="film-coin keeps" key={`keeps-${beat}`}>{isShared ? coins(money.podKeeps) : ""}</span>
      <span className="film-coin back" key={`back-${beat}`}>{coins(isShared ? money.comesBack : money.price)}</span>
      <p className="film-rail-says" key={beat}>{says}</p>
    </div>
  );
}

/**
 * The film: one example job on the wall, from its poster's first word to their last. A picture of the
 * steps listed under it, so it is kept from a screen reader, which reads the list. Everything on it is
 * drawn from the beat alone, and the stylesheet does the moving.
 */
export function Film({ beat, rule, coin, isHeld, stage }: {
  readonly beat: Beat;
  readonly rule: LastWord;
  readonly coin: string;
  /** stopped by the person watching: every scene is then shown as its finished picture */
  readonly isHeld: boolean;
  readonly stage: RefObject<HTMLDivElement | null>;
}): ReactElement {
  const words = SITE.welcome;
  const scene = sceneOf(beat);
  const step = stepOf(beat);
  const ending = endingOf(beat);
  const said = ending ? words.endings(rule)[ending] : words.steps(rule)[step];
  const money = exampleMoney(EXAMPLE_PRICE, rule.refusalSharePercent);
  return (
    <div className="stage" ref={stage} data-beat={beat} data-held={isHeld ? "" : undefined} aria-hidden="true">
      <div className="stage-caption" key={beat}>
        <p className="stage-title">{words.steps(rule)[step].title}</p>
        <p className="stage-says">{ending && <b>{said.title}</b>}{said.says}</p>
      </div>
      <Ticket scene={scene} price={inCoins(money.price.toString(), coin)} answerBy={words.answerBy(lengthOf(rule.answerSeconds))} />
      <Seats scene={scene} money={money} coin={coin} />
      <Rail beat={beat} scene={scene} money={money} coin={coin} />
    </div>
  );
}
