/**
 * Where the wall is reached from outside, when the server cannot tell from a request.
 *
 * On a laptop the address a page was asked at is the address to print on it. Behind something that
 * holds the certificate, the request that reaches the server came from that something, over plain
 * http, so the server would print an address nobody outside should use. POD_SITE is the one that is
 * right: the server prints it on its pages, and the worker points titles and receipts at it.
 */

/** The setting naming the address the wall is served at, scheme and host and nothing after */
export const SITE_SETTING = "POD_SITE";

/** The address the settings name, or nothing when they name none. One that is not an address is refused with its name. */
export function siteFromTheEnvironment(environment: Record<string, string | undefined> = process.env): string | undefined {
  const value = environment[SITE_SETTING];
  if (!value) return undefined;
  if (!URL.canParse(value)) throw new Error(`${SITE_SETTING} is not an address: ${value}`);
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${SITE_SETTING} has to start with https:// or http://: ${value}`);
  // every path here starts at the root, so an address with anything after its host could not be served
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(`${SITE_SETTING} is where the wall's first page is, so nothing follows its host: ${value}`);
  }
  return url.origin;
}
