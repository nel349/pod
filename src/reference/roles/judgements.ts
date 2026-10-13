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
import { PORT, startFor, type Role } from "../../job.ts";
import { readableToTheBox } from "../../sandbox.ts";
import { verdictFrom, type Verdict } from "../protocol.ts";
import { briefFor, passwordFor, settledFor, type Seated } from "../Seated.ts";
import { DUTIES, STANDARD } from "../../standard.ts";
import type { Judgement, Waiting } from "./Judge.ts";

/**
 * How much of the work is shown to the model: enough for a service or a website of a few dozen pages,
 * not a repository dump. A judge that is not shown a file cannot stand behind it, and says so.
 */
const MOST_SOURCE_SHOWN = 300_000;
/** How long a judging seat waits for its model */
const MODEL_MAY_TAKE_MS = 3 * 60_000;
/** How much of what a reviewer says it will look at goes into its note */
const LONGEST_LOOKING_AT = 600;
/** What the security seat answers for, one by one, in the order its account gives them */
export const DANGERS = [
  "A visitor's wallet",
  "Money and data sent elsewhere",
  "What is loaded from elsewhere",
  "Secrets left in the work",
  "Who holds what was made outside the repository",
] as const;
/** How much of a check's own words go into QA's note */
const LONGEST_CHECK_SAID = 200;

/** What every seat is held to, as each of ours is told it: the one standard, word for word, and what its own seat is for. */
function heldTo(seated: Seated): readonly string[] {
  return ["## What every seat here is held to", ...STANDARD.map((line) => `- ${line}`), "", `## What your seat is for`, DUTIES[seated.role]];
}

/** The seats whose accounts the reviewer reads beside the work */
const READ_BY_THE_REVIEWER: readonly Role[] = ["lead", "qa", "security"];

/** What the other seats have said of this candidate so far, newest of each, as the reviewer reads them. */
async function theOtherAccounts(seated: Seated, candidate: string): Promise<readonly string[]> {
  const notes = await seated.server.notes(seated.job, seated.identity.address, await passwordFor(seated));
  return READ_BY_THE_REVIEWER.flatMap((role) => {
    const latest = notes.filter((note) => note.about === candidate && note.role === role).at(-1);
    return latest ? [`### The ${role} seat says`, latest.says] : [`### The ${role} seat has said nothing of this work yet`];
  });
}

export const reviewing: Judgement = async (seated, files, candidate) => askTheModel(seated, [
  `You are the ${seated.role} on a small team: the second pair of eyes on everything, the work and what the other seats say of it.`,
  "Decide whether the work does what was asked. Be strict: a thing that looks right but answers the",
  "wrong question is a refusal. So is a thing that only looks as if it works: a button that does nothing",
  "real, a payment that pays nothing, a form that sends nothing anywhere, numbers written in by hand",
  "where the person asked for real ones. A page that admits a part is a mock-up is still a refusal: say what",
  "is pretended, so the builder makes it real.",
  "Look at what this kind of work calls for: how the pages hold together on a website, the contract's own code",
  "where there is one, the tests where the work has them.",
  "Then read what the other seats say they did, and say where an account is thin, wrong, or claims what the work does not bear out.",
  "",
  "Reply with a first line, APPROVE followed by why or REFUSE followed by what is wrong, and under it your account:",
  "what you read, and what you found fragile, faked or unfinished, in the work and in each other seat's account.",
  "",
  ...heldTo(seated),
  "",
  "## What was asked for",
  briefFor(seated.listed, seated.references, await settledFor(seated)),
  "",
  "## What the other seats say they did",
  ...(await theOtherAccounts(seated, candidate)),
  "",
  "## What was shipped",
  await sourcesIn(files),
]);

/** How much of a review the reviewer leaves QA and security to speak in before it reads without them */
const THE_REVIEWER_WAITS = 0.25;

/**
 * The reviewer reads the other seats' accounts, so it leaves QA and security a while to write them:
 * the first quarter of the review, and no longer, since the lead may conclude at half.
 */
export const waitingForTheOtherAccounts: Waiting = async (seated, candidate) => {
  const gone = await seated.identity.reviewGone(seated.job);
  if (gone === undefined || gone >= THE_REVIEWER_WAITS) return false;
  const seats = await seated.identity.readSeats(seated.job);
  const awaited = (["qa", "security"] as const).filter((role) => seats.some((seat) => seat.role === role));
  if (awaited.length === 0) return false;
  const notes = await seated.server.notes(seated.job, seated.identity.address, await passwordFor(seated));
  return awaited.some((role) => !notes.some((note) => note.about === candidate && note.role === role));
};

