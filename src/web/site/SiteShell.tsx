import { useEffect, type ReactElement } from "react";
import { useLockPasskeyWhenIdle, usePath, useSearch } from "../shared/index.ts";
import { useLinksInPlace, usePageData, type FirstPage } from "./hooks/index.ts";
import { SiteApp } from "./SiteApp.tsx";

/** Locks a passkey wallet left open with nobody at the page. Only where there is a wallet to lock. */
export function IdleLock(): null {
  useLockPasskeyWhenIdle();
  return null;
}

/**
 * The one browser app every POD page is. It takes over the page the server drew, and from then on moves
 * between pages in place, so whatever lives only in the page, a passkey wallet's key, stays open.
 */
export function SiteShell({ first }: { readonly first: FirstPage }): ReactElement {
  const { page, failed } = usePageData(first);
  const address = usePath() + useSearch();
  useLinksInPlace();
  useEffect(() => {
    document.title = page.title;
  }, [page.title]);
  useEffect(() => {
    // a page whose data could not be read in place is loaded the ordinary way: the server draws it
    if (failed) window.location.reload();
  }, [failed]);
  return <SiteApp data={page.data} address={address} />;
}
