import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { firstLine } from "../../../errors.ts";
import { usePath, useSearch } from "../../shared/index.ts";
import { SITE } from "../copy.ts";
import { PAGE_DATA_TYPE, type PageData } from "../document.ts";
import { appPageAt, SiteDataSchema, type SiteCommon } from "../views/index.ts";
import { SITE_QUERY_KEYS } from "./queryKeys.ts";

/** The page the server drew first, where, and when the browser took it over. */
export interface FirstPage {
  readonly address: string;
  readonly page: PageData;
  readonly at: number;
}

/** how long a page's data is shown again without asking for it afresh, when the person comes back to it */
const PAGE_DATA_FRESH_MS = 30_000;

/** A page's data, asked of its own address: the server answers with what it would have drawn it from. */
async function pageDataAt(address: string): Promise<PageData> {
  const answer = await fetch(address, { headers: { accept: PAGE_DATA_TYPE } });
  let body: unknown;
  try {
    body = await answer.json();
  } catch (error) {
    throw new Error(`${address} did not answer with a page's data: ${firstLine(error)}`);
  }
  const title = typeof body === "object" && body !== null && "title" in body && typeof body.title === "string" ? body.title : undefined;
  const data = SiteDataSchema.safeParse(typeof body === "object" && body !== null && "data" in body ? body.data : undefined);
  if (title === undefined || !data.success) throw new Error(`${address} answered with something that is not a page's data`);
  return { title, data: data.data };
}

/**
 * What the page the app is on is drawn from. The first page is what the server drew; a page the browser
 * draws by itself needs nothing from the server but what every page carries; any other is asked of its
 * own address, the page before it staying on screen until it answers.
 */
export function usePageData(first: FirstPage): { readonly page: PageData; readonly failed: Error | null } {
  const address = usePath() + useSearch();
  const app = appPageAt(address.split("?")[0] ?? "");
  const common: SiteCommon = {
    ...(first.page.data.market ? { market: first.page.data.market } : {}),
    coin: first.page.data.coin,
    drawnAt: first.page.data.drawnAt,
    site: first.page.data.site,
  };
  const asked = useQuery({
    queryKey: SITE_QUERY_KEYS.page(address),
    queryFn: () => pageDataAt(address),
    enabled: app === undefined,
    // the first page is what the server drew it from, so it is not asked for again when it is taken over
    ...(address === first.address ? { initialData: first.page, initialDataUpdatedAt: first.at } : {}),
    staleTime: PAGE_DATA_FRESH_MS,
    placeholderData: keepPreviousData,
    retry: false,
  });
  if (app) return { page: { title: SITE.apps[app].title, data: { ...common, page: app } }, failed: null };
  return { page: asked.data ?? first.page, failed: asked.error };
}
