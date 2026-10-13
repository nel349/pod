/**
 * Every sentence the server-drawn pages say, and how they say money, time and addresses. One place,
 * so the page the server draws and the page the browser takes over say the same thing the same way.
 */
import { formatEther } from "viem";
import type { Role } from "../../job.ts";
import { SEATS } from "../../seal.ts";
import { shortAddress } from "../shared/copy.ts";
import type { Ending, StampState, Step } from "./pages/welcome/story.ts";
import type { AgentRecordView, Answer, DeliveryView, PosterRecordView, Verdict } from "./views/index.ts";

/** Money in wei, as a person reads it: the coin's amount, and its name. */
export function inCoins(wei: string, coin: string): string {
  return `${formatEther(BigInt(wei))} ${coin}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const twoDigits = (n: number): string => String(n).padStart(2, "0");

/**
 * A time the server and the browser both draw the same: the day, and the hour in UTC. Spelled out
 * here rather than by the locale, because the server and a browser format dates with different
 * libraries, and one said "Sept" where the other said "Sep".
 */
export function whenInUTC(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${twoDigits(at.getUTCHours())}:${twoDigits(at.getUTCMinutes())} UTC`;
}

/** The same time in the reader's own zone, which only the browser knows. */
export function whenHere(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}

const SECONDS_IN = { minute: 60, hour: 3600, day: 86_400 } as const;

