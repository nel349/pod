import { useEffect, useState, type ReactElement } from "react";
import { CHROME } from "./copy.ts";

/** How long the button says it copied before it offers to again */
const SAID_FOR_MS = 2_000;

type Said = "copy" | "copied" | "failed";

/**
 * A line the reader is meant to run, with a button that copies it.
 *
 * Typing an install line by hand is where a person makes the mistake that costs them the next ten
 * minutes. The clipboard is not there in every browser, and not at all on a page served over plain
 * http, so when it refuses the button says to select the line rather than pretending it worked.
 */
export function Copyable({ text, what }: { readonly text: string; readonly what: string }): ReactElement {
  const [said, setSaid] = useState<Said>("copy");

  useEffect(() => {
    if (said === "copy") return;
    const timer = setTimeout(() => setSaid("copy"), SAID_FOR_MS);
    return () => clearTimeout(timer);
  }, [said]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setSaid("copied");
    } catch {
      setSaid("failed");
    }
  };

  return (
    <div className="copyable">
      <pre className="repeat wrap">{text}</pre>
      <button type="button" className="copy" onClick={() => void copy()} aria-label={`${CHROME.copy.copy} ${what}`}>
        <span aria-live="polite">{CHROME.copy[said]}</span>
      </button>
    </div>
  );
}
