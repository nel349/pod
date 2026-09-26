/**
 * Talking to a chain's node the way a public node wants to be talked to.
 *
 * Monad's public node answers at most fifteen requests a second from one address, and turns the rest
 * away with an error of its own rather than HTTP's "too many requests", which viem would have waited
 * out by itself. A server, its worker and its agents often share one address, and a job list reads
 * many things at once, so a burst is ordinary. A request turned away is waited on and sent again,
 * waiting longer each time, rather than failing whatever asked for it.
 */
import { BaseError, http, RpcRequestError, type Transport } from "viem";
import { pause } from "./pause.ts";

/** How many times a request the node turned away is sent again before the refusal is passed on */
export const TIMES_ASKED_AGAIN = 8;
/** The longest first wait before asking again; the longest wait doubles each time */
export const FIRST_WAIT_MS = 250;

/** What Monad's node says when a request comes too fast: its own code, and its words */
const TURNED_AWAY_CODE = -32011;
const TURNED_AWAY_WORDS = /requests limited/i;

/** An HTTP transport that waits and asks again when the node turns a request away for coming too fast. */
export function politeHttp(url?: string): Transport {
  const inner = http(url);
  return (config) => {
    const made = inner(config);
    const request: typeof made.request = async (args, options) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await made.request(args, options);
        } catch (error) {
          if (attempt >= TIMES_ASKED_AGAIN || !isTurnedAway(error)) throw error;
          // a random wait, up to a limit that doubles: a burst turned away together would otherwise all
          // come back together and be turned away again
          await pause(Math.random() * FIRST_WAIT_MS * 2 ** attempt);
        }
      }
    };
    return { ...made, request };
  };
}

/** Whether an error is the node saying a request came too fast, however deep in the error it is. */
export function isTurnedAway(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return error.walk((cause) =>
    cause instanceof RpcRequestError && (cause.code === TURNED_AWAY_CODE || TURNED_AWAY_WORDS.test(cause.details))) !== null;
}
