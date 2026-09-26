import type { ReactElement } from "react";
import type { MarketConfig } from "../../../market.ts";
import { jobPath, refundByNumberPath, ROUTES } from "../../../routes.ts";
import { Sheet, useConnectedAccount } from "../../shared/index.ts";
import { InTheBrowser, PageBill, Poster, When } from "../components/index.ts";
import { SITE } from "../copy.ts";
import { useKeptPayment, useNow, useSite, useYours } from "../hooks/index.ts";
import { moneyAt, type YoursEntry } from "../views.ts";

/** The one thing to do next on a job of yours, or what became of it. */
function NextOnIt({ entry, isHeld }: { readonly entry: YoursEntry; readonly isHeld: boolean }): ReactElement | null {
  const now = useNow();
  if (isHeld && entry.title) {
    if (entry.title.invited) return <p className="note">{SITE.job.invitedTo(entry.title.invited.account)} <When iso={entry.title.invited.at} />.</p>;
    return entry.title.claim ? <p><a className="primary small" href={entry.title.claim}>{SITE.job.claim}</a></p> : null;
  }
  if (!entry.money) return null;
  const money = moneyAt(entry.money, now);
  switch (money.kind) {
    case "held": return <p className="note">{SITE.job.money.heldUntil} <When iso={money.endsAt} />.</p>;
    case "returnable": return <p><a className="primary small" href={money.takeBack}>{SITE.job.money.takeBack}</a></p>;
    case "paid": return <p className="note">{SITE.job.money.paid}</p>;
    case "refunded": return <p className="note">{SITE.job.money.refunded}</p>;
  }
}

function Entries({ entries, isHeld, none }: { readonly entries: readonly YoursEntry[]; readonly isHeld: boolean; readonly none: string }): ReactElement {
  if (entries.length === 0) return <p className="note">{none}</p>;
  return (
    <ul className="yours-list">
      {entries.map((entry) => (
        <li key={entry.tile.jobId}>
          <p className="yours-idea"><a href={jobPath(entry.tile.jobId)}>{entry.tile.idea}</a></p>
          <p className="standing">{entry.tile.standing}</p>
          <NextOnIt entry={entry} isHeld={isHeld} />
        </li>
      ))}
    </ul>
  );
}

/** A payment this browser sent and never published: finish it, or take the money back. */
function KeptSheet({ market }: { readonly market: MarketConfig }): ReactElement | null {
  const kept = useKeptPayment(market);
  if (!kept) return null;
  return (
    <Sheet number={1} id="kept" title={SITE.yours.keptTitle} stamp={false}>
      <p className="lede">{SITE.yours.kept(kept.name)}</p>
      <p className="actions">
        <a className="primary" href={ROUTES.post}>{SITE.yours.finish}</a>
        {kept.payment.onChainId !== undefined && <a href={refundByNumberPath(kept.payment.onChainId)}>{SITE.job.money.takeBack}</a>}
      </p>
    </Sheet>
  );
}

function ForTheWallet({ market }: { readonly market: MarketConfig }): ReactElement {
  const account = useConnectedAccount();
  return (
    <>
      <KeptSheet market={market} />
      {account ? <Read address={account} /> : <ConnectSheet />}
    </>
  );
}

function Read({ address }: { readonly address: string }): ReactElement {
  const state = useYours(address);
  switch (state.kind) {
    case "loading": return <Sheet number={2} id="reading" title={SITE.yours.postedTitle} stamp={false}><p className="note">{SITE.yours.loading}</p></Sheet>;
    case "failed": return <Sheet number={2} id="reading" title={SITE.yours.postedTitle} stamp={false}><p className="said-status">{SITE.yours.failed(state.why)}</p></Sheet>;
    case "read": return (
      <>
        <Sheet number={2} id="posted" title={SITE.yours.postedTitle} stamp={false}>
          <Entries entries={state.yours.posted} isHeld={false} none={SITE.yours.nothingPosted} />
          <p className="note">{SITE.yours.onlyThisBrowser}</p>
        </Sheet>
        <Sheet number={3} id="holds" title={SITE.yours.holdsTitle} stamp={false}>
          <Entries entries={state.yours.holds} isHeld none={SITE.yours.nothingHeld} />
        </Sheet>
      </>
    );
  }
}

function ConnectSheet(): ReactElement {
  return <Sheet number={2} id="connect" title={SITE.yours.connectTitle} stamp={false}><p className="lede">{SITE.yours.connect}</p></Sheet>;
}

/** A wallet's own page: what it posted, what it holds, and the one thing to do next on each. */
export function YoursPage(): ReactElement {
  const { market } = useSite();
  const bill = <PageBill words={{ eyebrow: SITE.yours.eyebrow, shout: SITE.yours.shout, strap: SITE.yours.strap, stand: SITE.yours.stand }} />;
  return (
    <Poster bill={bill}>
      {market
        ? <InTheBrowser fallback={<ConnectSheet />}><ForTheWallet market={market} /></InTheBrowser>
        : <Sheet number={1} id="closed" title={SITE.yours.connectTitle} stamp={false}><p className="lede">{SITE.yours.noChain}</p></Sheet>}
    </Poster>
  );
}
