/**
 * From a graded job to something a stranger can read.
 *
 * The grading produces a verdict and a signed receipt; the wall needs a tile, a page and the checks
 * themselves. This is the one place that turns the first into the second, so the page can never say
 * something the receipt does not.
 *
 * Every field here is copied, never computed from a guess: the verdict is the receipt's verdict, the
 * commit is the receipt's commit, the time is the time the rounds actually took. If the pod has no
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import type { Tile } from "./gallery.ts";
import type { Approval } from "./jobpage.ts";
import type { Mode, Role, Spec } from "./job.ts";
import { publicSpec } from "./job.ts";
import type { GradeReport } from "./pipeline.ts";
import { isSafeName, receiptPath } from "./routes.ts";
import { JobStore, type JobRecord } from "./store.ts";

export interface Seat {
  readonly role: string;
  readonly agent: Address;
  readonly owner: Address;
}

export interface PublishJob {
  /** the id the job is known by on the wall, and the name of its directory */
  readonly jobId: string;
  readonly seal: Hex;
  readonly idea: string;
  readonly mode: Mode;
  readonly price: bigint;
  readonly report: GradeReport;
  readonly pod: readonly Seat[];
  /** the directory the checks were run from. Its files are published with the job */
  readonly checksDirectory: string;
  readonly approvals: readonly Approval[];
  /** where the thing itself lives, while it lives */
  readonly open?: string;
  readonly repository?: string;
  readonly podHolder?: string;
}

export function tileFor(job: PublishJob): Tile {
  const { receipt } = job.report.signed;
  const seconds = job.report.rounds.reduce((total, round) => total + round.seconds, 0);
  return {
    jobId: job.jobId,
    idea: job.idea,
    mode: job.mode,
    verdict: receipt.verdict,
    open: job.open,
    commit: receipt.commit,
    seconds,
    price: job.price,
    pod: job.pod,
    receiptURI: receiptPath(job.jobId),
    receiptHash: job.report.signed.hash,
    finishedAt: receipt.finishedAt,
  };
}

export function recordFor(job: PublishJob): JobRecord {
  const { receipt } = job.report.signed;
  return {
    jobId: job.jobId,
    seal: job.seal,
    tile: tileFor(job),
    checksSaid: receipt.checks.map((check) => ({
      says: check.says,
      hidden: check.hidden,
      exitCode: check.exitCode,
    })),
    approvals: job.approvals,
    signed: job.report.signed,
    repository: job.repository,
    podHolder: job.podHolder,
  };
}

/**
 * The checks, as files, so a stranger gets the same ones we ran.
 *
 * Flat directory only: the checks box runs each command from one directory, and a check that needs a
 * tree of its own is a check that needs its own container, which is a different conversation.
 */
async function checkFiles(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of await readdir(directory)) {
    if (!isSafeName(name)) throw new Error(`a check's filename cannot be published as it stands: ${name}`);
    files[name] = await readFile(join(directory, name), "utf8");
  }
  return files;
}

/** Write the job where the server reads it, checks and all, and hand back what was written. */
export async function publish(store: JobStore, job: PublishJob): Promise<JobRecord> {
  const record = recordFor(job);
  await store.save(record, await checkFiles(job.checksDirectory));
  return record;
}

export interface OpenJob {
  readonly jobId: string;
  readonly seal: Hex;
  /** the spec as posted. Only what publicSpec allows ever reaches the page */
  readonly spec: Spec;
  readonly endsAt: Date;
  readonly seats: readonly { readonly role: Role; readonly seat?: Seat }[];
}

/**
 * Publish a job that is open, before anybody has built anything.
 *
 * What reaches the page is what `publicSpec` allows: the idea, the visible checks, and a count of
 * the ones that are sealed. The hidden checks themselves stay off this server until there is a
 * verdict, which is the moment they stop being able to change what a pod writes.
 */
export async function openJob(store: JobStore, job: OpenJob): Promise<JobRecord> {
  const shown = publicSpec(job.spec);
  const taken = job.seats.filter((seat) => seat.seat !== undefined);

  const record: JobRecord = {
    jobId: job.jobId,
    seal: job.seal,
    tile: {
      jobId: job.jobId,
      idea: shown.idea,
      mode: shown.mode,
      verdict: "running",
      price: shown.price,
      pod: taken.map((seat) => seat.seat!),
    },
    checksSaid: shown.checks.map((check) => ({ says: check.says, hidden: check.hidden })),
    approvals: [],
    brief: {
      asked: shown.idea,
      ...(shown.howItIsAsked ? { howItIsAsked: shown.howItIsAsked.plainly } : {}),
      endsAt: job.endsAt.toISOString(),
      sealedChecks: job.spec.checks.length - shown.checks.length,
      seats: job.seats.map((seat) => ({ role: seat.role, taken: seat.seat !== undefined })),
    },
  };

  await store.save(record);
  return record;
}
