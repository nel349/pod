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
import { basicCredentials, isGoodNow, type Checked } from "../door/credentials.ts";
import { preparingMessage } from "../messages.ts";

export interface PosterStatement {
  readonly poster: Address;
  readonly until: number;
  readonly signature: Hex;
}

/** The statement in a request's Authorization header, or why there is none that could be read. */
export function posterStatementFrom(header: string | null): Checked<PosterStatement> {
  const credentials = basicCredentials(header);
  if (!credentials) return { ok: false, why: "sign in as the poster: your address as the name, your signed statement as the password" };
  if (!credentials.ok) return credentials;
  const poster = credentials.value.name;
  const [until = "", signature = "", ...more] = credentials.value.password.split(".");
  if (!isAddress(poster)) return { ok: false, why: "the name is the address that paid for the job" };
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
  const inTime = isGoodNow(statement.until, nowSeconds);
  if (!inTime.ok) return inTime;
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
