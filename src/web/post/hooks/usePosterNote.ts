/**
 * The note a poster's wallet signs to see their paid job on the server: good for an hour and kept for
 * this tab only, so following the writing is one wallet prompt, not one every few seconds.
 */
import { useCallback, useState } from "react";
import { useConfig } from "wagmi";
import { signMessage } from "wagmi/actions";
import { isHex, type Address, type Hex } from "viem";
import type { MarketConfig } from "../../../market.ts";
import { preparingMessage } from "../../../messages.ts";

/** how long a note lets the poster in: the most the server takes */
const NOTE_SECONDS = 3600;
/** a note this close to running out is signed again rather than used */
const NOTE_MARGIN_SECONDS = 60;

interface Note {
  readonly until: number;
  readonly signature: Hex;
}

const noteKey = (market: MarketConfig, onChainId: string, poster: Address): string =>
  `pod.note.${market.chainId}.${market.jobs.toLowerCase()}.${onChainId}.${poster.toLowerCase()}`;

function readNote(key: string): Note | undefined {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (typeof parsed !== "object" || parsed === null || !("until" in parsed) || !("signature" in parsed)) return undefined;
    const { until, signature } = parsed;
    if (typeof until !== "number" || typeof signature !== "string" || !isHex(signature)) return undefined;
    return until - NOTE_MARGIN_SECONDS > Date.now() / 1000 ? { until, signature } : undefined;
  } catch {
    // storage refused, or what is there is not a note: the poster signs another
    return undefined;
  }
}

export interface PosterNote {
  /** what the server is shown, once there is a note */
  readonly authorization: string | undefined;
  readonly sign: () => void;
  readonly isSigning: boolean;
  readonly error: string | undefined;
  /** the note stopped letting them in: sign another */
  readonly forget: () => void;
}

export function usePosterNote(market: MarketConfig, onChainId: string, poster: Address | undefined): PosterNote {
  const config = useConfig();
  const key = poster ? noteKey(market, onChainId, poster) : undefined;
  const [note, setNote] = useState<Note | undefined>(() => (key ? readNote(key) : undefined));
  const [noteFor, setNoteFor] = useState(key);
  const [isSigning, setIsSigning] = useState(false);
  const [error, setError] = useState<string>();
  // another wallet, another note: what was kept for the last one is not this one's
  if (key !== noteFor) {
    setNoteFor(key);
    setNote(key ? readNote(key) : undefined);
  }

  // the same function from one drawing to the next, so the page can forget a note in an effect that runs once
  const forget = useCallback((): void => {
    try {
      if (key) sessionStorage.removeItem(key);
    } catch {
      // nothing kept, or it cannot be reached
    }
    setNote(undefined);
  }, [key]);

  const sign = (): void => {
    if (!poster || !key) return;
    const until = Math.floor(Date.now() / 1000) + NOTE_SECONDS;
    setIsSigning(true);
    setError(undefined);
    signMessage(config, { account: poster, message: preparingMessage({ jobs: market.jobs, onChainId, until }) })
      .then((signature) => {
        const signed = { until, signature };
        try {
          sessionStorage.setItem(key, JSON.stringify(signed));
        } catch {
          // not kept: this page still uses it for as long as it stays open
        }
        setNote(signed);
      })
      .catch((failed: unknown) => setError(failed instanceof Error ? failed.message : String(failed)))
      .finally(() => setIsSigning(false));
  };

  return {
    authorization: poster && note ? `Basic ${btoa(`${poster}:${note.until}.${note.signature}`)}` : undefined,
    sign, isSigning, error,
    forget,
  };
}
