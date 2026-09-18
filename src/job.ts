/**
 * What a job is, and what it commits to.
 *
 * A job has to be sealed before it opens, or a pod can build the thing in advance and win by having
 * started early. So the person posting it publishes a hash first and the text later, and anyone can
 * check afterwards that the text they were given is the text that was sealed.
 *
 * The same hashing gives us the key the chain uses: one request per verdict, keyed by the job, the
 * commit and the runner, so the same verdict is never written twice and a late one cannot overwrite
 * an earlier one.
 */

/** How long a pod has, and how quiet it may go before its seat is released. */
export type Mode = "flash" | "sprint" | "project";

export const MODES: Record<Mode, { readonly windowMinutes: number; readonly idleMinutes: number }> = {
  flash: { windowMinutes: 120, idleMinutes: 10 },
  sprint: { windowMinutes: 24 * 60, idleMinutes: 30 },
  project: { windowMinutes: 7 * 24 * 60, idleMinutes: 120 },
};

export type Role = "lead" | "builder" | "reviewer" | "qa" | "security";

/** One thing that must be true before anyone is paid. Objective, or it does not belong here. */
export interface Check {
  /** what a person reads on the tile, for example "the page loads and shows a score" */
  readonly says: string;
  /** the command the checks box runs against the artefact */
  readonly run: string;
  /** whether the pod gets to see this one. Hidden checks are the reason the box is sealed */
  readonly hidden: boolean;
}

/** Something the artefact is allowed to reach at grading time. Anything else is a finding. */
export interface Allowed {
  readonly host: string;
  readonly why: string;
}

/** The text of the job. Sealed before it opens, published when it does. */
export interface Spec {
  readonly idea: string;
  readonly mode: Mode;
  /** what the pod is paid, in the smallest unit of whatever pays */
  readonly price: bigint;
  readonly checks: readonly Check[];
  readonly allowed: readonly Allowed[];
  /** a number nobody can guess, so the hash cannot be brute forced from a short idea */
  readonly salt: string;
}

/** The shares each seat is paid, as percentages that must add up to one hundred. */
export const SHARES: Record<Role, number> = { lead: 20, builder: 40, reviewer: 15, qa: 15, security: 10 };

export function shareOf(price: bigint, role: Role): bigint {
  return (price * BigInt(SHARES[role])) / 100n;
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256(text: string): Promise<`0x${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `0x${hex}`;
}

/**
 * The commitment published when the job is posted.
 *
 * Key order and number formatting are normalised first, so the same job always hashes the same way
 * whichever language wrote it down.
 */
export function sealSpec(spec: Spec): Promise<`0x${string}`> {
  return sha256(canonical(spec));
}

/** Check that the text we were handed is the text that was sealed. */
export async function specMatchesSeal(spec: Spec, seal: `0x${string}`): Promise<boolean> {
  return (await sealSpec(spec)) === seal.toLowerCase();
}

/** What the pod is allowed to see: everything except the hidden checks. */
export function publicSpec(spec: Spec): Omit<Spec, "checks" | "salt"> & { readonly checks: readonly Check[] } {
  const { salt: _salt, checks, ...rest } = spec;
  return { ...rest, checks: checks.filter((c) => !c.hidden) };
}

/**
 * The key for one verdict on the chain.
 *
 * It names the job, the exact commit and the runner that answered, so two runners produce two
 * requests rather than fighting over one, and nothing can be answered twice.
 */
export function verdictKey(input: {
  readonly seal: `0x${string}`;
  readonly commit: string;
  readonly runner: string;
}): Promise<`0x${string}`> {
  return sha256(`pod.verdict.v1|${input.seal}|${input.commit}|${input.runner.toLowerCase()}`);
}

/**
 * The key for one seat's verdict.
 *
 * The validation registry holds one agent per request, so a crew of five needs five: the same job,
 * the same commit, the same runner, but a record each. Using the job's key for all of them would
 * file the whole pod's work under whichever agent asked first, and the other four would have nothing
 * to show for it.
 */
export function seatVerdictKey(input: {
  readonly seal: `0x${string}`;
  readonly commit: string;
  readonly runner: string;
  readonly agent: string;
}): Promise<`0x${string}`> {
  return sha256(
    `pod.verdict.v1|${input.seal}|${input.commit}|${input.runner.toLowerCase()}|${input.agent.toLowerCase()}`,
  );
}

/** When a job must be finished by, and when a quiet seat is forfeited. */
export function deadlines(spec: Spec, startedAt: Date): { readonly endsAt: Date; readonly idleBy: Date } {
  const { windowMinutes, idleMinutes } = MODES[spec.mode];
  return {
    endsAt: new Date(startedAt.getTime() + windowMinutes * 60_000),
    idleBy: new Date(startedAt.getTime() + idleMinutes * 60_000),
  };
}
