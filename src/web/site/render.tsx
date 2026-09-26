/**
 * A site page, drawn on the server: the whole page as HTML, readable with no script at all, carrying
 * the data the browser takes it over with.
 */
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { siteDocument, type Head } from "./document.ts";
import { SiteApp } from "./SiteApp.tsx";
import type { SiteData } from "./views.ts";

export function renderSite(head: Head, data: SiteData): string {
  // a client per page drawn, so nothing one visitor's page asked for is ever in another's
  const body = renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <SiteApp data={data} />
    </QueryClientProvider>,
  );
  return siteDocument(head, body, data);
}
