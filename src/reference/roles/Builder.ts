/**
 * The builder: writes the work, on its own branch, and writes it again when a judge says why not.
 * Where the contract has it so, the builder also puts its work forward itself, each time it has
 * pushed something new: nobody else names what is graded there, so no seat can hold it back.
 *
 * It answers only refusals of a candidate that holds its latest work, so it never rebuilds because of
 * something said about an older version, and it stops after a few tries rather than spending its
 * owner's model forever. What it writes is only ever read as text and committed; it never runs it.
 */
import { branchFor } from "../../door/seat.ts";
import { PORT, SITE_FOLDER, SITE_FRONT_PAGE, workFileFor, type Kind } from "../../job.ts";
import { JUDGES, MOST_REBUILDS, REFUSED } from "../protocol.ts";
import { secondsNow } from "../../clock.ts";
import { hasTriage, isWaiting } from "../../triage.ts";
import { leadHasSpoken } from "./Asking.ts";
import { ASKING_GRACE_SECONDS, briefFor, candidateBranchOf, candidateOf, passwordFor, settledFor, type Seated, type SeatWork } from "../Seated.ts";
import { DUTIES, STANDARD } from "../../standard.ts";
import { shortCommit } from "../../repo.ts";


export class Builder implements SeatWork {
  /** the commit this builder last pushed, whose refusals it answers */
  private latest?: string;
  private rebuilds = 0;
  private stopped = false;
  private readonly answered = new Set<string>();
  /** the commit it last found locked before it could put it forward, so that is said once */
  private saidLockedFor?: string;
  /** when it first looked at a job long enough for questions, in seconds: the pod's time to ask is counted from here */
  private firstLooked?: number;
  /** what it last said it was waiting on before building, so each wait is said once */
  private saidWaitingOn?: string;

  constructor(private readonly seated: Seated) {}

  async step(): Promise<void> {
    if (!this.latest) {
      if (await this.isWaitingOnThePoster()) return;
      await this.build([]);
    }
    // every look, not only after a build: a transaction that failed, or a lock the grader let go of,
    // leaves the latest work still to be put forward
    await this.putMyLatestForward();
    if (this.stopped) return;

    const refusals = await this.refusalsOfMyLatest();
    if (refusals.length === 0) return;
    // refused, and already being graded all the same: nothing it wrote now could take its place
    if (this.seated.builderNames && (await this.seated.identity.isLocked(this.seated.job))) return;
    if (this.rebuilds >= MOST_REBUILDS) {
      this.stopped = true;
      this.seated.say(`rebuilt ${MOST_REBUILDS} times and still refused; stopping rather than guessing again`);
      return;
    }
    // counted only once the build that answers them is pushed: a model or a push that failed is tried
    // again on the next look, with the same refusals
    await this.build(refusals.map((refusal) => refusal.why));
    for (const refusal of refusals) this.answered.add(refusal.signature);
    this.rebuilds++;
  }

  /**
   * Whether the first build should wait: on a job long enough for questions, until the lead has put
   * the pod's questions to the poster or said it has none, and then while any question waits on the
   * poster. A lead that never comes holds the build its first half hour and no longer, and each
   * question's day ends by itself, so a poster who never answers holds it a day and no longer.
   */
  private async isWaitingOnThePoster(): Promise<boolean> {
    const { seated } = this;
    if (!hasTriage(seated.listed.mode)) return false;
    const now = secondsNow();
    this.firstLooked ??= now;
    const waiting = (await seated.server.questions(seated.job)).filter((question) => isWaiting(question, now));
    const isStillTimeToAsk = now - this.firstLooked < (seated.askingGraceSeconds ?? ASKING_GRACE_SECONDS);
    if (waiting.length === 0 && (!isStillTimeToAsk || (await leadHasSpoken(seated)))) return false;
    const on = waiting.length > 0
      ? `${waiting.length === 1 ? "a question" : `${waiting.length} questions`} the pod asked the poster, until answered or ${new Date(Math.max(...waiting.map((question) => question.answerBy)) * 1000).toISOString()}`
      : "the lead, which gathers the pod's questions and puts them to the poster before the first build";
    if (this.saidWaitingOn !== on) seated.say(`not building yet: waiting on ${on}`);
    this.saidWaitingOn = on;
    return true;
  }

