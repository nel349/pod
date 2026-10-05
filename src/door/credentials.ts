/**
 * Who is at the door, as git sends it.
 *
 * Git already knows how to send a name and a password with every request, and every git client and
 * credential helper in the world can be told what to send. So the name is the agent's address, and
 * the password is its signed statement: the seat it holds, when the statement runs out, and the
 * signature. Nothing is stored, nothing is issued, and nothing lasts longer than the statement says.
 *
 *   name       0x…                                the seat's key
 *   password   <role>.<until>.<signature>         until is seconds since 1970
 *   password   typed.<role>.<until>.<signature>   the same facts as a structure, for a mandate's key
 *
 * The name is the seat, which is an address on the contract. The signature is from that address, or
 * from a key its wallet granted: an agent working under a mandate signs with a key of its owner's
 * wallet, and the chain, not this server, says whether it may.
 */
import { isAddress, isHex, recoverMessageAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import type { Role } from "../job.ts";
import type { GrantWindow, Grants } from "../mandate.ts";
import { doorMessage, doorStatement, type SignedOn } from "../messages.ts";
import { SEATS } from "../seal.ts";
import { branchFor } from "./seat.ts";

/** How long a statement may be good for. Long enough for a slow push, short enough that a copy is soon worth nothing */
export const MOST_A_STATEMENT_MAY_LAST_SECONDS = 60 * 60;

/**
 * How the statement was signed. A key of its own signs the sentence; a key a wallet granted signs the
 * same facts as a structure, because a mandate's key never signs a sentence.
 */
export type SignedAs = "sentence" | "structure";

/** What the password says: the structure's marker, when it is one */
export const STRUCTURE = "typed";

export interface Statement {
  readonly agent: Address;
  readonly role: Role;
  readonly until: number;
  readonly signature: Hex;
  readonly signedAs: SignedAs;
}

export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string };

const isRole = (role: string): role is Role => (SEATS as readonly string[]).includes(role);

const BASIC = "Basic ";

/**
 * The name and password in a request's `Authorization` header, sent the way git sends them; nothing
 * when there is no such header, and why when there is one that cannot be read.
 */
export function basicCredentials(header: string | null): Checked<{ readonly name: string; readonly password: string }> | undefined {
  if (!header?.startsWith(BASIC)) return undefined;
  let decoded: string;
  try {
    decoded = atob(header.slice(BASIC.length));
  } catch {
    return { ok: false, why: "that name and password could not be read" };
  }
  const colon = decoded.indexOf(":");
  if (colon === -1) return { ok: false, why: "that name and password could not be read" };
  return { ok: true, value: { name: decoded.slice(0, colon), password: decoded.slice(colon + 1) } };
}

/**
 * Whether a statement good until this time is good now: not run out, and not good for longer than a
 * statement may be. Said without turning the time into a date: a time far enough ahead is no date at all.
 */
export function isGoodNow(until: number, nowSeconds: number): Checked<number> {
  if (until <= nowSeconds) return { ok: false, why: "that statement has run out: sign a new one" };
  if (until > nowSeconds + MOST_A_STATEMENT_MAY_LAST_SECONDS) {
    return { ok: false, why: "a statement may be good for an hour at most, and that one is good for longer" };
  }
  return { ok: true, value: until };
}

/** The statement in a request's `Authorization` header, or why there is none that could be read. */
export function statementFrom(header: string | null): Checked<Statement> {
  const credentials = basicCredentials(header);
  if (!credentials) return { ok: false, why: "sign in with your seat: your address as the name, your signed statement as the password" };
  if (!credentials.ok) return credentials;
  const agent = credentials.value.name;
  const parts = credentials.value.password.split(".");
  const signedAs: SignedAs = parts[0] === STRUCTURE ? "structure" : "sentence";
  const [role = "", until = "", signature = "", ...more] = signedAs === "structure" ? parts.slice(1) : parts;
  if (!isAddress(agent)) return { ok: false, why: "the name is the address of the key that holds your seat" };
  if (more.length > 0 || !isRole(role) || !/^[0-9]+$/.test(until) || !isHex(signature)) {
    return {
      ok: false,
      why: `the password is <role>.<until>.<signature>: your seat, when the statement runs out, and your signature. A signature over the structure instead of the sentence says so: ${STRUCTURE}.<role>.<until>.<signature>`,
    };
  }
  return { ok: true, value: { agent, role, until: Number(until), signature, signedAs } };
}

/**
 * Who signed a statement that is good now: not run out, not good for longer than a statement may be,
 * and a signature that can be read over the sentence for this job, this seat and this branch. Whether
 * that signer may act as the seat the statement names is the next question, and `mayActAs` answers it.
 */
export async function signatureOn(
  statement: Statement,
  about: SignedOn & { readonly jobId: string; readonly onChainId: string },
  nowSeconds: number,
): Promise<Checked<Address>> {
  const inTime = isGoodNow(statement.until, nowSeconds);
  if (!inTime.ok) return inTime;
  const { role, until, signature } = statement;
  try {
    if (statement.signedAs === "structure") {
      return { ok: true, value: await recoverTypedDataAddress({ ...doorStatement({ ...about, seat: statement.agent, role, until }), signature }) };
    }
    const message = doorMessage({ ...about, role, branch: branchFor(role, statement.agent), until });
    return { ok: true, value: await recoverMessageAddress({ message, signature }) };
  } catch {
    return { ok: false, why: "that signature could not be read" };
  }
}

/** How a refusal names what was signed, and who it should have been signed by. */
export interface SignedWords {
  /** who the signature should be from, as the request named them */
  readonly whose: string;
  /** what was signed, as the refusal says it */
  readonly over: string;
}

/** The one refusal for a signature that is neither the seat's own nor from a key its wallet granted. */
export const notTheSeatsKey = (words: SignedWords): string =>
  `that signature is not from ${words.whose}, nor from a key its wallet granted, ${words.over}`;

/**
 * Whether a key a wallet granted may be used now: inside the window the wallet granted it. A zero
 * start is no wait and a zero end is no end, the way the plugin reads its own window.
 */
export function grantIsGoodNow(window: GrantWindow, nowSeconds: number): boolean {
  return (window.from === 0 || nowSeconds >= window.from) && (window.until === 0 || nowSeconds < window.until);
}

/**
 * Whether this signer may act as this seat under a mandate: the seat's wallet granted it this key,
 * and the grant is good now. The seat's own key never reaches here, and neither does a seat the
 * contract does not show taken, so a knock from a made-up key costs the chain nothing.
 */
export async function mayActAs(input: {
  readonly signer: Address;
  readonly agent: Address;
  readonly nowSeconds: number;
  readonly grants: Grants;
  readonly words: SignedWords;
}): Promise<Checked<Address>> {
  let window: GrantWindow | undefined;
  try {
    window = await input.grants.granted(input.agent, input.signer);
  } catch {
    return { ok: false, why: "the chain could not be asked whether that key was granted: try again in a moment" };
  }
  if (!window) return { ok: false, why: notTheSeatsKey(input.words) };
  if (!grantIsGoodNow(window, input.nowSeconds)) {
    return { ok: false, why: "that key's grant has run out: grant it again in the wallet, or sign with the seat's own key" };
  }
  return { ok: true, value: input.signer };
}
