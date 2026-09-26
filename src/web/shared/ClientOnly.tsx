import { useEffect, useState, type ReactElement, type ReactNode } from "react";

/**
 * What only the browser can know, such as a wallet, drawn only once the page is in the browser. The
 * server draws the fallback, and so does the browser's first pass, so the two agree and the page takes
 * over without redrawing what the server sent.
 */
export function ClientOnly({ children, fallback = null }: { readonly children: ReactNode; readonly fallback?: ReactNode }): ReactElement {
  const [isInTheBrowser, setIsInTheBrowser] = useState(false);
  useEffect(() => setIsInTheBrowser(true), []);
  return <>{isInTheBrowser ? children : fallback}</>;
}
