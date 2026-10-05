import { useSyncExternalStore } from "react";

/**
 * Moving between the pages of the one browser app without loading a page again, so what lives only in
 * the page, a passkey wallet's key, stays open. The address bar and the back button work as after a link.
 */

const onMove = (listener: () => void): (() => void) => {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
};

/** Go to another page of this app, in place: a path, with its query if it has one. */
export function goTo(address: string): void {
  window.history.pushState(null, "", address);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

/** The page this app is on, which changes when it moves in place or the person goes back. */
export function usePath(): string {
  return useSyncExternalStore(onMove, () => window.location.pathname, () => "");
}

/** The query of the page this app is on, as `?a=b`, or empty. */
export function useSearch(): string {
  return useSyncExternalStore(onMove, () => window.location.search, () => "");
}
