/**
 * The job as it will be sealed, from the form and the checks that were written for it.
 *
 * Pure: the same form and the same checks always make the same job, with the same seal, which is what
 * lets the server rebuild it and refuse anything that does not match.
 */
import { checkCommand, digestOf, sealSpec, type Check, type Spec } from "../../../job.ts";
import { isProven, readyToSeal, type Written } from "../../../checkwriting/written.ts";
import { COPY } from "./copy.ts";
import { priceInWei, requestKey, type DraftRequest, type PostForm } from "./form.ts";

/** how many random bytes go into a salt: enough that nobody guesses it */
const SALT_BYTES = 16;

/** Checks the server wrote and tried, and exactly which request they were written for. */
export interface WrittenFor {
  readonly key: string;
  readonly checks: readonly Written[];
  /** when the writing that produced them started, which tells one set of checks from the next */
  readonly writtenAt: number;
}

export interface SealedJob {
  readonly spec: Spec;
  /** each check's program, by file name: what the server is sent and fingerprints again */
  readonly files: Readonly<Record<string, string>>;
  readonly seal: `0x${string}`;
}

/** Whether these checks were written for what the poster is asking for now. */
export const isFresh = (written: WrittenFor | undefined, request: DraftRequest): boolean =>
  written !== undefined && written.key === requestKey(request);

/**
 * What still stands between the poster and paying, in the order they would meet it, or nothing.
 *
 * Checks written for an earlier version of the request are checks for a job they no longer want, so
 * they stop the payment exactly as missing checks would.
 */
export function whatIsMissing(written: WrittenFor | undefined, request: DraftRequest): string | undefined {
  if (!written) return COPY.problems.notWritten;
  if (!isFresh(written, request)) return COPY.problems.stale;
  if (!readyToSeal(written.checks)) return COPY.problems.notProven;
  return undefined;
}

/** Build the job from a complete form and its proven checks, and seal it. */
export async function sealJob(form: PostForm, checks: readonly Written[], salt: string): Promise<SealedJob> {
  const price = priceInWei(form.price);
  if (price === undefined) throw new Error(COPY.problems.price);

  const files: Record<string, string> = {};
  const sealed: Check[] = [];
  for (const check of checks.filter(isProven)) {
    files[check.file] = check.source;
    sealed.push({
      says: check.says, run: checkCommand(check.file), hidden: check.secret,
      file: check.file, digest: await digestOf(check.source),
    });
  }
  const spec: Spec = { idea: form.idea.trim(), kind: form.kind, mode: form.mode, price, checks: sealed, allowed: [], salt };
  return { spec, files, seal: await sealSpec(spec) };
}

/** A salt nobody can guess, so a short idea cannot be found by guessing its hash. One per page. */
export function freshSalt(): string {
  return [...crypto.getRandomValues(new Uint8Array(SALT_BYTES))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
