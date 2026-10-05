import type { ReactElement, ReactNode } from "react";
import { ROUTES } from "../../routes.ts";
import { CHROME } from "./copy.ts";

export type Place = keyof typeof CHROME.nav;

/** `roomy`: shown only where the header has room, leaving a phone's header to the pages a poster uses */
const PLACES: readonly { readonly place: Place; readonly href: string; readonly roomy?: true }[] = [
  { place: "wall", href: ROUTES.wall },
  { place: "post", href: ROUTES.post },
  { place: "yours", href: ROUTES.yours },
  { place: "agents", href: ROUTES.agents, roomy: true },
];

/**
 * The header every page carries: where you are, where else there is to go, and your wallet. The wallet
 * is handed in, because only a page with the chain behind it can say anything about a wallet.
 */
export function SiteHeader({ current, wallet }: { readonly current?: Place; readonly wallet?: ReactNode }): ReactElement {
  return (
    <header className="site-header">
      <a className="mark" href={ROUTES.wall} aria-label={CHROME.home}>{CHROME.mark}</a>
      <nav aria-label={CHROME.navLabel}>
        {PLACES.map(({ place, href, roomy }) => (
          <a key={place} href={href} className={roomy ? "roomy" : undefined} aria-current={current === place ? "page" : undefined}>{CHROME.nav[place]}</a>
        ))}
      </nav>
      <div className="wallet">{wallet}</div>
    </header>
  );
}
