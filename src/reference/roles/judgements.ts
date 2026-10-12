/**
 * How each judging seat decides, given the candidate's files in a folder of their own.
 *
 *   lead       the model holds the work to each line the poster wrote, where the lead judges at all
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
import { PORT, startFor } from "../../job.ts";
import { readableToTheBox } from "../../sandbox.ts";
import { verdictFrom, type Verdict } from "../protocol.ts";
import { briefFor, type Seated } from "../Seated.ts";
import type { Judgement } from "./Judge.ts";

/**
 * How much of the work is shown to the model: enough for a service or a website of a few dozen pages,
 * not a repository dump. A judge that is not shown a file cannot stand behind it, and says so.
 */
const MOST_SOURCE_SHOWN = 300_000;
/** How long a judging seat waits for its model */
const MODEL_MAY_TAKE_MS = 3 * 60_000;
/** How much of a check's own words go into QA's note */
const LONGEST_CHECK_SAID = 200;

export const reviewing: Judgement = async (seated, files) => askTheModel(seated, [
  `You are the ${seated.role} on a small team, reading work somebody else wrote.`,
  "Decide whether it does what was asked. Be strict: a thing that looks right but answers the",
  "wrong question is a refusal. So is a thing that only looks as if it works: a button that does nothing",
  "real, a payment that pays nothing, a form that sends nothing anywhere, numbers written in by hand",
  "where the person asked for real ones. Say what is pretended, so the builder can make it real or say",
  "on the page that it is a mock-up.",
  "",
  "Reply with one line: APPROVE followed by why, or REFUSE followed by what is wrong.",
  "",
  "## What was asked for",
  briefFor(seated.listed),
  "",
  "## What was shipped",
  await sourcesIn(files),
]);

/**
 * The lead's judgement, where the builder puts its own work forward and the lead no longer names what
 * ships: it answers for the whole job to whoever posted it, so it goes down what they asked for line
 * by line and says which line the work does not answer. The reviewer reads how the work is made; the
 * lead reads whether all of it is there.
 */
export const holdingToTheBrief: Judgement = async (seated, files) => askTheModel(seated, [
  "You are the lead on a small team. You answer to the person who asked for this work, and they will open it and decide whether to pay.",
  "Go down what they asked for, one line at a time, and find where the work answers each line.",
  "Refuse if any line is not answered at all, naming that line. Do not refuse for how it is written, or for anything they did not ask for.",
  "Then read what they said they want, in their own words at the top, and ask what they will expect when they open it.",
  "If their words name something real, such as minting, paying, a wallet, signing in or saving, and the work only",
  "pretends to do it, refuse and say what is pretended: they would open it, find a mock-up, and be right to refuse it.",
  "Work that says plainly on the page that a part is a mock-up, where nothing they wrote could make it real (no contract",
  "was named to mint on, no service to call), has told them the truth: approve it, and say in your reason what is a mock-up",
  "and what they would need to name for it to be real. Your reason is read by the person before they decide.",
  "",
  "Reply with one line: APPROVE followed by why, or REFUSE followed by the line that is not answered or what is pretended.",
  "",
  "## What was asked for",
  briefFor(seated.listed),
  "",
  "## What was shipped",
  await sourcesIn(files),
]);

/** What a job must not do, which depends on where its work runs: on a server, or in a visitor's browser. */
function mustNot(seated: Seated): readonly string[] {
  const allowed = seated.listed.allowedHosts.map((host) => host.host);
  if (seated.listed.kind === "site") {
    return [
      "The work is a website: files that run in the browser of whoever opens them, and nowhere else.",
      "You judge whether a page does anything to its visitor that a page must not do:",
      "- send what a visitor types, holds or signs to a host the page does not plainly say it is for",
      "- ask a visitor's wallet for anything but what the page says it is doing, in the page's own words",
      "- load a script that hides what it does, or one made to be unreadable",
      "- take a visitor somewhere else without their asking",
      "Loading fonts, pictures and well-known libraries from the hosts that serve them is ordinary, and not a fault.",
    ];
  }
  return [
    `Answering requests on port ${PORT}, from anywhere, is what the work is for: listening there is required, not a fault.`,
    "You judge whether it does anything a job must not do:",
    allowed.length === 0 ? "- open a connection out to any other host" : `- open a connection out to any host but ${allowed.join(", ")}`,
    "- read environment variables, secrets, or files outside its own folder",
    "- start other programs, or change the machine it runs on",
  ];
}

export const securityReading: Judgement = async (seated, files) => askTheModel(seated, [
  "You are the security seat on a small team. You do not judge whether the work is good; somebody else does.",
  ...mustNot(seated),
  "",
  "Your reason is read by the person who asked for the work before they decide, so make it useful to them: say in plain",
  "words what the work asks of a visitor's wallet and what it sends anywhere, with the address or host it goes to, or that",
  "it does neither.",
  "",
  "Reply with one line: APPROVE followed by why it is safe, or REFUSE followed by exactly what it does that it must not.",
  "",
  "## What was shipped",
  await sourcesIn(files),
]);

export const qaRunning: Judgement = async (seated, files) => {
  const visible = seated.listed.visibleChecks.filter((check): check is typeof check & { file: string; url: string } =>
    check.url !== undefined && check.file !== undefined);
  if (visible.length === 0) {
    return { approve: true, why: "this job has no visible checks to run; the sealed ones decide it at the verdict" };
  }
  const checks = await mkdtemp(join(tmpdir(), "pod-qa-checks-"));
  try {
    for (const check of visible) await writeFile(join(checks, check.file), await seated.server.checkFile(check.url));
    // both folders were made for this run and are their owner's alone on Linux, which the box cannot open
    await readableToTheBox(checks);
    await readableToTheBox(files);
    const toRun: CheckToRun[] = visible.map((check) => ({ says: check.says, command: check.run, hidden: false }));
    const graded = await grade({
      artefact: files, start: startFor(seated.listed.kind), checks, toRun, image: seated.image,
      allowedHosts: seated.listed.allowedHosts.map((allowed) => allowed.host),
    });
    const failed = graded.checks.filter((check) => check.exitCode !== 0);
    if (graded.passed && failed.length === 0) {
      return { approve: true, why: `every visible check passes: ${graded.checks.map((check) => check.says).join("; ")}` };
    }
    return {
      approve: false,
      why: failed.map((check) => `"${check.says}" failed: ${whatItSaid(check.output) ?? `exit ${check.exitCode}`}`).join("; ")
        || "the work did not start",
    };
  } finally {
    await rm(checks, { recursive: true, force: true });
  }
};

/**
 * The line of a check's output that says what went wrong. Not simply the last line: when a check
 * throws, node ends with its stack and then its own version, which says nothing about the work.
 */
export function whatItSaid(output: string): string | undefined {
  const meaningful = output.split("\n").map((line) => line.trim())
    .filter((line) => line !== "" && !/^at\s/.test(line) && !/^Node\.js v\d/.test(line) && !/^\^+$/.test(line));
  return meaningful.at(-1)?.slice(0, LONGEST_CHECK_SAID);
}

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
