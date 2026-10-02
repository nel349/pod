import type { ReactElement } from "react";
import { When } from "../../components/index.ts";
import { SITE } from "../../copy.ts";
import { useNow } from "../../hooks/index.ts";
import { moneyAt, type MoneyView } from "../../views/index.ts";

/** What to do about money of yours, as the clock stands: wait, take it back, or nothing, it is settled. */
export function MoneyNext({ money }: { readonly money: MoneyView }): ReactElement {
  const now = useNow();
  const standing = moneyAt(money, now);
  switch (standing.kind) {
    case "held": return standing.isOpenToTakeBack
      ? <p><span className="note">{SITE.job.money.nobodySeated}</span> <a className="primary small" href={standing.takeBack}>{SITE.job.money.takeBack}</a></p>
      : <p className="note">{SITE.job.money.heldUntil} <When iso={standing.endsAt} />.</p>;
    case "returnable": return <p><a className="primary small" href={standing.takeBack}>{SITE.job.money.takeBack}</a></p>;
    case "paid": return <p className="note">{SITE.job.money.paid}</p>;
    case "refunded": return <p className="note">{SITE.job.money.refunded}</p>;
  }
}
