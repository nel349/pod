/**
 * The page around a site page: its head, the data the browser takes over with, and the script that
 * does it. Plain strings, not React: the head is the server's alone and is never taken over.
 */
import { ROUTES } from "../../routes.ts";
import type { SiteData } from "./views/index.ts";

/** Where the page's data sits for the browser to read, by the id both sides use. */
export const SITE_DATA_ID = "pod-data";
export const SITE_ROOT_ID = "root";

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** JSON inside a script element, with no "<" in it that could close the element early. It is read as data, never run. */
const scriptSafe = (data: SiteData): string =>
  JSON.stringify(data).replace(/</g, "\\u003c");

/** What a shared link shows before anybody opens it. */
export interface Head {
  readonly title: string;
  readonly description?: string;
  readonly image?: string;
}

export function siteDocument(head: Head, body: string, data: SiteData): string {
  const meta = [
    `<meta property="og:title" content="${escape(head.title)}">`,
    ...(head.description ? [`<meta name="description" content="${escape(head.description)}">`, `<meta property="og:description" content="${escape(head.description)}">`] : []),
    ...(head.image ? [`<meta property="og:image" content="${escape(head.image)}">`, `<meta name="twitter:card" content="summary_large_image">`] : []),
  ].join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#ffe500">
<title>${escape(head.title)}</title>
${meta}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${ROUTES.brand}">
<link rel="stylesheet" href="${ROUTES.style}">
</head>
<body>
<div id="${SITE_ROOT_ID}">${body}</div>
<script id="${SITE_DATA_ID}" type="application/json">${scriptSafe(data)}</script>
<script type="module" src="${ROUTES.siteScript}"></script>
</body></html>`;
}
