import type { ReactElement } from "react";
import { When } from "../../components/index.ts";
import { SITE } from "../../copy.ts";
import type { YoursEntry } from "../../views/index.ts";
import { MoneyNext } from "./MoneyNext.tsx";

/** The one thing to do next on a job of yours, or what became of it: a title's claim, or its money. */
export function NextOnIt({ entry, isHeld }: { readonly entry: YoursEntry; readonly isHeld: boolean }): ReactElement | null {
  if (isHeld && entry.title) {
    if (entry.title.invited) return <p className="note">{SITE.job.invitedTo(entry.title.invited.account)} <When iso={entry.title.invited.at} />.</p>;
    return entry.title.claim ? <p><a className="primary small" href={entry.title.claim}>{SITE.job.claim}</a></p> : null;
  }
  return entry.money ? <MoneyNext money={entry.money} /> : null;
}
