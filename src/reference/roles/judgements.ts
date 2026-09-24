/**
 * How each judging seat decides, given the candidate's files in a folder of their own.
 *
 *   reviewer   the model reads the work against the brief
 *   security   the model reads the work for what a job must not do
 *   QA         the visible checks run against the work, in the same sealed box a verdict uses
 *
 * The first two are the model's judgement, and say so. QA's is the one that runs the code, and so the
 * one that needs Docker on the owner's machine.
 */
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { grade, type CheckToRun } from "../../blackbox.ts";
import { START } from "../../job.ts";
import { readableToTheBox } from "../../sandbox.ts";
import { verdictFrom, type Verdict } from "../protocol.ts";
import { briefFor, type Seated } from "../Seated.ts";
import type { Judgement } from "./Judge.ts";

/** How much of the work is shown to the model: enough for a small service, not a repository dump */
const MOST_SOURCE_SHOWN = 60_000;
/** How long a judging seat waits for its model */
const MODEL_MAY_TAKE_MS = 3 * 60_000;
/** How much of a check's own words go into QA's note */
const LONGEST_CHECK_SAID = 200;

export const reviewing: Judgement = async (seated, files) => askTheModel(seated, [
  `You are the ${seated.role} on a small team, reading work somebody else wrote.`,
  "Decide whether it does what was asked. Be strict: a thing that looks right but answers the",
  "wrong question is a refusal.",
  "",
  "Reply with one line: APPROVE followed by why, or REFUSE followed by what is wrong.",
  "",
  "## What was asked for",
  briefFor(seated.listed),
  "",
  "## What was shipped",
  await sourcesIn(files),
]);

export const securityReading: Judgement = async (seated, files) => askTheModel(seated, [
  "You are the security seat on a small team. You do not judge whether the work is good; somebody else does.",
  "You judge whether it does anything a job must not do:",
  seated.listed.allowedHosts.length === 0
    ? "- reach any network at all"
    : `- reach any host but ${seated.listed.allowedHosts.map((allowed) => allowed.host).join(", ")}`,
  "- read environment variables, secrets, or files outside its own folder",
  "- start other programs, or change the machine it runs on",
  "",
  "Reply with one line: APPROVE followed by why it is safe, or REFUSE followed by exactly what it does that it must not.",
  "",
  "## What was shipped",
  await sourcesIn(files),
]);

export const qaRunning: Judgement = async (seated, files) => {
  const visible = seated.listed.visibleChecks.filter((check) => check.url !== undefined && check.file !== undefined);
  if (visible.length === 0) {
    return { approve: true, why: "this job has no visible checks to run; the sealed ones decide it at the verdict" };
  }
  const checks = await mkdtemp(join(tmpdir(), "pod-qa-checks-"));
  try {
    for (const check of visible) await writeFile(join(checks, check.file!), await seated.server.checkFile(check.url!));
    // both folders were made for this run and are their owner's alone on Linux, which the box cannot open
    await readableToTheBox(checks);
    await readableToTheBox(files);
    const toRun: CheckToRun[] = visible.map((check) => ({ says: check.says, command: check.run, hidden: false }));
    const graded = await grade({
      artefact: files, start: START, checks, toRun, image: seated.image,
      allowedHosts: seated.listed.allowedHosts.map((allowed) => allowed.host),
    });
    const failed = graded.checks.filter((check) => check.exitCode !== 0);
    if (graded.passed && failed.length === 0) {
      return { approve: true, why: `every visible check passes: ${graded.checks.map((check) => check.says).join("; ")}` };
    }
    return {
      approve: false,
      why: failed.map((check) => `"${check.says}" failed: ${check.output.trim().split("\n").at(-1)?.slice(0, LONGEST_CHECK_SAID) ?? `exit ${check.exitCode}`}`).join("; ")
        || "the work did not start",
    };
  } finally {
    await rm(checks, { recursive: true, force: true });
  }
};

async function askTheModel(seated: Seated, prompt: readonly string[]): Promise<Verdict> {
  if (!seated.model) throw new Error(`the ${seated.role} seat needs a model to judge with`);
  return verdictFrom(await seated.model(prompt.join("\n"), AbortSignal.timeout(MODEL_MAY_TAKE_MS)));
}

/** Every file of the work, as the model reads it, up to a limit it says it reached. */
async function sourcesIn(folder: string): Promise<string> {
  const parts: string[] = [];
  let shown = 0;
  for (const path of await filesUnder(folder)) {
    const text = await readFile(path, "utf8");
    if (shown + text.length > MOST_SOURCE_SHOWN) {
      parts.push(`(more files follow, not shown: the work is larger than ${MOST_SOURCE_SHOWN} characters)`);
      break;
    }
    shown += text.length;
    parts.push(`### ${relative(folder, path)}`, "```", text, "```");
  }
  return parts.length > 0 ? parts.join("\n") : "(nothing: the candidate has no files)";
}

/**
 * The files of the work, links left out: a link in the work was committed by whoever wrote it, and
 * could point at any file on the judge's machine, which would then be read to a model and could
 * reach a note everybody can read.
 */
async function filesUnder(folder: string): Promise<readonly string[]> {
  const found: string[] = [];
  for (const name of (await readdir(folder)).sort()) {
    const path = join(folder, name);
    const what = await lstat(path);
    if (what.isDirectory()) found.push(...(await filesUnder(path)));
    else if (what.isFile()) found.push(path);
  }
  return found;
}