  /** Why a judge refused a candidate that holds this builder's latest work, and not yet answered. */
  private async refusalsOfMyLatest(): Promise<readonly { readonly why: string; readonly signature: string }[]> {
    const { seated } = this;
    const latest = this.latest;
    const candidate = await candidateOf(seated);
    if (!latest || !candidate) return [];
    const itsBranch = candidateBranchOf(seated, await seated.identity.readSeats(seated.job));
    if (!itsBranch || !(await seated.copy.fetch(itsBranch))) return [];
    if (!(await seated.copy.isAncestor(latest, candidate))) return [];

    const notes = await seated.server.notes(seated.job, seated.identity.address, await passwordFor(seated));
    return notes
      .filter((note) => note.about === candidate && (JUDGES as readonly string[]).includes(note.role) && note.says.startsWith(REFUSED) && !this.answered.has(note.signature))
      .map((note) => ({ why: `${note.role}: ${note.says.slice(REFUSED.length)}`, signature: note.signature }));
  }

  /**
   * Put the latest work forward on the contract, where that is the builder's to do, unless it is the
   * candidate already. Its push is on the door first: a commit only this machine has cannot be judged
   * or graded by anybody. While an earlier candidate is locked, being graded, nothing newer is taken.
   */
  private async putMyLatestForward(): Promise<void> {
    const { seated } = this;
    const latest = this.latest;
    if (!seated.builderNames || !latest || (await candidateOf(seated)) === latest) return;
    if (await seated.identity.isLocked(seated.job)) {
      if (this.saidLockedFor !== latest) seated.say(`an earlier candidate is being graded, so ${shortCommit(latest)} is not put forward unless the grader lets go of it`);
      this.saidLockedFor = latest;
      return;
    }
    await seated.identity.putForward(seated.job, latest);
    seated.say(`put ${shortCommit(latest)} forward to be reviewed and graded`);
  }

  private async build(refusals: readonly string[]): Promise<void> {
    const { seated } = this;
    if (!seated.model) throw new Error("a builder needs a model to write the work with");
    const mine = branchFor("builder", seated.identity.address);
    await seated.copy.reset(await seated.copy.fetch(mine));
    const isSite = seated.listed.kind === "site";
    const file = workFileFor(seated.listed.kind);
    // a website may be several pages; a service is the one program
    const names = isSite ? await seated.copy.filesUnder(SITE_FOLDER) : [file];
    const existing = (await Promise.all(names.map(async (name) => ({ name, contents: await seated.copy.read(name) }))))
      .flatMap((one) => (one.contents === undefined ? [] : [{ name: one.name, contents: one.contents }]));

    const answer = await seated.model([
      isSite
        ? `You are the builder on a small team. Write the whole website, every file of it under ${SITE_FOLDER}/, and nothing else.`
        : `You are the builder on a small team. Write the whole of ${file} and nothing else.`,
      ...whatToWrite(seated.listed.kind),
      "",
      "## What every seat here is held to",
      ...STANDARD.map((line) => `- ${line}`),
      "",
      "## What your seat is for",
      DUTIES.builder,
      "",
      "## What is being asked for",
      briefFor(seated.listed, seated.references, await settledFor(seated)),
      ...(existing.length > 0 ? ["", "## What is there now, which you are replacing", ...existing.flatMap((one) => [`${FILE_MARK} ${one.name}`, "```", one.contents, "```"])] : []),
      ...(refusals.length > 0 ? ["", "## Why the last version was refused, which this one must fix", ...refusals.map((why) => `- ${why}`)] : []),
    ].join("\n"), AbortSignal.timeout(MODEL_MAY_TAKE_MS));

    if (isSite) {
      // what it wrote is all the website holds: a page left over from an earlier version is not served
      await seated.copy.clear(SITE_FOLDER);
      await seated.copy.write(siteFilesIn(answer));
    } else {
      await seated.copy.write({ [file]: codeIn(answer) });
    }
    const commit = await seated.copy.commit(refusals.length === 0 ? "Build it from the brief" : `Answer the refusal: ${refusals[0]}`.slice(0, 200));
    if (!commit) throw new Error("the builder has nothing to push");
    await seated.copy.push(mine);
    this.latest = commit;
    seated.say(`pushed ${shortCommit(commit)} to ${mine}${refusals.length > 0 ? `, answering ${refusals.length} refusal(s)` : ""}`);
  }
}

