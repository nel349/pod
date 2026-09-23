/**
 * The sentences people sign.
 *
 * Every write path in the product is a signature over a sentence, never a session, and the sentence
 * is the whole contract between the person and the server: it names exactly what they are agreeing
 * to, so a signature for one thing cannot be replayed as consent to another.
 *
 * They live here, apart from everything else, because the browser has to build the identical string
 * the server checks — character for character — and the only way to be sure of that is for both to
 * run this file. Nothing here may import anything that only runs on a server.
 */
import type { Address, Hex } from "viem";

/** What a poster signs after paying, to attach their spec and their checks to their money. */
export function postingMessage(input: {
  readonly jobId: string;
  readonly onChainId: string;
  readonly jobs: Address;
  readonly seal: Hex;
}): string {
  return [
    `I posted job ${input.onChainId} on ${input.jobs.toLowerCase()}.`,
    `Publish it as "${input.jobId}", sealed as ${input.seal}.`,
  ].join("\n");
}

/** What the holder of a POD signs, to have its repository handed to them. */
export function claimToSign(input: {
  readonly jobId: string;
  readonly tokenId: bigint;
  readonly toAccount: string;
}): string {
  return [
    `I hold POD #${input.tokenId} for the job "${input.jobId}".`,
    `Transfer its repository to the GitHub account "${input.toAccount}".`,
  ].join("\n");
}
