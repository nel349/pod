import type { ReactElement, ReactNode } from "react";
import { ClientOnly } from "../../shared/index.ts";
import { useSite } from "../hooks/index.ts";

/**
 * What only a wallet can say, such as "this is yours": drawn in the browser, and only on a server that
 * answers to a chain, since that is when the page has a wallet to ask.
 */
export function InTheBrowser({ children, fallback = null }: { readonly children: ReactNode; readonly fallback?: ReactNode }): ReactElement | null {
  const { market } = useSite();
  if (!market) return <>{fallback}</>;
  return <ClientOnly fallback={fallback}>{children}</ClientOnly>;
}
