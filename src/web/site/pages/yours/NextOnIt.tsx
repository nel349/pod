import type { ReactElement } from "react";
import { When } from "../../components/index.ts";
import { SITE } from "../../copy.ts";
import { useNow } from "../../hooks/index.ts";
import { moneyAt, type YoursEntry } from "../../views/index.ts";

/** The one thing to do next on a job of yours, or what became of it: a title's claim, or its money. */
export function NextOnIt({ entry, isHeld }: { readonly entry: YoursEntry; readonly isHeld: boolean }): ReactElement | null {
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
