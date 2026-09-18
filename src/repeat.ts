/**
 * Repeating somebody else's verdict.
 *
 * This is the point of the whole project, in one file. A stranger takes a published job, fetches the
 * receipt and the checks that produced it, runs them against the code themselves, and finds out
 * whether we told the truth. Nothing here trusts the server it is talking to: the receipt's signature
 * is checked, the checks are run in the same sealed box, and the answer it prints is the answer its
 * own machine reached, not the one it was handed.
 *
 * It answers a question with three outcomes, not two. "Agrees", "disagrees", and "the published run
 * could not be repeated here", which is a fact about this machine and is said as one.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { grade, type CheckToRun } from "./blackbox.ts";
import { readableToTheBox } from "./sandbox.ts";
import { verifyReceipt, type SignedReceipt } from "./receipt.ts";
import { reachVerdict, type Verdict } from "./verdict.ts";
import { checksPath, receiptPath } from "./routes.ts";

export interface RepeatRequest {
  /** where the job is published, for example https://pod.example/job/coat-or-no-coat */
  readonly jobURL: string;
  /** the code, fetched at the commit the receipt names. Fetching it is the reader's own business */
  readonly artefact: string;
  /** how many times to run it here. Two is the minimum that can disagree with itself */
  readonly times?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface RepeatOutcome {
  readonly published: SignedReceipt["receipt"]["verdict"];
  readonly here: Verdict;
  readonly agrees: boolean;
  /** whether the receipt was signed by the runner it names */
  readonly signatureHolds: boolean;
  readonly checksRun: readonly string[];
  readonly seconds: number;
}

/** Split a published job URL into the server it lives on and the job's own id. */
export function partsOf(jobURL: string): { readonly origin: string; readonly jobId: string } {
  const url = new URL(jobURL);
  const jobId = basename(url.pathname);
  if (!jobId) throw new Error(`${jobURL} does not name a job`);
  return { origin: url.origin, jobId };
}

/**
 * Do the run again, here.
 *
 * The image comes from the receipt, pinned by digest, and so does the command that starts the
 * artefact: a run that cannot be started the same way is not the same run.
 */
export async function repeat(request: RepeatRequest): Promise<RepeatOutcome> {
  const get = request.fetch ?? globalThis.fetch;
  const { origin, jobId } = partsOf(request.jobURL);
  const started = Date.now();

  const response = await get(`${origin}${receiptPath(jobId)}`);
  if (!response.ok) throw new Error(`${origin} has no receipt for ${jobId}: ${response.status}`);
  const signed = (await response.json()) as SignedReceipt;
  const signatureHolds = await verifyReceipt(signed);

  const checks = await fetchChecks(get, origin, jobId);
  if (checks.length === 0) throw new Error(`${origin} published no checks for ${jobId}`);

  const directory = await mkdtemp(join(tmpdir(), "pod-repeat-"));
  for (const check of checks) await writeFile(join(directory, check.name), check.contents);
  // a temporary directory is readable only by its owner, and the checks box is not its owner
  await readableToTheBox(directory);

  // the checks the receipt says ran, in the order it says they ran, with the files just fetched
  const toRun: CheckToRun[] = signed.receipt.checks.map((check) => ({
    says: check.says,
    command: check.command,
    hidden: check.hidden,
  }));

  const times = request.times ?? 2;
  const rounds = [];
  for (let i = 0; i < times; i++) {
    rounds.push(await grade({
      artefact: request.artefact,
      start: signed.receipt.start,
      checks: directory,
      toRun,
      image: signed.receipt.image,
      allowedHosts: signed.receipt.allowedHosts,
    }));
  }

  const here = reachVerdict(rounds.map((round) => ({
    exitCode: round.passed ? 0 : 1,
    summary: round.checks.map((c) => `${c.says}:${c.exitCode}`).join("|"),
  })));

  return {
    published: signed.receipt.verdict,
    here,
    agrees: here.kind === signed.receipt.verdict,
    signatureHolds,
    checksRun: toRun.map((c) => c.says),
    seconds: (Date.now() - started) / 1000,
  };
}

async function fetchChecks(
  get: typeof globalThis.fetch,
  origin: string,
  jobId: string,
): Promise<readonly { readonly name: string; readonly contents: string }[]> {
  const index = await get(`${origin}${checksPath(jobId)}`);
  if (!index.ok) throw new Error(`${origin} would not give up the checks for ${jobId}: ${index.status}`);
  const paths = (await index.text()).split("\n").map((line) => line.trim()).filter(Boolean);

  const files = [];
  for (const path of paths) {
    const file = await get(`${origin}${path}`);
    if (!file.ok) throw new Error(`${origin}${path} came back ${file.status}`);
    files.push({ name: basename(path), contents: await file.text() });
  }
  return files;
}

/** What a person reads when they run this themselves. */
export function saidPlainly(outcome: RepeatOutcome): string {
  const lines = [
    outcome.agrees
      ? `The published verdict holds: ${outcome.published}, and this machine reached ${outcome.here.kind}.`
      : `This machine disagrees. Published: ${outcome.published}. Here: ${outcome.here.kind}.`,
    `Checks run here: ${outcome.checksRun.join(", ")}`,
    outcome.signatureHolds
      ? `The receipt was signed by the runner it names.`
      : `The receipt's signature does not match the runner it names. Treat everything above with that in mind.`,
    `${outcome.seconds.toFixed(1)} seconds.`,
  ];
  return lines.join("\n");
}

if (import.meta.main) {
  const [jobURL, artefact] = process.argv.slice(2);
  if (!jobURL || !artefact) {
    console.error("usage: bun run src/repeat.ts <job url> <directory holding the code at that commit>");
    process.exit(2);
  }
  const outcome = await repeat({ jobURL, artefact });
  console.log(saidPlainly(outcome));
  process.exit(outcome.agrees && outcome.signatureHolds ? 0 : 1);
}
