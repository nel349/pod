import { useEffect, useState } from "react";

const TICK_MS = 1000;

/** Seconds since a moment, ticking once a second while there is one. */
export function useElapsed(since: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === undefined) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(tick);
  }, [since]);
  return since === undefined ? 0 : Math.max(0, Math.floor((now - since) / TICK_MS));
}
