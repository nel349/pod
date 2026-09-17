/**
 * The receipt: what ran, on what, and what came back.
 *
 * The verdict on chain is a number and two hashes. This is the thing those hashes point at, and it
 * has to say enough that somebody who trusts nobody can do the run again: the image by digest, the
 * exact commands, the exit codes, and a fingerprint of the tree that was graded.
 *
 * It is signed by the runner that produced it. That signature proves who ran it, and nothing more.
 * It is not evidence that the result is honest, and we should never present it as such: the reason
 * to believe a verdict is that anyone can repeat it.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage, type Address, type Hex } from "viem";

export interface CheckRun {
  readonly says: string;
  readonly command: string;
  readonly exitCode: number;
  readonly seconds: number;
  readonly hidden: boolean;
}

export interface Receipt {
  readonly version: "pod.receipt.v1";
  /** the job, by the hash its idea was sealed under */
  readonly seal: Hex;
  /** the commit that was graded */
  readonly commit: string;
  /** a fingerprint of the tree that was actually run, in case the commit is not reachable later */
  readonly tree: Hex;
  /** the container image, pinned by digest */
  readonly image: string;
  /** every check, in the order it ran */
  readonly checks: readonly CheckRun[];
  /** how many times the whole set was run, and whether they all agreed */
  readonly runs: number;
  readonly verdict: "passed" | "failed" | "not-reproducible";
  /** what the artefact was allowed to reach, and whether it tried anything else */
  readonly allowedHosts: readonly string[];
  readonly undeclaredCalls: readonly string[];
  readonly runner: Address;
  readonly finishedAt: string;
}

export interface SignedReceipt {
  readonly receipt: Receipt;
  readonly hash: Hex;
  readonly signature: Hex;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function receiptHash(receipt: Receipt): Hex {
  return `0x${createHash("sha256").update(canonical(receipt)).digest("hex")}`;
}

/**
 * A fingerprint of the tree as it was graded.
 *
 * Paths and contents both, sorted, so the same tree always fingerprints the same way and a moved
 * file is a different tree. Directories that exist only to be rebuilt are left out: their contents
 * are not what was written.
 */
const IGNORED = new Set(["node_modules", ".git", "dist", "build", ".cache", "out"]);

export async function fingerprintTree(root: string): Promise<Hex> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (IGNORED.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await walk(root);
  files.sort();

  const hash = createHash("sha256");
  for (const file of files) {
    const path = relative(root, file).split(sep).join("/");
    const contents = await readFile(file);
    const size = (await stat(file)).size;
    hash.update(`${path}\0${size}\0`);
    hash.update(createHash("sha256").update(contents).digest());
  }
  return `0x${hash.digest("hex")}`;
}

/** Sign a receipt as the runner that produced it. */
export async function signReceipt(receipt: Receipt, privateKey: Hex): Promise<SignedReceipt> {
  const account = privateKeyToAccount(privateKey);
  if (account.address.toLowerCase() !== receipt.runner.toLowerCase()) {
    throw new Error("a receipt must be signed by the runner it names");
  }
  const hash = receiptHash(receipt);
  return { receipt, hash, signature: await account.signMessage({ message: hash }) };
}

/**
 * Check a receipt: that it is unchanged, and that the runner it names really signed it.
 *
 * Both halves matter. A receipt whose contents were edited hashes differently, and a receipt signed
 * by somebody else is not that runner's word.
 */
export async function verifyReceipt(signed: SignedReceipt): Promise<boolean> {
  if (receiptHash(signed.receipt) !== signed.hash) return false;
  return verifyMessage({ address: signed.receipt.runner, message: signed.hash, signature: signed.signature });
}
