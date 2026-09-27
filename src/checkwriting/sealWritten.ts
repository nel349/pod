/**
 * A job's whole spec, built from the checks that were written for it, and sealed.
 *
 * One definition for the page and the server. The server builds the spec it signs from what it
 * wrote, and the page works the seal out again from what it shows before the poster approves it; if
 * the two built it differently, they would never agree on the seal. Pure, and safe in a browser.
 */
import { checkCommand, digestOf, sealSpec, type Check, type HowItIsAsked, type Kind, type Mode, type Spec } from "../job.ts";
import { isProven, type Written } from "./written.ts";

export interface Sealed {
  readonly spec: Spec;
  /** each check's program, by file name */
  readonly files: Readonly<Record<string, string>>;
  readonly seal: `0x${string}`;
}

/**
 * Only checks that passed all three trials go in; each runs the standard command for its file, and
 * nothing outside may be reached. Whoever builds it decides whether the set was ready.
 */
export async function sealWritten(input: {
  readonly idea: string;
  readonly kind: Kind;
  readonly mode: Mode;
  readonly price: bigint;
  readonly checks: readonly Written[];
  readonly howItIsAsked?: HowItIsAsked;
  readonly salt: string;
}): Promise<Sealed> {
  const files: Record<string, string> = {};
  const sealed: Check[] = [];
  for (const check of input.checks.filter(isProven)) {
    files[check.file] = check.source;
    sealed.push({
      says: check.says, run: checkCommand(check.file), hidden: check.secret,
      file: check.file, digest: await digestOf(check.source),
    });
  }
  const spec: Spec = {
    idea: input.idea.trim(), kind: input.kind, mode: input.mode, price: input.price, checks: sealed, allowed: [],
    ...(input.howItIsAsked ? { howItIsAsked: input.howItIsAsked } : {}), salt: input.salt,
  };
  return { spec, files, seal: await sealSpec(spec) };
}
