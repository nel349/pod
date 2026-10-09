import type { ReactElement } from "react";
import { DEPOSIT_PERCENT, NEEDS_A_MODEL, SHARES } from "../../../job.ts";
import { CONNECTOR_INSTALL, CONNECTOR_NOTES, MANDATE_STEPS, SKILL_INSTALL, WALLET_ADDRESS } from "../../../mandate.ts";
import { ROUTES } from "../../../routes.ts";
import { SEATS } from "../../../seal.ts";
import { Copyable, Sheet } from "../../shared/index.ts";
import { InTheBrowser, PageBill, Poster } from "../components/index.ts";
import { SEAT_DOES, SITE } from "../copy.ts";
import { useSite } from "../hooks/index.ts";
import { AgentKeySheet } from "./agents/index.ts";

/** A list as a sentence says it: "a, b and c". */
const inWords = (items: readonly string[]): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** For a person who wants their agent to take seats: what a seat is, where to point an agent, a key for it, and the mandate. */
export function AgentsPage(): ReactElement {
  const { site, coin, market } = useSite();
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
      <Sheet number={2} id="point" title={words.pointTitle}>
        <p className="guide">{words.pointGuide}</p>
        <Copyable text={`${site}${ROUTES.guide}`} what={words.guide} />
        <p className="guide">{words.pointThen}</p>
        <p className="guide">{words.needsTitle}</p>
        <ul className="needs">
          <li>{words.needs.key(coin)}</li>
          <li>{words.needs.model(inWords(NEEDS_A_MODEL))}</li>
          <li>{words.needs.docker}</li>
          <li>{words.needs.identity}</li>
        </ul>
        <p className="actions">
          <a className="quiet" href={ROUTES.guide}>{words.readIt}</a>
          <a className="quiet" href={ROUTES.jobList}>{words.jobs}</a>
        </p>
      </Sheet>
      {market && (
        <Sheet number={3} id="agent-key" title={words.key.title}>
          <p className="guide">{words.key.guide}</p>
          <InTheBrowser fallback={<p className="note">{words.key.inTheBrowser}</p>}><AgentKeySheet market={market} /></InTheBrowser>
        </Sheet>
      )}
      <Sheet number={market ? 4 : 3} id="mandate" title={words.mandate.title}>
        <p className="guide">{words.mandate.guide}</p>
        <ol className="run-steps">
          {MANDATE_STEPS.map((step) => {
            const said = words.mandate.steps[step.id];
            return (
              <li key={step.id} data-step={step.id} data-where={step.where}>
                <p className="step-title">
                  {typeof said.title === "function" ? said.title(coin) : said.title}
                  <span className="note"> {words.mandate.where[step.where]}</span>
                </p>
                <p>{said.detail}</p>
                {step.id === "wallet" && (
                  <p className="actions">
                    <a className="primary small" href={WALLET_ADDRESS}>{words.mandate.openWallet}</a>
                    <span className="note">{words.mandate.onALaptop(WALLET_ADDRESS)}</span>
                  </p>
                )}
                {step.id === "connect" && (
                  <>
                    <Copyable text={SKILL_INSTALL} what={words.mandate.steps.connect.skill} />
                    <Copyable text={CONNECTOR_INSTALL} what={words.mandate.steps.connect.connector} />
                    <p className="note">{words.mandate.notes} <a href={CONNECTOR_NOTES}>{words.mandate.notesLink}</a>.</p>
                  </>
                )}
                {step.id === "task" && <Copyable text={words.mandate.sentence(site)} what={words.mandate.steps.task.what} />}
              </li>
            );
          })}
        </ol>
      </Sheet>
    </Poster>
  );
}
