/**
 * Who is asking after a preparing job: its poster, proven by one signed statement.
 *
 * Sent the way the git door's is, as a name and a password: the poster's address, and the time the
 * statement runs out with their signature over it. Nothing is stored or issued, and it is good only
 * for the job it names, only until its time, and only while the job prepares.
 *
 *   name       0x…                   the poster's address
 *   password   <until>.<signature>   until is seconds since 1970
 */
import { isAddress, isAddressEqual, isHex, recoverMessageAddress, type Address, type Hex } from "viem";
import { MOST_A_STATEMENT_MAY_LAST_SECONDS, type Checked } from "../door/credentials.ts";
import { preparingMessage } from "../messages.ts";

export interface PosterStatement {
  readonly poster: Address;
  readonly until: number;
  readonly signature: Hex;
}

/** The statement in a request's Authorization header, or why there is none that could be read. */
export function posterStatementFrom(header: string | null): Checked<PosterStatement> {
  if (!header?.startsWith("Basic ")) return { ok: false, why: "sign in as the poster: your address as the name, your signed statement as the password" };
  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length));
  } catch {
    return { ok: false, why: "that name and password could not be read" };
  }
  const colon = decoded.indexOf(":");
  const poster = decoded.slice(0, colon);
  const [until = "", signature = "", ...more] = decoded.slice(colon + 1).split(".");
  if (colon === -1 || !isAddress(poster)) return { ok: false, why: "the name is the address that paid for the job" };
  if (more.length > 0 || !/^[0-9]+$/.test(until) || !isHex(signature)) {
    return { ok: false, why: "the password is <until>.<signature>: when the statement runs out, and your signature" };
  }
  return { ok: true, value: { poster, until: Number(until), signature } };
}

/**
 * Whether a statement is good now for this job: not run out, not good for longer than a statement may
 * be, from the job's poster, and signed by them over the sentence for this job on this contract.
 */
export async function posterStatementHolds(
  statement: PosterStatement,
  about: { readonly jobs: Address; readonly onChainId: string; readonly poster: Address },
  nowSeconds: number,
): Promise<Checked<PosterStatement>> {
  if (statement.until <= nowSeconds) return { ok: false, why: "that statement has run out: sign a new one" };
  if (statement.until > nowSeconds + MOST_A_STATEMENT_MAY_LAST_SECONDS) {
    return { ok: false, why: "a statement may be good for an hour at most, and that one is good for longer" };
  }
  if (!isAddressEqual(statement.poster, about.poster)) return { ok: false, why: "only the address that paid for the job may read and write its checks" };
  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message: preparingMessage({ ...about, until: statement.until }), signature: statement.signature });
  } catch {
    return { ok: false, why: "that signature could not be read" };
  }
  if (!isAddressEqual(signer, statement.poster)) {
    return { ok: false, why: "that signature is not from the address in the name, over the statement for this job" };
  }
  return { ok: true, value: statement };
}
