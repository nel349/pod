import { useEffect, useRef, useState, type RefObject } from "react";
import { BEAT_MS, beatAfter, firstBeatOf, type Beat, type Step } from "./story.ts";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
/** how much of the stage has to be on the screen for the film to move on */
const SEEN_FROM = 0.3;

export interface StoryPlayer {
  readonly beat: Beat;
  /** whether the film moves on by itself: until the person stops it, and not at first for somebody who asked for less motion */
  readonly isOn: boolean;
  /** the stage, which the film watches so that it only moves on while somebody can see it */
  readonly stage: RefObject<HTMLDivElement | null>;
  readonly goTo: (step: Step) => void;
  readonly toggle: () => void;
}

/**
 * Plays the story: one beat after another, round again, while its stage is on the screen of a tab
 * somebody is looking at. The server and the browser's first drawing both show the first beat, playing.
 */
export function useStory(): StoryPlayer {
  const stage = useRef<HTMLDivElement>(null);
  const [beat, setBeat] = useState<Beat>("say");
  const [isOn, setIsOn] = useState(true);
  const [isOnScreen, setIsOnScreen] = useState(false);
  const [isTabShown, setIsTabShown] = useState(true);

  useEffect(() => {
    // somebody who asked for less motion is shown each scene still, and moves through them by hand
    if (window.matchMedia(REDUCED_MOTION).matches) setIsOn(false);
    const onShown = (): void => setIsTabShown(document.visibilityState === "visible");
    onShown();
    document.addEventListener("visibilitychange", onShown);
    const watched = stage.current;
    const seen = new IntersectionObserver(([entry]) => setIsOnScreen(entry?.isIntersecting === true), { threshold: SEEN_FROM });
    if (watched) seen.observe(watched);
    return () => {
      document.removeEventListener("visibilitychange", onShown);
      seen.disconnect();
    };
  }, []);

  const isMoving = isOn && isOnScreen && isTabShown;
  useEffect(() => {
    if (!isMoving) return;
    const next = setTimeout(() => setBeat(beatAfter), BEAT_MS[beat]);
    return () => clearTimeout(next);
  }, [beat, isMoving]);

  return { beat, isOn, stage, goTo: (step) => setBeat(firstBeatOf(step)), toggle: () => setIsOn((was) => !was) };
}
