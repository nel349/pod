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
 */
import { isAddress, isHex, recoverMessageAddress, type Address, type Hex } from "viem";
import type { Role } from "../job.ts";
import { doorMessage } from "../messages.ts";
import { SEATS } from "../seal.ts";
import { branchFor } from "./seat.ts";

/** How long a statement may be good for. Long enough for a slow push, short enough that a copy is soon worth nothing */
export const MOST_A_STATEMENT_MAY_LAST_SECONDS = 60 * 60;

export interface Statement {
  readonly agent: Address;
  readonly role: Role;
  readonly until: number;
  readonly signature: Hex;
}

export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string };

const isRole = (role: string): role is Role => (SEATS as readonly string[]).includes(role);

/** The statement in a request's `Authorization` header, or why there is none that could be read. */
export function statementFrom(header: string | null): Checked<Statement> {
  if (!header?.startsWith("Basic ")) return { ok: false, why: "sign in with your seat: your address as the name, your signed statement as the password" };
  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length));
  } catch {
    return { ok: false, why: "that name and password could not be read" };
  }
  const colon = decoded.indexOf(":");
  const agent = decoded.slice(0, colon);
  const [role = "", until = "", signature = "", ...more] = decoded.slice(colon + 1).split(".");
  if (colon === -1 || !isAddress(agent)) return { ok: false, why: "the name is the address of the key that holds your seat" };
  if (more.length > 0 || !isRole(role) || !/^[0-9]+$/.test(until) || !isHex(signature)) {
    return { ok: false, why: "the password is <role>.<until>.<signature>: your seat, when the statement runs out, and your signature" };
  }
  return { ok: true, value: { agent, role, until: Number(until), signature } };
}

/**
 * Whether a statement is good now: not run out, not good for longer than a statement may be, and
 * signed by the key it names, over the sentence for this job, this seat and this branch.
 */
export async function statementHolds(
  statement: Statement,
  about: { readonly jobId: string; readonly onChainId: string; readonly jobs: Address },
  nowSeconds: number,
): Promise<Checked<Statement>> {
  if (statement.until <= nowSeconds) return { ok: false, why: "that statement has run out: sign a new one" };
  // said without turning the time into a date: a time far enough ahead is no date at all
  if (statement.until > nowSeconds + MOST_A_STATEMENT_MAY_LAST_SECONDS) {
    return { ok: false, why: "a statement may be good for an hour at most, and that one is good for longer" };
  }
  const message = doorMessage({ ...about, role: statement.role, branch: branchFor(statement.role, statement.agent), until: statement.until });
  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message, signature: statement.signature });
  } catch {
    return { ok: false, why: "that signature could not be read" };
  }
  if (signer.toLowerCase() !== statement.agent.toLowerCase()) {
    return { ok: false, why: "that signature is not from the address in the name, over the statement for this job and this seat" };
  }
  return { ok: true, value: statement };
}
