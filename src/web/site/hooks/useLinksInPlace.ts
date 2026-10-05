import { useEffect } from "react";
import { isPagePath } from "../../../routes.ts";
import { goTo } from "../../shared/index.ts";

/** Whether a click is one a person meant for this tab, rather than a new tab, a download or another site. */
function linkFollowedInPlace(event: MouseEvent): URL | undefined {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return undefined;
  const link = event.target instanceof Element ? event.target.closest("a") : null;
  if (!(link instanceof HTMLAnchorElement) || !link.href) return undefined;
  if ((link.target && link.target !== "_self") || link.hasAttribute("download")) return undefined;
  const url = new URL(link.href);
  if (url.origin !== window.location.origin || !isPagePath(url.pathname)) return undefined;
  // a link to a place on this same page is the browser's to follow
  if (url.hash && url.pathname === window.location.pathname && url.search === window.location.search) return undefined;
  return url;
}

/**
 * Every link to one of POD's pages moves there in place, with no new load, so the wallet open on this
 * page is open on the next. Plain links, so a page drawn with no script still links the same way.
 */
export function useLinksInPlace(): void {
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      const url = linkFollowedInPlace(event);
      if (!url) return;
      event.preventDefault();
      goTo(url.pathname + url.search + url.hash);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
}
