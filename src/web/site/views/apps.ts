import { ROUTES } from "../../../routes.ts";

/** The pages the browser draws by itself, from what only it has: the wallet, and what it keeps. */
export const APP_PAGES = ["post", "refund", "claim"] as const;
export type AppPage = (typeof APP_PAGES)[number];

/** Which of those pages a path is, if it is one. */
export function appPageAt(pathname: string): AppPage | undefined {
  if (pathname === ROUTES.post || pathname.startsWith(`${ROUTES.post}/`)) return "post";
  if (pathname.startsWith(ROUTES.refund)) return "refund";
  if (pathname.startsWith(ROUTES.claim)) return "claim";
  return undefined;
}
