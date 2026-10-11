/**
 * Trying a check before anybody can pay for it.
 *
 * Every check is run once, for real, the way a verdict is run, against a server that has built
 * nothing. It has to fail there, or it would pay for no work. And its own program has to load: a
 * check that is broken code fails against anything, nothing built included, so failing there says
 * nothing for it, and no work could ever pass it.
 *
 * That is the only trial. A check used to be tried as well against a version of the work written for
 * the purpose, and one with its sentence's thing wrong. That held a job to what one answer from a
 * model can build, and the work is the pod's to build: what a check is worth against real work is
 * found out when that work is graded.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grade, type CheckToRun } from "../blackbox.ts";
import { DockerFailed } from "../docker/index.ts";
import { PORT, START, WORK_FILE } from "../job.ts";
import { readableToTheBox } from "../sandbox.ts";
import { firstLine } from "../errors.ts";
import type { Proof } from "./written.ts";

/** How one check did against one version. */
export interface Outcome {
  /** whether the check actually ran against it, rather than the version never starting */
  readonly hasRun: boolean;
  readonly hasHeld: boolean;
  readonly said: string;
}

/** how much of what a check printed is kept, which is the line that explains it and no more */
const LONGEST_SAID = 300;

export interface Tried {
  readonly proof: Proof;
  readonly saw: { readonly nothing: string };
}

/**
 * Something that answers and has built nothing: every address is "not here". A check that passes
 * against this pays for no work at all.
 */
const NOTHING_BUILT = `require("http").createServer((request, response) => {
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("nothing has been built here");
}).listen(${PORT});
`;

/** A check to try: what is run, and the file its program is in, which is loaded on its own first. */
export type CheckToTry = CheckToRun & { readonly file: string };

/** What loads a check's program without running it: a program that is not one is refused here, by name. */
export const loadsCommand = (file: string): string => `node --check ${file}`;

/**
 * Try every check against nothing built, and say for each command whether its program loads, whether
 * it failed there, and what it printed.
 */
export async function prove(checks: string, toRun: readonly CheckToTry[], image: string): Promise<ReadonlyMap<string, Tried>> {
  const nothing = await mkdtemp(join(tmpdir(), "pod-nothing-"));
  try {
    await writeFile(join(nothing, WORK_FILE), NOTHING_BUILT);
    await readableToTheBox(nothing);
    // each program is loaded in the same box as it is run in, so "it loads" means there, not here
    const loading = toRun.map((check): CheckToRun => ({ says: check.says, command: loadsCommand(check.file), hidden: check.hidden }));
    const none = await tryAgainst(nothing, checks, [...toRun, ...loading], image);

    const tried = new Map<string, Tried>();
    for (const check of toRun) {
      const empty = none(check.command);
      const loaded = none(loadsCommand(check.file));
      const loads = loaded.hasRun && loaded.hasHeld;
      tried.set(check.command, {
        proof: { loads, nothing: empty.hasRun && !empty.hasHeld },
        saw: { nothing: loads ? empty.said : `its own program does not load: ${loaded.said}` },
      });
    }
    return tried;
  } finally {
    await rm(nothing, { recursive: true, force: true });
  }
}

/**
 * Exit codes that mean the check never really ran: the command could not be run or found (126, 127),
 * or the box was killed from outside (137). None of them says anything about the version being tried,
 * so none of them counts as the check failing. Docker not starting the box at all is thrown by the
 * grading as DockerFailed, and never reaches here.
 */
const NEVER_RAN = new Set([126, 127, 137]);

/**
 * Run the checks against one version, the same way a verdict runs them, and hand back how each did.
 *
 * A version that never starts has not been tried, and says so. A check the grading never reported
 * on is likewise not a check that failed, and is reported as not run.
 */
async function tryAgainst(
  artefact: string, checks: string, toRun: readonly CheckToRun[], image: string,
): Promise<(command: string) => Outcome> {
  const outcomes = new Map<string, Outcome>();
  let notRun = "the grading never reported on it";
  try {
    const graded = await grade({ artefact, start: START, checks, toRun, image });
    for (const check of graded.checks) {
      const said = lastLine(check.output);
      outcomes.set(check.command, NEVER_RAN.has(check.exitCode)
        ? { hasRun: false, hasHeld: false, said: `the check could not be run (exit ${check.exitCode}): ${said}` }
        : { hasRun: true, hasHeld: check.exitCode === 0, said });
    }
  } catch (error) {
    // Docker failing us says nothing about the version or the check: the trial was never held, and
    // the writing is not to be charged for it, so it is not passed off as a check that failed
    if (error instanceof DockerFailed) throw error;
    notRun = firstLine(error);
  }
  return (command) => outcomes.get(command) ?? { hasRun: false, hasHeld: false, said: notRun };
}

const lastLine = (output: string): string =>
  output.trim().split("\n").filter(Boolean).pop()?.slice(0, LONGEST_SAID) ?? "(it printed nothing)";
