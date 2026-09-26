import { useEffect, useState } from "react";
import { useSite } from "./SiteContext.ts";

/** how often a page's sense of now moves on: minutes are the finest thing it says */
export const NOW_MOVES_EVERY_MS = 30_000;

/**
 * The time, as the page should say it: the moment the server drew it, on the server and in the
 * browser's first drawing, so the two agree; then the browser's own clock, moving on.
 */
export function useNow(): Date {
  const { drawnAt } = useSite();
  const [now, setNow] = useState(() => new Date(drawnAt));
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), NOW_MOVES_EVERY_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}
