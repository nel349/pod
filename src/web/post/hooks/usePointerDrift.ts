import { useEffect } from "react";

/** how far, at most, the seal leans toward the pointer: the page's width is this many units of drift */
const DRIFT = 14;

/**
 * Let the page lean away from the pointer, a frame at a time: this sets --mx and --my on the
 * document, and the stylesheet decides what moves how far (the seal's shards, deeper ones further).
 * Set once for the page, so the pieces that draw need no effects of their own. Nothing moves for
 * anybody who asked for less motion.
 */
export function usePointerDrift(): void {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = document.documentElement;
    let frame = 0;
    const follow = (event: PointerEvent): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        root.style.setProperty("--mx", String((event.clientX / window.innerWidth - 0.5) * -DRIFT));
        root.style.setProperty("--my", String((event.clientY / window.innerHeight - 0.5) * -DRIFT));
      });
    };
    window.addEventListener("pointermove", follow);
    return () => {
      window.removeEventListener("pointermove", follow);
      cancelAnimationFrame(frame);
    };
  }, []);
}
