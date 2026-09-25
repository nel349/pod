/**
 * Trying a check before anybody can pay for it.
 *
 * A check nobody has tried is a guess: it could pass anything, or nothing at all, and either way
 * somebody pays for it later. So every check is run, for real, the way a verdict is run:
 *
 *   against the working version   it has to pass, or nobody could ever be paid
 *   against its near miss         it has to fail, or it would pay for the mistake it exists to catch
 *   against nothing at all        it has to fail, or it would pay for no work
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grade, type CheckToRun } from "../blackbox.ts";
import { PORT, START, WORK_FILE } from "../job.ts";
import { readableToTheBox } from "../sandbox.ts";
import { firstLine } from "../errors.ts";
import { textFromTheBox } from "./fromTheBox.ts";
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

/** The versions every check is tried against, as directories holding a server.js each. */
export interface Versions {
  readonly working: string;
  /** one per check, by the check's command */
  readonly nearMiss: ReadonlyMap<string, string>;
}

export interface Tried {
  readonly proof: Proof;
  readonly saw: { readonly working: string; readonly nearMiss: string; readonly nothing: string };
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

/**
 * Try every check three ways, and say for each command what it proved and what it printed.
 *
 * Each trial is held to what it claims:
 *
 *   the working version runs twice, and the check must pass both times: a check that passes by luck
 *   would pass here one time in a few and then fail at the verdict
 *
 *   a near miss must really be one: its own check has to fail against it, and every other check has
 *   to pass, because a "near miss" that breaks everything would be caught by any check at all. And
 *   one identical to the working version cannot be missing anything
 */
export async function prove(
  checks: string, toRun: readonly CheckToRun[], versions: Versions, image: string,
): Promise<ReadonlyMap<string, Tried>> {
  const nothing = await mkdtemp(join(tmpdir(), "pod-nothing-"));
  try {
    await writeFile(join(nothing, WORK_FILE), NOTHING_BUILT);
    await readableToTheBox(nothing);

    const workingOnce = await tryAgainst(versions.working, checks, toRun, image);
    const workingTwice = await tryAgainst(versions.working, checks, toRun, image);
    const none = await tryAgainst(nothing, checks, toRun, image);
    const workingSource = await textFromTheBox(join(versions.working, WORK_FILE));

    const tried = new Map<string, Tried>();
    for (const check of toRun) {
      const missed = await tryNearMiss(check, toRun, versions.nearMiss.get(check.command), workingSource, checks, image);
      const first = workingOnce(check.command);
      const second = workingTwice(check.command);
      const empty = none(check.command);
      tried.set(check.command, {
        proof: {
          working: first.hasHeld && second.hasHeld,
          nearMiss: missed.hasRun && !missed.hasHeld,
          nothing: empty.hasRun && !empty.hasHeld,
        },
        saw: { working: first.hasHeld ? second.said : first.said, nearMiss: missed.said, nothing: empty.said },
      });
    }
    return tried;
  } finally {
    await rm(nothing, { recursive: true, force: true });
  }
}

/**
 * How one check did against its near miss, counted only if the near miss is a near miss: different
 * from the working version, and with every other check still passing against it.
 */
async function tryNearMiss(
  check: CheckToRun, toRun: readonly CheckToRun[], directory: string | undefined,
  workingSource: string | undefined, checks: string, image: string,
): Promise<Outcome> {
  if (!directory) return notTried("there was no near miss to try it against");
  const nearMissSource = await textFromTheBox(join(directory, WORK_FILE));
  if (nearMissSource === undefined) return notTried("the near miss could not be read");
  if (nearMissSource === workingSource) return notTried("the near miss is the working version, unchanged");

  const against = await tryAgainst(directory, checks, toRun, image);
  const target = against(check.command);
  // a near miss that never started is reported as that, which is the more useful thing to know
  if (!target.hasRun) return target;
  const [alsoBroken] = toRun.filter((other) => other.command !== check.command && !against(other.command).hasHeld);
  if (alsoBroken) return notTried(`the near miss breaks more than one thing: "${alsoBroken.says}" fails against it too`);
  return target;
}

const notTried = (said: string): Outcome => ({ hasRun: false, hasHeld: false, said });

/**
 * Exit codes that mean the check never really ran: Docker could not start the box (125), the command
 * could not be run or found (126, 127), or the box was killed from outside (137). None of them says
 * anything about the version being tried, so none of them counts as the check failing.
 */
const NEVER_RAN = new Set([125, 126, 127, 137]);

/**
 * Run the checks against one version, the same way a verdict runs them, and hand back how each did.
 *
 * A version that never starts has not been tried, and says so: a near miss that crashes proves
 * nothing about whether the check would have caught the mistake it was written to make. A check the
 * grading never reported on is likewise not a check that failed, and is reported as not run.
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
    notRun = firstLine(error);
  }
  return (command) => outcomes.get(command) ?? { hasRun: false, hasHeld: false, said: notRun };
}

const lastLine = (output: string): string =>
  output.trim().split("\n").filter(Boolean).pop()?.slice(0, LONGEST_SAID) ?? "(it printed nothing)";