/** What a reviewer will look at on one job, said by its model from what is asked: a few plain lines. */
export async function whatTheReviewerLooksAt(seated: Seated): Promise<string> {
  if (!seated.model) throw new Error("the reviewer seat needs a model to say what it will look at");
  const answer = await seated.model([
    "You are the reviewer on a small team that is about to build what is asked for below.",
    "A reviewer looks at different things on different work: a contract's code and who can call what, how a website's pages",
    "hold together and whether what they offer is real, a fix's tests. Say what you will look at on this job, in at most",
    "four short plain sentences on one line, so the pod and the person who asked know before the work starts.",
    "No list, no heading, no promises about the outcome.",
    "",
    "## What is being asked for",
    briefFor(seated.listed, seated.references, await settledFor(seated)),
  ].join("\n"), AbortSignal.timeout(MODEL_MAY_TAKE_MS));
  return answer.trim().split("\n").map((line) => line.trim()).filter((line) => line !== "").join(" ").slice(0, LONGEST_LOOKING_AT);
}

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
  "Work that says on the page that a part is a mock-up is refused the same: a pod supplies what the work needs to be real,",
  "and where nothing was named to do it with, it makes it. Your reason is read by the person before they decide.",
  "",
  "Reply with a first line, APPROVE followed by why or REFUSE followed by the line that is not answered or what is pretended,",
  "and under it your account: each line they asked for, and where in the work it is answered.",
  "",
  ...heldTo(seated),
  "",
  "## What was asked for",
  briefFor(seated.listed, seated.references, await settledFor(seated)),
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
  "What you write is read by the person who asked for the work before they decide, and it is their proof that nothing of",
  "high risk is being handed to them. An opinion is not proof: name the file and what in it you looked at.",
  "",
  "Reply with a first line, APPROVE followed by why it is safe or REFUSE followed by exactly what it does that it must not,",
  "and under it one line for each of these, in this order, each saying what you looked at and what you found:",
  ...DANGERS.map((danger) => `${danger}:`),
  "Where there is nothing of a kind, say so and say where you looked. Never leave one out.",
  "",
  ...heldTo(seated),
  "",
  "## What was shipped",
  await sourcesIn(files),
]);

export const qaRunning: Judgement = async (seated, files) => {
  const visible = seated.listed.visibleChecks.filter((check): check is typeof check & { file: string; url: string } =>
    check.url !== undefined && check.file !== undefined);
  if (visible.length === 0) {
    return {
      approve: true,
      why: "this job has no visible checks to run; the sealed ones decide it at the verdict",
      account: "Every line this poster wrote is kept from the pod until the verdict, so this seat was shown no check to run. It ran none and claims none. The sealed checks are run by the grader, on the same work, before the poster sees it.",
    };
  }
  const checks = await mkdtemp(join(tmpdir(), "pod-qa-checks-"));
  try {
    for (const check of visible) await writeFile(join(checks, check.file), await seated.server.checkFile(check.url));
    // both folders were made for this run and are their owner's alone on Linux, which the box cannot open
    await readableToTheBox(checks);
    await readableToTheBox(files);
    const toRun: CheckToRun[] = visible.map((check) => ({ says: check.says, command: check.run, hidden: false }));
    const started = startFor(seated.listed.kind);
    const graded = await grade({
      artefact: files, start: started, checks, toRun, image: seated.image,
      allowedHosts: seated.listed.allowedHosts.map((allowed) => allowed.host),
    });
    const failed = graded.checks.filter((check) => check.exitCode !== 0);
    if (graded.passed && failed.length === 0) {
      return { approve: true, why: `every visible check passes: ${graded.checks.map((check) => check.says).join("; ")}`, account: whatWasRun(started, graded.target, graded.checks) };
    }
    return {
      approve: false,
      why: failed.map((check) => `"${check.says}" failed: ${whatItSaid(check.output) ?? `exit ${check.exitCode}`}`).join("; ")
        || "the work did not start",
      account: whatWasRun(started, graded.target, graded.checks),
    };
  } finally {
    await rm(checks, { recursive: true, force: true });
  }
};

/** How much of what one check printed goes into QA's account: enough to show it really ran */
const LONGEST_CHECK_PRINTED = 240;

/**
 * QA's account: each check it ran against the work, started for real in a sealed box, with what only
 * a seat that ran it can give. The command, the address it was pointed at, how long it took, what it
 * exited with and what it printed: a line of it that names the work's own words is worth more than
 * any promise that it passed. It says what it did and no more: a check it could not see, and anything
 * a check cannot do, such as pressing a button in a browser, it did not do, and says so.
 */
export { whatWasRun as whatWasRunForTests };

function whatWasRun(
  started: string,
  target: string,
  checks: readonly { readonly says: string; readonly command: string; readonly exitCode: number; readonly output: string; readonly seconds: number }[],
): string {
  return [
    `Started the work for real in a sealed box with \`${started}\`, and ran each check the poster's lines were given from a second box, with TARGET=${target}:`,
    ...checks.map((check) => [
      `- "${check.says}"`,
      `  ran: ${check.command}, ${check.seconds.toFixed(1)}s, exit ${check.exitCode} (${check.exitCode === 0 ? "passed" : "failed"})`,
      `  it printed: ${(check.output.trim() || "nothing").replaceAll("\n", " | ").slice(0, LONGEST_CHECK_PRINTED)}`,
    ].join("\n")),
    "Not done by this seat: the checks sealed until the verdict, and anything a check does not do, such as opening the pages in a browser and pressing what they offer.",
  ].join("\n");
}

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
