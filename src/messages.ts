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
 * What a poster signs after paying on the contract whose jobs are prepared first, to have the job
 * prepared under a name. It names the mode and the salt, which never change afterwards: the mode's
 * window is the one the poster paid for, and the salt is sealed with whatever they approve.
 */
export function setUpMessage(input: {
  readonly jobs: Address;
  readonly onChainId: string;
  readonly name: string;
  readonly mode: string;
  readonly salt: string;
}): string {
  return [
    `I paid for job ${input.onChainId} on ${input.jobs.toLowerCase()}.`,
    `Prepare it as "${input.name}", as a ${input.mode} job, salted ${input.salt}.`,
  ].join("\n");
}

/**
 * What a poster signs to read and write the checks of a job they paid for, while it prepares. One
 * statement, good until a time, so reading the checks as they are written is not a wallet prompt every
 * few seconds.
 */
export function preparingMessage(input: {
  readonly jobs: Address;
  readonly onChainId: string;
  /** seconds since 1970, when this stops letting them in */
  readonly until: number;
}): string {
  return [
    `I paid for job ${input.onChainId} on ${input.jobs.toLowerCase()}.`,
    `Let me read and write its checks until ${new Date(input.until * 1000).toISOString()}.`,
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

/**
 * What an agent signs, with its own key, to have its work credited to a GitHub account. The account
 * agrees by publishing it in a gist of its own; the number is in it because a GitHub name can be given
 * up and taken by somebody else, and the number cannot.
 */
export function creditMessage(input: {
  readonly agent: Address;
  readonly login: string;
  readonly githubId: number;
}): string {
  return `Credit the work of the agent ${input.agent.toLowerCase()} on POD to the GitHub account "${input.login}", number ${input.githubId}.`;
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

/**
 * The structured statements an agent signs when it works a seat under a mandate.
 *
 * A mandate's key never signs a sentence. An operation is authorised by a plain signature over its
 * hash, so a key that will sign any text handed to it hands out something that can be replayed as an
 * operation; the mandate refuses that, and the only thing it signs besides an operation is structured
 * data bound to a domain, which is how it consents to its identity and how it pays an x402 seller.
 *
 * So the same facts the sentences carry are said again here as EIP-712 structures. The domain names
 * POD, the chain and the job contract, so a statement for one deployment cannot be used on another,
 * and the shapes are the smallest that say who is knocking: what is derivable, such as a seat's
 * branch, is derived by the door rather than signed twice.
 */
export const POD_DOMAIN = { name: "POD", version: "1" } as const;

/** Where a structured statement is good: the chain it is on, and the contract the seat is on. */
export interface SignedOn {
  readonly chainId: number;
  readonly jobs: Address;
}

const domainFor = (on: SignedOn) => ({ ...POD_DOMAIN, chainId: on.chainId, verifyingContract: on.jobs }) as const;

/** What an agent signs to be let into its job's repository, when its key cannot sign a sentence. */
export function doorStatement(input: SignedOn & {
  readonly jobId: string;
  readonly onChainId: string;
  readonly seat: Address;
  readonly role: string;
  /** seconds since 1970, when this stops opening the door */
  readonly until: number;
}) {
  return {
    domain: domainFor(input),
    types: {
      Door: [
        { name: "job", type: "string" },
        { name: "number", type: "uint256" },
        { name: "seat", type: "address" },
        { name: "role", type: "string" },
        { name: "until", type: "uint64" },
      ],
    },
    primaryType: "Door",
    message: {
      job: input.jobId,
      number: BigInt(input.onChainId),
      seat: input.seat,
      role: input.role,
      until: BigInt(input.until),
    },
  } as const;
}

/** What a seat signs to say something to its pod, when its key cannot sign a sentence. */
export function noteStatement(input: SignedOn & {
  readonly jobId: string;
  readonly onChainId: string;
  readonly seat: Address;
  readonly role: string;
  /** the commit it is about, or nothing when it is about the job as a whole */
  readonly about?: string;
  readonly says: string;
  /** seconds since 1970 */
  readonly at: number;
}) {
  return {
    domain: domainFor(input),
    types: {
      Note: [
        { name: "job", type: "string" },
        { name: "number", type: "uint256" },
        { name: "seat", type: "address" },
        { name: "role", type: "string" },
        { name: "about", type: "string" },
        { name: "says", type: "string" },
        { name: "at", type: "uint64" },
      ],
    },
    primaryType: "Note",
    message: {
      job: input.jobId,
      number: BigInt(input.onChainId),
      seat: input.seat,
      role: input.role,
      // a note about the job as a whole names no commit, which is said as nothing rather than left out
      about: input.about ?? "",
      says: input.says,
      at: BigInt(input.at),
    },
  } as const;
}
