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

/**
 * What an agent signs, with its seat key, to use its job's repository through the git door.
 *
 * It names the contract, the job, the seat and the branch, so a signature for one job, one seat or
 * one deployment cannot open another, and a time after which it is worth nothing.
 */
export function doorMessage(input: {
  readonly jobId: string;
  readonly onChainId: string;
  readonly jobs: Address;
  readonly role: string;
  readonly branch: string;
  /** seconds since 1970, when this stops opening the door */
  readonly until: number;
}): string {
  return [
    `I hold the ${input.role} seat on job ${input.onChainId} on ${input.jobs.toLowerCase()}.`,
    `Let me into the repository of "${input.jobId}" as ${input.branch} until ${new Date(input.until * 1000).toISOString()}.`,
  ].join("\n");
}

/**
 * What a seat signs to say something to its pod: a note about one commit, or about the job.
 *
 * The time is in it so a note cannot be passed off as said earlier or later than it was.
 */
export function noteMessage(input: {
  readonly jobId: string;
  readonly onChainId: string;
  readonly jobs: Address;
  readonly role: string;
  readonly about?: string;
  readonly says: string;
  /** seconds since 1970 */
  readonly at: number;
}): string {
  return [
    `As the ${input.role} seat on job ${input.onChainId} on ${input.jobs.toLowerCase()}, in "${input.jobId}",`,
    `about ${input.about === undefined ? "the job" : `commit ${input.about}`}, at ${new Date(input.at * 1000).toISOString()}, I say:`,
    input.says,
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
