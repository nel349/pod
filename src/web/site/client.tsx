/**
 * The browser's half of every site page: it reads the data the server drew the page from, and takes
 * the page over with the same components, adding the wallet, which only the browser has.
 */
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { firstLine } from "../../errors.ts";
import { walletConfig } from "../shared/index.ts";
import { SITE_DATA_ID, SITE_ROOT_ID } from "./document.ts";
import { SiteApp } from "./SiteApp.tsx";
import { SiteDataSchema, type SiteData } from "./views/index.ts";

/** The data the page was drawn from, read through its schema, or why it cannot be. */
function carriedData(carried: HTMLElement): SiteData {
  let raw: unknown;
  try {
    raw = JSON.parse(carried.textContent ?? "");
  } catch (error) {
    throw new Error(`this page's data is not JSON: ${firstLine(error)}`);
  }
  const parsed = SiteDataSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`this page's data cannot be read: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

const root = document.getElementById(SITE_ROOT_ID);
const carried = document.getElementById(SITE_DATA_ID);
if (!root || !carried) throw new Error("this page has no data to take over with: the server and this script disagree");

const data = carriedData(carried);
const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });
// made once for the page: a wallet connection made again on a later drawing would forget who connected
const wallet = data.market ? walletConfig(data.market) : undefined;
const page = <SiteApp data={data} />;

hydrateRoot(root, (
  <StrictMode>
    <QueryClientProvider client={client}>
      {wallet ? <WagmiProvider config={wallet}>{page}</WagmiProvider> : page}
    </QueryClientProvider>
  </StrictMode>
));