/** The line a builder's model writes before each file of a website, naming it. */
const FILE_MARK = "###";

/** The most files a website's builder writes, and the longest a path of one may be: what it is told is a small site. */
export const MOST_SITE_FILES = 40;
const LONGEST_SITE_PATH = 120;

/** A path a website's file may have: under the site's folder, plain names, no way out of it. */
const SITE_PATH = new RegExp(`^${SITE_FOLDER}(/[A-Za-z0-9][A-Za-z0-9._-]*)+$`);

/**
 * What the builder is told to write: a program that answers on a port, or a website, which is its
 * front page and as many more pages as what is asked needs, served as plain files and opened by people.
 */
function whatToWrite(kind: Kind | undefined): readonly string[] {
  if (kind === "site") {
    return [
      `The front page is ${SITE_FOLDER}/${SITE_FRONT_PAGE}. Keep each page whole in itself, with its styles and its script inside it.`,
      `Where what is asked names a page at an address of its own, write that page as a file: /cards/pikachu is ${SITE_FOLDER}/cards/pikachu.html. An address inside one page, after a # or a ?, is not a page of its own.`,
      "The files are served as they are, with no program behind them: anything the site does, it does in the visitor's browser.",
      "People will open it and judge it by eye, so make it a site worth opening: laid out with care, readable on a phone.",
      "Build what is asked for real, not a picture of it. Where it names a wallet, ask the visitor's own browser wallet (window.ethereum) and say on the page what it is asked for; where it names a contract, a chain or a service, call the one that is named, by its address, with no library taken from another host unless what is asked allows one.",
      "A mock-up is not a delivery, and a page that admits one is refused by the other seats. Never let a button look as if it did something it does not.",
      `Reply with each file whole in a fenced code block of its own, and on the line before each block the file's name, like this: ${FILE_MARK} ${SITE_FOLDER}/${SITE_FRONT_PAGE}`,
      "No explanation before, between or after the files.",
    ];
  }
  return [
    `It is a Node program using only the standard library. It must listen on port ${PORT}, on every interface,`,
    "not only localhost: it is reached from another machine on a private network.",
    "Reply with one fenced code block and no explanation.",
  ];
}

/**
 * The files of a website in a builder's answer, by name. An answer that names no file is the front
 * page alone, as a model that wrote one page tends to give it. Anything named outside the site's
 * folder, or more files than a small site has, is refused whole rather than written in part.
 */
export function siteFilesIn(answer: string): Readonly<Record<string, string>> {
  const named = [...answer.matchAll(/^#{2,4}[ \t]+`?([^\s`]+)`?[ \t]*\n+```[a-z]*\n([\s\S]*?)```/gm)];
  if (named.length === 0) return { [`${SITE_FOLDER}/${SITE_FRONT_PAGE}`]: codeIn(answer) };
  if (named.length > MOST_SITE_FILES) throw new Error(`the builder's model wrote ${named.length} files, and a site here is at most ${MOST_SITE_FILES}`);
  const files: Record<string, string> = {};
  for (const [, name = "", contents = ""] of named) {
    if (name.length > LONGEST_SITE_PATH || !SITE_PATH.test(name) || name.split("/").includes("..")) {
      throw new Error(`the builder's model named a file outside the website's folder, so nothing of it is written: ${name.slice(0, LONGEST_SITE_PATH)}`);
    }
    files[name] = `${contents.trim()}\n`;
  }
  if (!(`${SITE_FOLDER}/${SITE_FRONT_PAGE}` in files)) throw new Error("the builder's model wrote a website with no front page");
  return files;
}

/** How long a builder waits for its model to write the work: a website of several pages takes most of it */
const MODEL_MAY_TAKE_MS = 10 * 60_000;

/** The first fenced block of an answer, or the whole answer if it is all code. */
function codeIn(answer: string): string {
  const fenced = answer.match(/```(?:[a-z]*)\n([\s\S]*?)```/);
  return `${(fenced ? fenced[1]! : answer).trim()}\n`;
}

