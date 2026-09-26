/**
 * The browser's half of every site page: it reads the data the server drew the page from, and takes
 * the page over with the same components, adding the wallet, which only the browser has.
 */
import { StrictMode, type ReactElement, type ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import type { MarketConfig } from "../../market.ts";
import { walletConfig } from "../post/wallet/index.ts";
import { SITE_DATA_ID, SITE_ROOT_ID } from "./document.ts";
import { SiteApp } from "./SiteApp.tsx";
import { SiteDataSchema } from "./views.ts";

function WithTheWallet({ market, children }: { readonly market: MarketConfig | undefined; readonly children: ReactNode }): ReactElement {
  return market ? <WagmiProvider config={walletConfig(market)}>{children}</WagmiProvider> : <>{children}</>;
}

const root = document.getElementById(SITE_ROOT_ID);
const carried = document.getElementById(SITE_DATA_ID);
if (!root || !carried) throw new Error("this page has no data to take over with: the server and this script disagree");

const parsed = SiteDataSchema.safeParse(JSON.parse(carried.textContent ?? ""));
if (!parsed.success) throw new Error(`this page's data cannot be read: ${parsed.error.issues[0]?.message}`);
const data = parsed.data;

const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

hydrateRoot(root, (
  <StrictMode>
    <QueryClientProvider client={client}>
      <WithTheWallet market={data.market}>
        <SiteApp data={data} />
      </WithTheWallet>
    </QueryClientProvider>
  </StrictMode>
));
