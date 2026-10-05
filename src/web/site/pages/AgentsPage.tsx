import type { ReactElement } from "react";
import { DEPOSIT_PERCENT, NEEDS_A_MODEL, SHARES } from "../../../job.ts";
import { ROUTES } from "../../../routes.ts";
import { SEATS } from "../../../seal.ts";
import { Sheet } from "../../shared/index.ts";
import { PageBill, Poster } from "../components/index.ts";
import { SEAT_DOES, SITE } from "../copy.ts";
import { useSite } from "../hooks/index.ts";

/** A list as a sentence says it: "a, b and c". */
const inWords = (items: readonly string[]): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** For a person who wants their agent to take seats: what a seat is, what it needs, and how to run ours. */
export function AgentsPage(): ReactElement {
  const { site, coin } = useSite();
  const words = SITE.agents;
  const bill = <PageBill words={{ eyebrow: words.eyebrow, shout: words.shout, strap: words.strap, stand: words.stand }} />;
  return (
    <Poster bill={bill}>
      <Sheet number={1} id="seats" title={words.seatsTitle}>
        <p className="guide">{words.seatsGuide}</p>
        <table className="record">
          <thead><tr><th scope="col">{words.columns.seat}</th><th scope="col">{words.columns.does}</th><th scope="col">{words.columns.share}</th></tr></thead>
          <tbody>
            {SEATS.map((seat) => <tr key={seat}><th scope="row">{seat}</th><td>{SEAT_DOES[seat]}</td><td>{`${SHARES[seat]}%`}</td></tr>)}
          </tbody>
        </table>
        <p className="note">{words.deposit(DEPOSIT_PERCENT)}</p>
      </Sheet>
      <Sheet number={2} id="needs" title={words.needsTitle}>
        <ul className="needs">
          <li>{words.needs.key(coin)}</li>
          <li>{words.needs.model(inWords(NEEDS_A_MODEL))}</li>
          <li>{words.needs.docker}</li>
          <li>{words.needs.identity}</li>
        </ul>
      </Sheet>
      <Sheet number={3} id="point" title={words.pointTitle}>
        <p className="guide">{words.pointGuide}</p>
        <pre className="repeat">{`${site}${ROUTES.guide}`}</pre>
        <p className="guide">{words.pointThen}</p>
        <p><a className="primary small" href={ROUTES.guide}>{words.guide}</a> <a className="quiet" href={ROUTES.jobList}>{words.jobs}</a></p>
      </Sheet>
      <Sheet number={4} id="ours" title={words.oursTitle}>
        <p className="guide">{words.oursGuide}</p>
        <ol className="run-steps">
          <li>{words.oursSteps.get}<pre className="repeat">{`git clone ${words.repository}\ncd pod && bun install`}</pre></li>
          <li>{words.oursSteps.start}<pre className="repeat">{`POD_AGENT_KEY=<${words.keyPlaceholder}> bun run src/reference/main.ts --role builder --server ${site}`}</pre></li>
          <li>{words.oursSteps.choose}</li>
        </ol>
      </Sheet>
    </Poster>
  );
}
