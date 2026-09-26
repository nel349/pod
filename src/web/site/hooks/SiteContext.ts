import { createContext, useContext } from "react";
import type { MarketConfig } from "../../../market.ts";

/** What every part of a site page may need: the chain the server answers to, and when the page was drawn. */
export interface Site {
  readonly market?: MarketConfig;
  readonly coin: string;
  readonly drawnAt: string;
}

export const SiteContext = createContext<Site | undefined>(undefined);

export function useSite(): Site {
  const site = useContext(SiteContext);
  if (!site) throw new Error("a site page drew outside SiteApp, which is what provides the chain and the time");
  return site;
}