/** A length of time in the largest unit that reads naturally. */
export function lengthOf(seconds: number): string {
  const plural = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? "" : "s"}`;
  if (seconds < 90) return plural(Math.max(1, Math.round(seconds)), "second");
  if (seconds < 90 * SECONDS_IN.minute) return plural(Math.round(seconds / SECONDS_IN.minute), "minute");
  if (seconds < 48 * SECONDS_IN.hour) return plural(Math.round(seconds / SECONDS_IN.hour), "hour");
  return plural(Math.round(seconds / SECONDS_IN.day), "day");
}

/** How long is left before a time, from another. */
export function timeLeft(until: string, from: Date): string {
  const seconds = (new Date(until).getTime() - from.getTime()) / 1000;
  return seconds <= 0 ? "closed" : `${lengthOf(seconds)} left`;
}

/** The one word stamped across a job: where it stands, loud enough to read from across the room. */
export const STAMP: Record<Verdict | "waiting", string> = {
  waiting: "open",
  running: "building",
  passed: "paid",
  failed: "failed",
  "not-reproducible": "unsure",
  withdrawn: "withdrawn",
  graded: "graded",
};

/**
 * The word stamped on a job its poster has the last word on, once it is delivered. A poster who said
 * nothing left it to the checks, so that job is stamped by its verdict like any other.
 */
const ANSWER_STAMP: Record<Exclude<Answer, "unanswered">, string> = { awaited: "delivered", accepted: "paid", refused: "refused" };

/** The one word stamped on a job: a job nobody has taken is open, not being built. */
export function stampOf(tile: { readonly verdict: Verdict; readonly pod: readonly unknown[]; readonly answer?: Answer | undefined }): string {
  const stamp = stampAfter(tile.verdict, tile.answer);
  return stamp === STAMP.running && tile.pod.length === 0 ? STAMP.waiting : stamp;
}

/** The word stamped on a job by its verdict and, where its poster has the last word, by their answer: the same on its flyer and on its receipt. */
export function stampAfter(verdict: Verdict, answer: Answer | undefined): string {
  return answer && answer !== "unanswered" ? ANSWER_STAMP[answer] : STAMP[verdict];
}

/** How a job ends up counted on the wall: by who was paid in the end, and why. */
export type Counted = "open" | "delivered" | "paid" | "refused" | "failed" | "unsure" | "withdrawn";

export function countedAs(tile: { readonly verdict: Verdict; readonly answer?: Answer | undefined }): Counted {
  if (tile.answer === "awaited") return "delivered";
  if (tile.answer === "accepted") return "paid";
  if (tile.answer === "refused") return "refused";
  switch (tile.verdict) {
    case "passed": return "paid";
    case "failed": return "failed";
    case "not-reproducible": return "unsure";
    case "withdrawn": return "withdrawn";
    case "running": case "graded": return "open";
  }
}

/** A share of something, as a person says it: a quarter, half, or the number when there is no word for it. */
export function shareInWords(percent: number): string {
  const named: Readonly<Record<number, string>> = { 10: "a tenth", 20: "a fifth", 25: "a quarter", 50: "half", 75: "three quarters", 80: "four fifths", 90: "nine tenths" };
  return named[percent] ?? `${percent}%`;
}

/** What the page is told of a contract on which the poster has the last word. */
export interface LastWord {
  readonly answerSeconds: number;
  readonly refusalSharePercent: number;
  readonly reviewSharePercent: number;
  /** on the contract where the pod's own lead names which seats earned their pay */
  readonly leadNamesWhoIsPaid?: boolean;
}

const jobs = (count: number): string => `${count} ${count === 1 ? "job" : "jobs"}`;
/** A list as a sentence says it: "one", "one and two", "one, two and three". */
const listed = (parts: readonly string[]): string =>
  parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

/**
 * How a poster's jobs have ended, in a sentence, with what an agent most needs to know first: work
 * that passed its checks and was refused all the same.
 */
export function posterRecordWords(record: PosterRecordView, isYours = false): string {
  const parts = [
    ...(record.refusedPassed > 0 ? [`refused ${record.refusedPassed} whose checks passed`] : []),
    ...(record.accepted > 0 ? [`accepted ${record.accepted}`] : []),
    ...(record.refusedFailed > 0 ? [`refused ${record.refusedFailed} whose checks failed`] : []),
    ...(record.unanswered > 0 ? [`left ${record.unanswered} to the checks by saying nothing`] : []),
  ];
  const words = isYours ? SITE.job.records.yours : SITE.job.records;
  if (parts.length === 0) return words.posterNothingYet(record.posted);
  return words.poster(record.posted, listed(parts));
}

/** How the jobs an agent held a seat on have ended, in a few words, or that none has ended yet. */
export function agentRecordWords(record: AgentRecordView): string {
  const paid = record.accepted + record.paidUnanswered;
  const parts = [
    ...(paid > 0 ? [`${paid} paid`] : []),
    ...(record.refusedPassed > 0 ? [`${record.refusedPassed} refused`] : []),
    ...(record.failed > 0 ? [`${record.failed} failed`] : []),
    ...(record.undelivered > 0 ? [`${record.undelivered} not delivered`] : []),
  ];
  return parts.length === 0 ? SITE.job.records.agentNothingYet : SITE.job.records.agent(parts.join(", "));
}

/** The same count on the agent's own page, where there is room to say each ending in full. */
export function agentAnsweredWords(record: AgentRecordView): string {
  const parts = [
    ...(record.accepted > 0 ? [`${record.accepted} accepted by the poster`] : []),
    ...(record.paidUnanswered > 0 ? [`${record.paidUnanswered} paid on the checks when the poster said nothing`] : []),
    ...(record.refusedPassed > 0 ? [`${record.refusedPassed} refused although the checks passed`] : []),
    ...(record.failed > 0 ? [`${record.failed} failed the checks`] : []),
    ...(record.undelivered > 0 ? [`${record.undelivered} closed with nothing delivered`] : []),
  ];
  return parts.length === 0 ? SITE.agent.answeredNothingYet : SITE.agent.answered(listed(parts));
}

/**
 * What a pod's own lead made of this agent, where a lead names who is paid: the seats it stood
 * behind and went unpaid for, and the jobs where it was the lead that kept somebody's pay. Nothing
 * at all when neither has happened, which is most agents.
 */
export function agentCutWords(record: AgentRecordView): string | undefined {
  const kept = record.withheld ?? 0;
  const made = record.withholdings ?? 0;
  if (kept === 0 && made === 0) return undefined;
  const parts = [
    ...(kept > 0 ? [SITE.agent.cuts.wasKept(kept)] : []),
    ...(made > 0 ? [SITE.agent.cuts.kept(made)] : []),
  ];
  return `${startingASentence(listed(parts))}. ${SITE.agent.cuts.says}`;
}

/** Where a delivered job stands with its poster, said in a sentence: what the checks found, and what the poster did. */
export function whereTheDeliveryStands(delivery: Pick<DeliveryView, "answer" | "checksPassed">, isYours = false): string {
  const found = delivery.checksPassed ? "passed" : "failed";
  return SITE.job.next[isYours ? "deliveredToYou" : "delivered"][delivery.answer][found];
}

/** Where work under review stands: who other than its builder is behind it, and who has yet to say. */
export function whereTheReviewStands(review: { readonly behind: readonly Role[]; readonly notYet: readonly Role[] }, isOver = false): string {
  const words = SITE.job.next.underReview;
  const named = (roles: readonly Role[], one: string, many: string): string => `${listed(roles.map((role) => THE_SEAT[role]))} ${roles.length === 1 ? one : many}`;
  const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
  if (review.notYet.length === 0) return review.behind.length === 0 ? words.alone : words.all;
  if (isOver) return review.behind.length === 0 ? words.ranOutAlone : words.ranOut(capital(named(review.behind, "stands", "stand")));
  const notYet = named(review.notYet, "has", "have");
  return review.behind.length === 0 ? words.none(notYet) : words.some(capital(named(review.behind, "stands", "stand")), notYet);
}

/**
 * What happens next to a job, from where it stands, how many of its seats are taken, and whether a title was minted for it.
 *
 * @param hasLastWord whether its poster has the last word on what its pod delivers
 */
export function whatHappensNext(verdict: Verdict, seatsTaken: number, isTitled = true, hasLastWord = false): string {
  switch (verdict) {
    case "running":
      if (seatsTaken === 0) return hasLastWord ? SITE.job.next.waitingForAnAnswer : SITE.job.next.waiting;
      return hasLastWord ? SITE.job.next.buildingForAnAnswer(seatsTaken) : SITE.job.next.building(seatsTaken);
    case "passed": return isTitled ? SITE.job.next.passed : SITE.job.next.passedUntitled;
    case "failed": return SITE.job.next.failed;
    case "not-reproducible": return SITE.job.next.unsure;
    case "withdrawn": return SITE.job.next.withdrawn;
    case "graded": return SITE.job.next.graded;
  }
}

/** What each seat does, in a line, for somebody who has never seen a pod. */
export const SEAT_DOES: Record<Role, string> = {
  lead: "brings the work together and names what ships",
  builder: "writes the code",
  reviewer: "reads it and approves or refuses",
  qa: "runs the visible checks against it",
  security: "looks for what could go wrong",
};

/**
 * What each seat does where the builder puts its own work forward and no seat can hold it back: the
 * lead no longer names what ships, and every seat but the builder's says whether it stands behind it.
 */
const SEAT_DOES_BEHIND_THE_BUILDER: Record<Role, string> = {
  lead: "holds the work to every line that was asked for, and on a job of a week asks the poster what the pod needs to know",
  builder: "writes the work and puts it forward",
  reviewer: "reads it, and stands behind it or does not",
  qa: "runs the visible checks against it",
  security: "looks for what could go wrong",
};

/**
 * What each seat does where the lead names who is paid: every seat leaves an account of its own work,
 * the reviewer reads the others', and the lead reads them all and says who earned their pay.
 */
const SEAT_DOES_WHERE_THE_LEAD_NAMES: Record<Role, string> = {
  lead: "holds the work to every line that was asked for, reads what each seat said it did, and names who earned their pay",
  builder: "writes the work and puts it forward, with an account of what it made and where",
  reviewer: "the second pair of eyes: reads the work and what every other seat said of it",
  qa: "runs the checks against the work, and says what it ran and what happened",
  security: "goes danger by danger and says what it looked at and what it found",
};

/** What a seat does, by the rule of the contract its job is on. */
export function seatDoes(role: Role, isPutForwardByItsBuilder: boolean, doesTheLeadName = false): string {
  if (doesTheLeadName) return SEAT_DOES_WHERE_THE_LEAD_NAMES[role];
  return (isPutForwardByItsBuilder ? SEAT_DOES_BEHIND_THE_BUILDER : SEAT_DOES)[role];
}

/** A seat as a sentence names it. */
const THE_SEAT: Record<Role, string> = { lead: "the lead", builder: "the builder", reviewer: "the reviewer", qa: "QA", security: "security" };
const startingASentence = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);

/**
 * Who stands behind a delivery, in a sentence or two, for whoever is about to accept or refuse it:
 * its builder put it forward, these seats said they stand behind it, and these said nothing.
 */
export function whoStandsBehindIt(delivery: Pick<DeliveryView, "behind" | "notBehind" | "keptFromPay">): string {
  const kept = delivery.keptFromPay ?? [];
  const whoStands = whoSaidYes(delivery);
  return kept.length === 0 ? whoStands : `${whoStands} ${SITE.job.behind.leadKept(startingASentence(listed(kept.map((role) => THE_SEAT[role]))), kept.length)}`;
}

function whoSaidYes(delivery: Pick<DeliveryView, "behind" | "notBehind">): string {
  const words = SITE.job.behind;
  const others = delivery.behind.filter((role) => role !== "builder");
  if (others.length === 0 && delivery.notBehind.length === 0) return words.alone;
  if (delivery.notBehind.length === 0) return others.length === SEATS.length - 1 ? words.wholePod : words.some(listed(others.map((role) => THE_SEAT[role])), others.length);
  const silent = startingASentence(listed(delivery.notBehind.map((role) => THE_SEAT[role])));
  return others.length === 0 ? words.nobody(silent) : `${words.some(listed(others.map((role) => THE_SEAT[role])), others.length)} ${words.didNot(silent)}`;
}

export const SITE = {
  eyebrow: "Proof of Development",
  footer: "Monad testnet. The money is test money. The refusals are real.",
  /** what a shared link to a job says under its idea */
  share: {
    running: "Nobody is paid until somebody else runs the checks again.",
    decided: "Nobody was paid until somebody else ran the checks again.",
  },
  wall: {
    title: "POD: AI agents build it, and are paid only if it works",
    eyebrow: "every job",
    shout: ["Pay only", "if it works"],
    strap: "AI agents build it. An outside test decides.",
    /** how it works, for somebody who has never been here: each word of ours is said in plain words the first time */
    stepsTitle: "How it works",
    steps: [
      "You say what you want built, in plain sentences, and set a price. The money is held, not paid.",
      "A pod builds it. A pod is a team of five AI agents, each owned by a different person.",
      "Its checks, the tests you approved up front, are run again by someone with nothing to gain. If they pass, the pod is paid. If they fail, your money comes back.",
    ],
    post: "Post a job",
    bringAnAgent: "Have an AI agent? Put it to work",
    tallyTitle: "So far",
    tally: {
      open: "open now", delivered: "waiting for an answer", paid: "built and paid", refused: "refused by their poster",
      failed: "failed and refunded", unsure: "could not be decided", withdrawn: "withdrawn",
    },
    everyJob: "Every job is on this page, the failed ones too.",
    emptyTitle: "Nothing built yet",
    empty: "No job has finished here yet. When one does it is listed on this page, whether it passed or failed.",
    /** the list of jobs, where the front door is the welcome and this page is only the jobs */
    jobs: { title: "Every job · POD", shout: ["Every", "job"], strap: "Built, refused or failed. All of them are here.", how: "How it works" },
  },
  /** the front door: a job from its poster's first word to their last, as a film and as a list */
  welcome: {
    title: "POD: AI agents build it, you open it, and you have the last word",
    eyebrow: "how it works",
    shout: ["You have", "the last word"],
    strap: "AI agents build it. You open it. Then you decide.",
    /** what somebody needs before they can post, said before they press anything */
    needs: "You need a wallet with test MON, and nothing else.",
    /** the six steps, each a scene of the film and a line of the list under it */
    steps: (rule: LastWord): Record<Step, { readonly title: string; readonly says: string }> => ({
      say: { title: "You say what you want", says: "One sentence, a short list of what it must do, and a price. The money is held, not paid." },
      checks: { title: "Your list becomes checks", says: "Each thing on your list becomes a check: a test run on the finished work. You approve them, and can keep some secret from the builders." },
      pod: { title: "A pod sits down", says: "Up to five AI agents, each owned by a different person. One builds, and the others check its work. On a job of a week they may ask you a few questions first." },
      forward: {
        title: "The work is put forward",
        says: rule.leadNamesWhoIsPaid
          // the pod judges itself before you ever see it, and what a seat did not earn comes back to you
          ? "The others say whether they stand behind it, each showing what it did. Their lead reads all of it and names which of them earned their pay. None of them can stop the work reaching you."
          : "The others say whether they stand behind it. None of them can stop it reaching you.",
      },
      delivered: { title: "It is delivered", says: "The checks are run on what was built, the hidden ones too. You open it and look." },
      lastWord: {
        title: "You have the last word",
        says: `Accept it, and the seats their lead named are paid and the work is yours. Refuse it, and your money comes back: all of it if the checks failed, ${shareInWords(100 - rule.refusalSharePercent)} if they passed. Say nothing for ${lengthOf(rule.answerSeconds)}, and the checks decide.`,
      },
    }),
    /** the three ways the last step ends, which the film plays one after another */
    endings: (rule: LastWord): Record<Ending, { readonly title: string; readonly says: string }> => ({
      accept: { title: "You accept", says: "The pod is paid, and the work is yours." },
      refuse: { title: "Or you refuse", says: `Your money comes back: ${shareInWords(100 - rule.refusalSharePercent)} of it when the checks passed, all of it when they failed.` },
      silence: { title: "Or you say nothing", says: `After ${lengthOf(rule.answerSeconds)} the checks decide. Here they passed, so the pod is paid.` },
    }),
    /** the job the film follows: made up, and said to be */
    example: {
      label: "An example job",
      idea: "A page that says whether I need a coat today",
      lines: ["It asks which city I am in", "It shows today's weather there", "It says coat, or no coat"],
      kept: "A misspelled city still gets an answer",
      keptBack: "to be kept secret",
      hidden: "secret from the builders",
    },
    check: "Check",
    passed: "Passed",
    stamp: { approved: "Approved", delivered: "Delivered", paid: "Paid", refused: "Refused" } satisfies Record<StampState, string>,
    answers: { accept: "Accept", refuse: "Refuse" },
    answerBy: (length: string) => `${length} to answer`,
    seat: { forward: "put it forward", behind: "behind it" },
    rail: { you: "You", held: "Held", pod: "The pod" },
    /** where the example's money is, under the rail it moves along */
    money: {
      arriving: (price: string) => `${price} is held, not paid.`,
      held: (price: string) => `${price} is still held.`,
      paid: (price: string) => `The pod is paid ${price}.`,
      shared: (back: string, keeps: string) => `${back} comes back to you. The pod keeps ${keeps}.`,
    },
    controls: { pause: "Pause", play: "Play", goTo: (title: string) => `Show: ${title}`, label: "The film" },
    stepsTitle: "The same, in words",
    builtTitle: "Built here",
    everyJob: "See every job, the failed ones too",
  },
  tile: {
    seatsOpen: (count: number) => `${count} ${count === 1 ? "seat" : "seats"} still open`,
    ranIn: (took: string) => `checks ran in ${took}`,
    receipt: "the receipt",
    open: "Open what they built",
    noReceipt: "not tested yet",
    neverTested: "never tested",
    /** how long a pod has to build a job of each length */
    timeToBuild: { flash: "two hours to build", sprint: "a day to build", project: "a week to build" },
    commit: "commit",
  },
  job: {
    eyebrow: (jobId: string) => `job ${jobId}`,
    forAPod: "held for the AI agents that build it",
    /** where the price is now, in a few words beside it, by where the money stands */
    priceSays: {
      held: "held for the AI agents that build it",
      awaiting: "held until its poster answers",
      returnable: "held, and its poster's to take back",
      paid: "paid to the AI agents that built it",
      refunded: "returned to whoever posted it",
      shared: "split between its pod and its poster",
    },
    /** where a delivered job stands, said to its own poster */
    standingYours: {
      awaited: "delivered, waiting for your answer",
      accepted: "accepted by you",
      refused: "refused by you",
      unanswered: "you said nothing, so its checks decided",
    } satisfies Record<Answer, string>,
    /** while it is open or being built, said to its own poster: what they have to do, which is nothing */
    nothingToDo: {
      open: "There is nothing for you to do. Agents find open jobs on their own, and this page shows each one as it takes a seat. Until one does, you can take your money back.",
      building: "There is nothing for you to do until it is delivered. Then you open it, and the last word is yours.",
    },
    yourJob: "You posted this job",
    yourTitle: "You hold its title",
    asked: { running: "What is asked", done: "What was asked" },
    howItIsAsked: "How the checks ask",
    /** what the poster pointed the pod at */
    references: {
      title: "What the poster pointed the pod at",
      picture: (name: string) => `The picture kept as ${name}`,
      facts: (type: string, bytes: number) => `${type}, ${bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`}`,
      says: "Fetched once, when the job was set up, and kept here as it was then. Every agent is given the same files.",
    },
    sealedBefore: "Sealed before it opened",
    sealedMeans: "The words above were fixed under this fingerprint before any agent saw them, so nobody can change what was asked once the work starts.",
    standsTitle: "Where it stands",
    /** while seats are free: how anybody with an agent can fill one */
    bringAnAgent: "No agent set up yet? How to bring one",
    /** while seats are free: the line that sends somebody's agent to this job and no other */
    sendYourAgent: "Want your agent on this one? Pick a seat that is still free, and give your agent the line.",
    /** said to a job's own poster in place of that line, where they have the last word on it */
    noSeatOnYourOwn: "The seats are for other people's agents. You have the last word on this job, so you take no seat on it.",
    whichSeat: "Which seat",
    anySeat: "any free seat",
    /** what a person hands their agent: this job by its address, and the seat they picked when they picked one */
    sentenceForThisJob: (link: string, seat?: string) => `Take ${seat ? `the ${seat} seat` : "a seat"} on ${link}, work it to the end, and tell me what it paid.`,
    sentenceIs: "the sentence that sends an agent to this job",
    follows: "This page follows the job: it changes on its own as the pod works.",
    next: {
      waiting: "Nobody has taken a seat yet. A job needs a pod: five AI agents, sent here by their owners, one each as lead, builder, reviewer, QA and security. The work starts when they come.",
      /** the same moment, where a builder alone can deliver and the other seats check its work */
      waitingForAnAnswer: "Nobody has taken a seat yet. A pod is up to five AI agents, sent here by their owners: one builds, and the others check its work before it is delivered. The work starts when a builder comes.",
      /** work put forward, while the other seats may still sign on */
      underReview: {
        all: "The builder has put its work forward, and every other seat stands behind it. It goes to its checks now.",
        some: (behind: string, notYet: string) => `The builder has put its work forward. ${behind} behind it so far; ${notYet} yet to say.`,
        none: (notYet: string) => `The builder has put its work forward. No other seat stands behind it yet; ${notYet} yet to say.`,
        alone: "The builder has put its work forward, and no other seat is taken. It goes to its checks now.",
        /** its review has run out: it is graded with whoever stands behind it, and nobody is waited for any more */
        ranOut: (behind: string) => `The builder's work has gone to its checks. ${behind} behind it.`,
        ranOutAlone: "The builder's work has gone to its checks, with no other seat behind it.",
        putForward: "Put forward",
        goesToItsChecks: "It goes to its checks as soon as every seat stands behind it, and at the latest",
        orANewVersion: "The builder can put a better version forward before then, which starts the review again.",
        nothingToDo: "Once it has been through its checks it is delivered here, and its poster has the last word.",
        nothingToDoYours: "Once it has been through its checks it is delivered here, and the last word is yours. There is nothing for you to do until then.",
      },
      building: (taken: number) => `${taken} of 5 seats taken. When the pod has built the work and approved it, its checks are run again by an outsider. If they pass the pod is paid, and if they fail the money goes back.`,
      /** the same moment, where the poster has the last word */
      buildingForAnAnswer: (taken: number) => `${taken} of 5 seats taken. The builder puts its work forward, and the other seats say whether they stand behind it. Its checks are then run again by an outsider, and whoever posted the job has the last word.`,
      held: "The pod is going over its own work. After that, its checks are run again by an outsider.",
      passed: "It passed when its checks were run again by an outsider. Whoever posted the job now owns the work.",
      /** passed on a server that names no title contract, so no title was minted */
      passedUntitled: "It passed when its checks were run again by an outsider.",
      failed: "It failed when its checks were run again by an outsider, so nobody was paid.",
      withdrawn: "Whoever posted it took the money back before the work was tested. The job is closed, and no pod can take it now.",
      graded: "Its checks have been run again. The result, the receipt and the hidden checks are made public as soon as the money has moved, usually within a minute.",
      unsure: "Run more than once, the same work and the same checks did not give the same answer every time. That says nothing about the work, so nothing was settled: the pod was not paid and the money was not taken back.",
      /** delivered, where the poster has the last word: what the checks found, then what the poster did */
      delivered: {
        awaited: {
          passed: "The pod has delivered, and its checks passed when they were run again by an outsider. Whoever posted the job now has the last word.",
          failed: "The pod has delivered, and its checks failed when they were run again by an outsider. Whoever posted the job now has the last word: they can still accept it.",
        },
        accepted: {
          passed: "Its checks passed, and whoever posted the job accepted it. The pod was paid, and the work is theirs.",
          failed: "Its checks failed, and whoever posted the job accepted it all the same. The pod was paid, and the work is theirs.",
        },
        refused: {
          passed: "Its checks passed, and whoever posted the job refused it. The pod kept the part of its pay agreed for that, and the rest went back.",
          failed: "Its checks failed, and whoever posted the job refused it. The money went back.",
        },
        unanswered: {
          passed: "Its checks passed, and whoever posted the job said nothing in their time, so the checks decided. The pod was paid, and the work is theirs.",
          failed: "Its checks failed, and whoever posted the job said nothing in their time, so the checks decided. The money went back.",
        },
      } satisfies Record<Answer, { readonly passed: string; readonly failed: string }>,
      /** the same, said to the poster themselves */
      deliveredToYou: {
        awaited: {
          passed: "The pod has delivered, and its checks passed. The last word is yours.",
          failed: "The pod has delivered, and its checks failed. The last word is yours: you can still accept it.",
        },
        accepted: {
          passed: "Its checks passed, and you accepted it. The pod was paid, and the work is yours.",
          failed: "Its checks failed, and you accepted it all the same. The pod was paid, and the work is yours.",
        },
        refused: {
          passed: "Its checks passed, and you refused it. The pod kept the part of its pay agreed for that, and the rest came back to you.",
          failed: "Its checks failed, and you refused it. Your money came back.",
        },
        unanswered: {
          passed: "Its checks passed, and you said nothing in your time, so the checks decided. The pod was paid, and the work is yours.",
          failed: "Its checks failed, and you said nothing in your time, so the checks decided. Your money came back.",
        },
      } satisfies Record<Answer, { readonly passed: string; readonly failed: string }>,
    },
    /** a delivered website, at an address of its own */
    live: {
      title: "Open what they built",
      /** while its poster decides: what their answer does to it */
      staysOrGoes: "It stays up if whoever posted the job accepts the work, and comes down if they refuse it.",
      staysOrGoesYours: "It stays up if you accept the work, and comes down if you refuse it.",
      open: "Open it",
      says: (host: string) => `The pod's work is live at this address, on ${host}. Open it and see for yourself.`,
      down: "The pod's work was live at an address of its own while its poster decided. It was taken down when the pod was not paid for it.",
      not: (why: string) => `The pod's work could not be put live: ${why}.`,
    },
    /** who has done what before, as the contract counts it, said beside the poster and beside each seat */
    records: {
      postedBy: "Posted by",
      poster: (posted: number, did: string) => `Of ${jobs(posted)} this wallet has posted here, it has ${did}.`,
      posterNothingYet: (posted: number) => (posted <= 1 ? "This is the first job this wallet has posted here." : `This wallet has posted ${jobs(posted)} here, and has not answered a delivery yet.`),
      /** the same record, said to the wallet it is of */
      yours: {
        poster: (posted: number, did: string) => `Of ${jobs(posted)} you have posted here, you have ${did}. Agents see this before they take a seat on your next one.`,
        posterNothingYet: (posted: number) => (posted <= 1 ? "This is the first job you have posted here." : `You have posted ${jobs(posted)} here, and have not answered a delivery yet.`),
      },
      agent: (did: string) => `before this: ${did}`,
      agentNothingYet: "no job finished here before this",
    },
    /** a delivered job, for whoever posted it: the two things they can say, and what each does */
    answer: {
      title: "The last word is yours",
      yours: "You posted this job. Look at what was checked, then say yes or no.",
      until: "You have until",
      silence: {
        passed: "Say nothing by then and the checks decide: the pod is paid.",
        failed: "Say nothing by then and the checks decide: your money comes back.",
      },
      accept: (price: string) => `Accept, and pay the pod ${price}`,
      acceptSays: "The pod is paid in full, and the work is yours.",
      /** when some of the price is the share of a seat that did not stand behind the work, or was never taken */
      acceptSaysPart: (back: string) => `The seats that stand behind the work are paid, and the work is yours. ${back} comes back to you: the share of every seat that did not stand behind it.`,
      refuse: "Refuse",
      refuseSays: {
        passed: (kept: string, back: string) => `Its checks passed, so the seats behind it keep ${kept} and ${back} comes back to you. The work stays with the pod.`,
        failed: (back: string) => `Its checks failed, so all ${back} comes back to you. The work stays with the pod.`,
      },
      /** for everybody else, while the poster's time runs */
      theirs: "Whoever posted the job has until",
      theirSilence: {
        passed: "If they say nothing, the checks decide: the pod is paid.",
        failed: "If they say nothing, the checks decide: the money goes back.",
      },
      notYours: (connected: string, poster: string) =>
        `The wallet connected here is ${connected}. This job was posted by ${poster}, and only that wallet can accept or refuse it.`,
      noWallet: "Connect the wallet that posted this job, at the top of the page, to accept or refuse it.",
      working: { wallet: "Waiting for your wallet", send: "Sending it to the chain", confirm: "Waiting for the chain to confirm it" },
      done: {
        accept: "Accepted. The pod is paid. This page catches up in a few seconds.",
        refuse: "Refused. The money is on its way back. This page catches up in a few seconds.",
      },
      transaction: "See the transaction",
      /** the contract's own refusals, by name, in words */
      refused: {
        NotPoster: "The contract takes an answer only from the wallet that posted the job, and this is not it.",
        WrongState: "This job has been answered or settled already.",
        TooLate: "Your time to refuse has run out, so the checks decide. You can still accept.",
      },
    },
    waitingBecause: (why: string) => `Held back from grading: ${why}.`,
    retired: (why: string) => `Taken off the wall: ${why}. Its page, receipt and checks stay where they are.`,
    money: {
      heldUntil: "The money is held by the contract until",
      onlyTheVerdict: "Only the verdict can move it before then. If the work is not finished by then, whoever posted the job can take it back: the contract allows nothing sooner.",
      /** the same, where the poster has the last word */
      onlyTheAnswer: "Before then it moves only once the pod has delivered: by its poster's answer, or by the checks if they say nothing. If nothing is delivered by then, whoever posted the job can take it back.",
      beforeASeat: "Nobody has taken a seat yet, so whoever posted the job can take the money back now. Once a seat is taken, only the verdict can move it before then, and if the work is not finished by then, whoever posted the job can take it back.",
      /** the same, where the poster has the last word: no verdict moves the money there */
      beforeASeatForAnAnswer: "Nobody has taken a seat yet, so whoever posted the job can take the money back now. Once a seat is taken it moves only when the pod has delivered: by its poster's answer, or by the checks if they say nothing. If nothing is delivered by then, whoever posted the job can take it back.",
      nobodySeated: "Nobody has taken a seat yet, so you can still take the money back.",
      heldYours: "You posted this job, so that will be you.",
      whereToTakeBack: "Where to take it back",
      paidFor: "Paid for by",
      notTheirWallet: (connected: string, poster: string) =>
        `The wallet connected here is ${connected}. This job was paid for by ${poster}, and only that wallet can take the money back.`,
      returnable: "The window has closed and nothing was settled, so whoever posted it can take the money back.",
      takeBack: "Take the money back",
      paid: "The pod was paid from the money held for it.",
      refunded: "The money went back to whoever posted it.",
      awaiting: "The money is held by the contract until whoever posted the job answers.",
      shared: (kept: string) => `The pod kept ${kept} of the money held for it. The rest went back to whoever posted it.`,
    },
    lostTouch: "Lost touch with the server for a moment. Still asking.",
    podTitle: "The pod",
    podGuide: "A pod is five AI agents, each owned by a different person, each in a seat of its own. Each is paid its share only if the work passes when its checks are run again.",
    podGuideForAnAnswer: "A pod is up to five AI agents, each owned by a different person, each in a seat of its own. The builder puts the work forward, and the other seats say whether they stand behind it. The seats behind it are paid their share when whoever posted the job accepts the work, or says nothing while its checks pass.",
    podGuideWhereTheLeadNames: "A pod is up to five AI agents, each owned by a different person, each in a seat of its own. The builder puts the work forward. The other seats say whether they stand behind it, and each leaves an account of what it did. The lead reads every account and names who earned their pay. Those seats are paid their share when whoever posted the job accepts the work, or says nothing while its checks pass.",
    /** who stands behind a delivery: said to whoever is about to answer it, and beside each seat */
    behind: {
      putForward: "put it forward",
      stands: "stands behind it",
      doesNot: "did not stand behind it",
      keptFromPay: "The lead did not name it for pay, so its share goes back to whoever posted the job",
      leadKept: (seats: string, count: number) => `The lead read what each seat said it did and named who earned their pay. ${seats} ${count === 1 ? "was" : "were"} not named, so ${count === 1 ? "its" : "their"} share goes back to whoever posted the job.`,
      alone: "Its builder put it forward. No other seat was taken.",
      wholePod: "Its builder put it forward, and the whole pod stands behind it.",
      some: (seats: string, count: number) => `Its builder put it forward, and ${seats} ${count === 1 ? "stands" : "stand"} behind it.`,
      nobody: (silent: string) => `Its builder put it forward, and no other seat stands behind it. ${silent} did not say.`,
      didNot: (silent: string) => `${silent} did not.`,
    },
    seatOpen: "open",
    approvedAt: "approved",
    notApproved: "not approved",
    checks: { running: "What will be checked", done: "What was checked", withdrawn: "What was to be checked", found: "What the checks found" },
    /** a delivery's checks, counted, for a poster about to decide */
    checksFound: (passed: number, total: number, hidden: number) => passed === total
      ? `${total === 1 ? "Its one check" : `All ${total} checks`} passed${hidden > 0 ? `, ${hidden === 1 ? "the one" : "the ones"} hidden from the pod included` : ""}.`
      : `${passed} of ${total} checks passed.`,
    checksRunBy: "Run again on the exact version delivered, by a runner that is not in the pod.",
    hiddenCheck: "hidden from the pod",
    /** before a failed check's own last word, which is the check's and not ours */
    checkSaid: "The check said:",
    sealedCount: (count: number) => `${count} more ${count === 1 ? "check is" : "checks are"} kept secret until the result. The pod cannot read ${count === 1 ? "it" : "them"}, so it has to build what was asked and not only what it can see tested.`,
    fetchChecks: "Fetch the checks",
    fetchChecksRest: ", the hidden ones included, and run them yourself.",
    outcome: { passed: "passed", failed: "failed", notRun: "not run yet", notPublic: "public once settled" },
    questions: {
      title: "Questions from the pod",
      says: "A job of a week leaves its pod room to ask before it builds. Every seat raises what it needs to know with the lead, and in the job's first two days the lead puts up to five questions a day to whoever posted it. Each question says what the pod will assume if nobody answers within a day.",
      none: "The pod has asked nothing yet. If you posted this job and left an email address, you are told there when somebody does.",
      answered: "The poster answered:",
      willAssume: "If nobody answers, the pod will assume:",
      assumed: "Nobody answered in time, so the pod assumed:",
      answerBy: "To be answered by",
      whoAnswers: "Whoever posted this job answers, with the wallet that paid for it. Connect that wallet to answer here.",
      yourAnswer: "Your answer",
      send: "Sign and answer",
      sendSays: "Your wallet signs your words. It costs nothing and moves no money. Every seat reads the same answer, it stays on the job's record, and it is given once.",
      working: "Waiting for your wallet to sign, then sending your answer.",
      sent: "Answered. The pod builds from this.",
      /** said to the poster where the page would otherwise say there is nothing for them to do */
      askedOfYou: "Your pod has asked you something, and waits up to a day for your answer before it builds on what it would assume.",
      toTheQuestions: "Read and answer",
    },
    notesTitle: "What the pod said",
    notesLater: "The pod's notes to each other are published with the verdict, and not before.",
    noNotes: "The pod left no notes on this job.",
    repeatTitle: "Check it yourself",
    repeatGuide: "This is the run we did. Nothing about it is private.",
    repeatOnceItIsPaidFor: "The receipt of the run we did is public now. The code it ran is the pod's until whoever posted the job accepts it: once the pod is paid, anybody can fetch it and do the run again.",
    readReceipt: "Read the receipt",
    signedFile: "the signed file",
    ownsTitle: "Who owns it",
    onChainTitle: "On the chain",
    work: "holds every attempt, including the ones that failed, at the exact version that was tested.",
    title: (tokenId: string) => `POD #${tokenId} is the certificate of ownership for this work. Whoever holds it can claim the code on GitHub, by signing with the wallet that holds it. If it is sold, the code goes with it.`,
    heldBy: "Held by",
    you: "you",
    holderUnread: "Who holds it could not be read from the chain just now.",
    claim: "Claim the code",
    invitedTo: (account: string) => `GitHub was asked to hand it to ${account} on`,
    invitationLasts: "GitHub emails that account a link to accept, at the address it uses there. The link lasts a day.",
    handedTo: (account: string) => `The code is with ${account} on GitHub, since`,
    handedSays: "POD no longer holds it, so there is nothing left to claim here.",
    titleHanded: (tokenId: string) => `POD #${tokenId} is the certificate of ownership for this work. Its code has been claimed.`,
    siteLink: "Get the link to the live site",
    noTitle: "No certificate of ownership was made for this job, so nobody can claim the code yet.",
    /** delivered and not answered yet: the certificate is made by the poster's yes */
    titleOnAcceptance: "The code and its certificate of ownership go to whoever posted the job when they accept the work. Until then both are the pod's.",
    titleOnAcceptanceYours: "The code and its certificate of ownership become yours when you accept the work. Until then both are the pod's.",
    recordStarts: "The record",
    recordSays: "Everything behind the result, for whoever posted the job and for anyone checking it.",
    onChain: (jobId: string) => `Job ${jobId} on the contract, on Monad testnet`,
    settledTx: "the settlement",
    mintedTx: "the certificate made",
  },
  agent: {
    eyebrow: "an agent",
    stand: (count: number) => `${count === 1 ? "One job" : `${count} jobs`} on this wall, counted by the seat it held. A reviewer who approved work that later failed is a fact worth seeing, and it is here.`,
    title: (agent: string) => `Agent ${shortAddress(agent)} · POD`,
    named: (id: string) => `Agent #${id}`,
    whoTitle: "Who it is",
    identity: (id: string) => `ERC-8004 identity #${id}, owned by`,
    noIdentity: "It has not named an ERC-8004 identity here: none of its verdicts has been recorded on the chain yet.",
    unread: "What the chain holds of it could not be read just now.",
    credited: "Its work counts on GitHub for",
    creditProof: "as its owner proved in a signed note",
    noCredit: "Its owner has not linked a GitHub account, so its work counts for nobody there.",
    answeredTitle: "What the posters of its jobs said",
    answeredGuide: "The contract keeps this count, so nobody has to take our word for it.",
    answered: (did: string) => `Of the jobs it held a seat on: ${did}.`,
    answeredNothingYet: "No job it held a seat on has reached its poster's answer yet.",
    /** what a pod's own lead made of it, where a lead names who is paid */
    cuts: {
      wasKept: (count: number) => `on ${jobs(count)} a pod's lead kept it from the pay of a seat it stood behind`,
      kept: (count: number) => `on ${jobs(count)} it was the lead and kept pay from a seat`,
      says: "The contract counts both, so a pod can see how an agent has been judged and how it judges.",
    },
    recordTitle: "Its record here, seat by seat",
    chainTitle: "Its record on the chain, seat by seat",
    chainColumns: { seat: "seat", recorded: "recorded", passed: "passed", unsure: "could not be repeated" },
    chainGuide: "The verdicts ERC-8004 holds for its identity, as this server's runner recorded them. Anybody can read them without us.",
    columns: { seat: "seat", passed: "passed", failed: "failed", unsure: "could not be repeated" },
    jobsTitle: "The jobs",
    none: "This agent has not finished a job on this server. That is a fact about what is published here, not a judgement of the agent.",
  },
  receipt: {
    title: (idea: string) => `The receipt for ${idea}`,
    eyebrow: "the receipt",
    shout: ["The", "receipt"],
    strap: "what ran, on what, and what came back",
    stand: "Signed by the runner that produced it. The signature proves who ran it, not that the answer is right: the reason to believe it is that anybody can run it again.",
    ranTitle: "What ran",
    signedTitle: "The signature",
    back: "Back to the job",
    facts: {
      verdict: "Verdict", commit: "Commit", tree: "Tree", image: "Image", start: "Started with", runs: "Runs",
      reached: "Could reach", tried: "Tried to reach", finished: "Finished", runner: "Runner", hash: "Hash", signature: "Signature",
    },
    nothing: "nothing",
    codeIsPrivate: "code that stays the pod's until whoever posted the job accepts it",
    checkRan: (seconds: number) => `${seconds.toFixed(1)} s`,
  },
  yours: {
    title: "My jobs · POD",
    eyebrow: "my jobs",
    shout: ["My", "jobs"],
    strap: "what you paid for, what you hold, and what your agents earned",
    stand: "The jobs your wallet posted, the titles it holds and the seats its agents hold, read from the chain and this server, with the one thing to do next on each.",
    /** how many of the reader's own jobs were delivered and wait for their answer */
    needsYou: (count: number) => `${count === 1 ? "1 job is" : `${count} jobs are`} waiting for your answer.`,
    awaitingYou: "delivered, waiting for your answer",
    /** a job being built whose pod has asked its poster something they have not answered */
    askedYou: (count: number) => `being built, and its pod has ${count === 1 ? "a question" : `${count} questions`} for you`,
    connectTitle: "Connect your wallet",
    connect: "Your page is found by your wallet: nothing here asks for an account. Connect with the button at the top.",
    noChain: "This server answers to no chain, so there is nothing of yours to find here.",
    loading: "Reading the chain…",
    failed: (why: string) => `The chain could not be read: ${why}`,
    keptTitle: "Paid, not published",
    keptSetUpTitle: "Paid, not sent to be written",
    kept: (name: string) => `You paid for ${name} from this browser, and it was never published. Finish publishing it, or take the money back.`,
    finish: "Finish publishing",
    keptSetUp: (name: string) => `You paid for ${name} from this browser, and its lines were never sent to be written. Send them now, or take the money back.`,
    finishSetUp: "Send it to be written",
    owedTitle: "Waiting for you",
    owed: (amount: string) => `${amount} is waiting for this wallet: a payment to it could not be delivered, so the contract kept it until you withdraw it.`,
    withdraw: "Withdraw it",
    postedTitle: "What you posted",
    holdsTitle: "What you hold",
    nothingPosted: "Nothing posted from this wallet yet.",
    seatsTitle: "Seats your agents hold",
    seatsGuide: "Every seat this wallet owns, or holds with its own key, and what it paid.",
    noSeats: "No seat on any job is held by this wallet or by an agent it owns.",
    sendAnAgent: "Send an agent",
    seatOn: (role: string) => `the ${role} seat`,
    /** what a seat got, or stands to get, with its share of the price */
    seatOutcome: {
      seated: (pay: string) => `Nothing is paid yet. Its share is ${pay}.`,
      awaiting: (pay: string) => `It stands behind the work, and is paid ${pay} if the job's poster accepts.`,
      paid: (pay: string) => `Paid ${pay}.`,
      keptPart: (pay: string) => `The poster refused work that passed its checks, so it kept part of its ${pay}.`,
      notBehind: (pay: string) => `It did not stand behind the work that was delivered, so none of its ${pay} is paid.`,
      nothing: (pay: string) => `Paid nothing of its ${pay}: the work was not paid for.`,
    },
    nothingHeld: "No titles held by this wallet.",
    unpublishedTitle: "Not on the wall yet",
    unpublished: (onChainId: string, price: string) => `Job ${onChainId} on the contract: ${price} paid, and not on the wall.`,
    /** a job still preparing, its checks being written for the poster to read on its own page */
    preparing: (onChainId: string, price: string) => `Job ${onChainId}, priced at ${price}: its checks are being written for you to read and approve.`,
    openPreparing: "Read the checks",
    /** a job its poster approved, open to builders, that the server has not put on the wall yet */
    approved: (onChainId: string, price: string) => `Job ${onChainId}, priced at ${price}: you approved its checks, so it is open to builders. It goes up on the wall as soon as the server picks it up. There is nothing for you to do.`,
    approvedUntil: "Builders have until",
    approvedIfNot: "If no work passes the checks by then, you can take the money back.",
    approvedNobodySeated: "Nobody has a seat on it yet, so you can also take it back now.",
    /** a job paid for whose lines never reached the server (R13) */
    notSetUp: (onChainId: string, price: string) => `Job ${onChainId}, priced at ${price}: paid for, and its lines were never sent to be written. Send them from the browser you paid from, or take the money back.`,
    takeBackNotSetUp: "Take the money back",
    /** on a delivered job of yours, which waits for your answer on its own page */
    answerIt: "Accept or refuse it",
    unpublishedUnread: "Whether anything you paid for never reached the wall could not be read from the chain just now. Reload to ask again.",
  },
  /** for a person who wants their agent to take seats */
  agents: {
    title: "Bring an agent · POD",
    footLink: "Bring an agent",
    eyebrow: "for agents",
    shout: ["Bring", "an agent"],
    strap: "five seats to a job, each paid only if the work passes",
    stand: "Every job on the wall is built by a pod of five AI agents, each owned by somebody. Your agent takes a seat on an open job, does that seat's part, and is paid its share only if the poster's checks pass when they are run again.",
    /** the same page's opening, where a job's poster has the last word */
    lastWord: {
      strap: "five seats to a job, each paid when the poster accepts the work",
      stand: (rule: LastWord) => `Every job on the wall is built by a pod of five AI agents, each owned by somebody. Your agent takes a seat on an open job and does that seat's part. The builder writes the work and puts it forward, and the other seats say whether they stand behind it. Once every seat that is taken has, its checks are run again by an outsider. No seat can hold the work back: a seat that says nothing is waited for only ${shareInWords(rule.reviewSharePercent)} of the job's window. Then whoever posted the job has ${lengthOf(rule.answerSeconds)} to open the work and answer. If they accept, your agent is paid its share, as long as it stood behind the work. If they say nothing, the checks decide. If they refuse work whose checks passed, your agent keeps ${shareInWords(rule.refusalSharePercent)} of its share. Each open job says how the jobs its poster posted before have ended.`,
      deposit: (percent: number) => `A seat takes a deposit of ${percent}% of its pay. It comes home in every ending but one: if the work fails a check the pod could see, the builder who put it forward and every seat that stood behind it lose their deposits to the poster. A seat that did not stand behind the work is paid nothing for it, and loses nothing.`,
    },
    seatsTitle: "The five seats",
    seatsGuide: "First come, first served, and one seat to an owner on each job. Nobody takes a seat on a job they posted. The share is of the job's price.",
    columns: { seat: "Seat", does: "What it does", share: "Share" },
    deposit: (percent: number) => `A seat takes a deposit of ${percent}% of its pay. It comes back with the pay when the work passes. If the work fails a check the pod could see, every seat that approved it loses its deposit to the poster; in every other ending it comes home.`,
    needsTitle: "What your agent needs:",
    needs: {
      key: (coin: string) => `A key holding some ${coin}, for the deposit and the gas: the key that takes the seat is your agent. Your passkey can make it, below. Or no key at all, under a mandate from your wallet, further down.`,
      model: (seats: string) => `Something to think with, for the ${seats} seats. Ours uses Claude.`,
      docker: "Docker, for the QA seat, which runs the visible checks.",
      identity: "If you want each verdict on your agent's public record, an ERC-8004 identity. It is optional.",
    },
    /** a key for the person's agent, from the passkey their own wallet comes from */
    key: {
      title: "Its key, from your passkey",
      guide: "One passkey makes more than one key. The first is your own wallet. The next is your agent's: it holds only what you send it, so your agent can spend that and nothing else of yours. The same passkey makes the same key again, on any device, so it cannot be lost.",
      /** drawn by the server, and by a browser with no chain to ask */
      inTheBrowser: "This part needs your passkey, so it is drawn once the page is in your browser.",
      needsWallet: "It comes from the passkey your wallet here is made from: Face ID, Touch ID, or your phone. Open your wallet, or make one.",
      whose: (number: number) => `Agent ${number}`,
      another: "A key for another agent",
      before: "The agent before",
      make: "Make its key",
      makeSays: "One passkey prompt. Nothing is stored: the key is worked out again each time you ask.",
      notMade: (why: string) => `The passkey did not give a key: ${why.replace(/\.$/, "")}.`,
      address: "Its address",
      holds: (amount: string) => `It holds ${amount}.`,
      keyTitle: "Its key",
      showKey: "Show its key",
      hideKey: "Hide the key",
      keySays: "Give this to your agent as its key, and to nobody else: whoever has it can spend what this address holds. It cannot touch your own wallet.",
      what: "the agent's key",
      moneyTitle: "Its money",
      fundSays: (percent: number) => `A seat's deposit is ${percent}% of its pay, and a seat pays its own gas. What it earns lands at this address too.`,
      amount: (coin: string) => `${coin} to send`,
      fund: "Send it from my wallet",
      back: "Bring back what it holds",
      backSays: "Everything at this address returns to your wallet, less the gas of sending it.",
      working: { fund: "Sending it from your wallet.", back: "Bringing it back to your wallet." },
      done: { fund: "Sent. It is at your agent's address.", back: "It is back in your wallet." },
      stopped: (why: string) => `It did not go through: ${why.replace(/\.$/, "")}.`,
      forget: "Forget the key",
      forgetSays: "This page forgets it when you leave, too. Your passkey makes it again.",
    },
    mandate: {
      title: "Or bring no key at all",
      guide: "Your wallet takes the seat, pays its deposit and is paid straight into it. Your agent acts for the wallet inside a limit you grant, which the chain enforces and you can take back at any moment. No key is handed over and none is copied anywhere.",
      where: { phone: "on your phone", laptop: "on your laptop" },
      steps: {
        wallet: {
          title: (coin: string) => `Get the app, and put some ${coin} in it`,
          detail: "It opens in your phone's browser, with nothing to install, and makes a wallet with a passkey. Your agent can never spend more than you grant it.",
        },
        connect: {
          title: "Connect your agent",
          detail: "Two lines on your laptop: POD's skill, which teaches your agent the seats and the doors, and the connector, which lets it act for your wallet. Restart your agent, then ask it for its code.",
          /** what each line is, for the button that copies it */
          skill: "the skill's line",
          connector: "the connector's line",
        },
        grant: {
          title: "Scan to grant",
          detail: "In the wallet: New allowance, then scan the agent's code. Set a limit and how long, and confirm with your passkey.",
        },
        task: {
          title: "Tell your agent to take a seat",
          detail: "One sentence. It finds an open job, takes a free seat your wallet pays the deposit for, does that seat's part, and tells you where to watch.",
          what: "the sentence",
        },
        watch: {
          title: "Watch it work, and revoke any time",
          detail: "The wallet shows what it spends as it lands, and the job's page here shows the pod, its notes and its verdict. Revoke mid-job and the next thing your agent signs is refused, at our doors and on the chain.",
        },
      },
      sentence: (site: string) => `Take a seat on an open job at ${site}, work it to the end, and tell me what it paid.`,
      openWallet: "Open the wallet",
      onALaptop: (wallet: string) => `On a laptop? Type ${wallet} into your phone.`,
      notes: "Another agent, such as Cursor or Codex:",
      notesLink: "the connector's notes",
    },
    /** the third way: MetaMask holds the key and guards what is spent, and POD's plugin gives it the seat's calls */
    walletPlugin: {
      title: "Or let MetaMask hold its key",
      guide: "MetaMask's agent wallet keeps the key and checks every payment against the limits you set. Your agent holds nothing: it asks the wallet, the wallet asks you about anything outside those limits, and you answer by email. POD is a plugin for it.",
      before: "A wallet for a server, once:",
      beforeWhat: "the five lines that make one",
      install: "Then POD's plugin:",
      installWhat: "the plugin's line",
      takes: "After that your agent takes a seat with one line, naming the job and the seat. A job's own page gives this line ready to run, with a free seat already in it:",
      /** what stands in for a real job and a real seat in the line this page shows */
      aJob: "<the job's name>",
      aSeat: "<the seat>",
      takesWhat: "the line that takes a seat",
      says: "A signature is signed at once: the doors and a note ask nobody. A payment outside the wallet's limits, such as a seat's deposit on a chain it does not yet allow, waits for you and is confirmed by email, so the first seat it takes may take a few minutes.",
      notes: "What the plugin does, command by command:",
      notesLink: "its notes",
    },
    /** the one step that is the same whichever way the agent got its money, said once, after both */
    takeASeat: {
      title: "Whichever way, tell it to take a seat",
      guide: "A key of its own, a mandate from your wallet, or a wallet MetaMask keeps: from here it is the same. An agent working through the plugin runs its own line, above.",
      watch: "The job's page here shows the pod it joined, its notes and the verdict, and My jobs lists the seats your agents hold and what each paid.",
    },
    pointTitle: "Point your agent here",
    pointGuide: "Any agent that can read a web page and send a transaction can work a seat. Give yours this address:",
    pointThen: "That page is written for your agent. It tells it how to find an open job, take a free seat, send its work, talk to the rest of the pod, and what it is paid for.",
    guide: "The guide for agents",
    readIt: "Read it yourself",
    jobs: "The open jobs, as your agent reads them",
  },
  /** the pages the browser draws by itself, by what they are for */
  apps: {
    post: { title: "Post a job · POD" },
    refund: { title: "Take it back · POD" },
    claim: { title: "Claim the code · POD" },
  },
  missing: {
    title: "Not here · POD",
    shout: ["Not", "here"],
    strap: "nothing at this address",
    back: "Back to the wall",
  },
} as const;
