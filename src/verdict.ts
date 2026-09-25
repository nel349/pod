/**
 * Turning what a check run printed into a verdict.
 *
 * Pure on purpose: the sandbox decides what ran, this decides what it means, and the two are tested
 * apart. A verdict is only reached when every run agrees. Two different answers is not a failure of
 * the work, it is a failure to reproduce, and it says so.
 */

export interface RunResult {
  /** what the runner exited with: zero is a pass */
  readonly exitCode: number;
  /** the checker's own summary line, for example "# pass 4 # fail 0" */
  readonly summary: string;
}

export type Verdict =
  | { readonly kind: "passed"; readonly runs: number; readonly digest: string }
  | { readonly kind: "failed"; readonly runs: number; readonly digest: string }
  | { readonly kind: "not-reproducible"; readonly runs: number; readonly answers: readonly string[] };

/** A short, stable fingerprint of what a run said, so two runs can be compared by value. */
export function resultDigest(result: RunResult): string {
  const normalised = `${result.exitCode}|${result.summary.trim().replace(/\s+/g, " ")}`;
  return Bun.hash(normalised).toString(16).padStart(16, "0");
}

/**
 * The rule the whole design rests on: run it more than once, and only speak when the runs agree.
 *
 * Deliberate flakiness cannot be prevented, only detected, so an honest system has three outcomes
 * rather than two.
 */
export function reachVerdict(results: readonly RunResult[]): Verdict {
  if (results.length < 2) throw new Error("a verdict needs at least two runs");

  const digests = results.map(resultDigest);
  const [first, ...rest] = digests as [string, ...string[]];
  const unanimous = rest.every((d) => d === first);

  if (!unanimous) {
    return { kind: "not-reproducible", runs: results.length, answers: [...new Set(digests)] };
  }
  const passed = results.every((r) => r.exitCode === 0);
  return { kind: passed ? "passed" : "failed", runs: results.length, digest: first };
}

/** The score the Validation Registry takes: 0 to 100, and only a clean pass earns 100. */
export function registryResponse(verdict: Pick<Verdict, "kind">): number {
  return verdict.kind === "passed" ? 100 : 0;
}

/** The tag the verdict is filed under, which is what makes a record role-scoped and readable. */
export function registryTag(verdict: Pick<Verdict, "kind">, role: string): string {
  return verdict.kind === "not-reproducible" ? `pod.${role}.unreproducible` : `pod.${role}`;
}
