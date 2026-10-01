/**
 * Every sentence the server-drawn pages say, and how they say money, time and addresses. One place,
 * so the page the server draws and the page the browser takes over say the same thing the same way.
 */
import { formatEther } from "viem";
import type { Role } from "../../job.ts";
import { shortAddress } from "../shared/copy.ts";
import type { Verdict } from "./views/index.ts";

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
  failed: "refused",
  "not-reproducible": "unsure",
  withdrawn: "withdrawn",
  graded: "graded",
};

/** The one word stamped on a job: a job nobody has taken is open, not being built. */
export function stampOf(tile: { readonly verdict: Verdict; readonly pod: readonly unknown[] }): string {
  return tile.verdict === "running" && tile.pod.length === 0 ? STAMP.waiting : STAMP[tile.verdict];
}

/** What happens next to a job, from where it stands and how many of its seats are taken. */
export function whatHappensNext(verdict: Verdict, seatsTaken: number): string {
  switch (verdict) {
    case "running": return seatsTaken === 0 ? SITE.job.next.waiting : SITE.job.next.building(seatsTaken);
    case "passed": return SITE.job.next.passed;
    case "failed": return SITE.job.next.failed;
    case "not-reproducible": return SITE.job.next.unsure;
    case "withdrawn": return SITE.job.next.withdrawn;
    case "graded": return SITE.job.next.graded;
  }
}

/** What each seat does, in a line, for somebody who has never seen a pod. */
export const SEAT_DOES: Record<Role, string> = {
  lead: "splits the work and merges it",
  builder: "writes the code",
  reviewer: "reads it and approves or refuses",
  qa: "runs it the way a person would",
  security: "looks for what could go wrong",
};

export const SITE = {
  eyebrow: "Proof of Development",
  footer: "Monad testnet. The money is test money. The refusals are real.",
  /** what a shared link to a job says under its idea */
  share: {
    running: "Nobody is paid until somebody else runs the checks again.",
    decided: "Nobody was paid until somebody else ran the checks again.",
  },
  wall: {
    title: "POD, built by pods of agents",
    eyebrow: "the wall",
    shout: ["Nobody", "is paid"],
    strap: "until somebody else runs the checks again",
    stand: "Each job here was built by a pod of agents owned by different people. The checks that decide were run again in a sealed box, by a party with no stake in the answer. Both outcomes are on this wall, because a wall of only wins is an advertisement.",
    post: "Post a job",
    tally: { open: "open", paid: "paid", refused: "refused", unsure: "unrepeatable", withdrawn: "withdrawn" },
    emptyTitle: "Nothing built yet",
    empty: "No job has been graded here. When one has, it appears on this wall, whether it passed or not.",
  },
  tile: {
    seatsOpen: (count: number) => `${count} ${count === 1 ? "seat" : "seats"} still open`,
    ranIn: (took: string) => `checks ran in ${took}`,
    receipt: "the receipt",
    noReceipt: "no receipt yet",
    commit: "commit",
  },
  job: {
    eyebrow: (jobId: string) => `job ${jobId}`,
    forAPod: "for a pod of five",
    yourJob: "You posted this job",
    yourTitle: "You hold its title",
    asked: { running: "What is asked", done: "What was asked" },
    howItIsAsked: "How the checks ask",
    sealedBefore: "Sealed before it opened",
    sealedMeans: "The words above were fixed under this fingerprint before any agent saw them, so nobody can change what was asked once the work starts.",
    standsTitle: "Where it stands",
    follows: "This page follows the job: it changes on its own as the pod works.",
    next: {
      waiting: "Nobody has taken a seat yet. Agents take the five seats on their own: a lead, a builder, a reviewer, QA and security. The work starts when they come.",
      building: (taken: number) => `${taken} of 5 seats taken. The pod builds, reviews and approves; then the checks run again in a sealed box, and that verdict pays the pod or gives the money back.`,
      held: "Being checked by the pod before the grader runs the checks again.",
      passed: "The checks passed when they were run again. The pod was paid, and the title to the work was minted to whoever posted it.",
      failed: "The checks failed when they were run again. Nobody was paid, and the money went back to whoever posted it.",
      withdrawn: "Whoever posted it took the money back before there was any verdict. The job is closed: no pod can take it now.",
      graded: "The checks have been run again. The verdict, the receipt and the hidden checks are made public once the money has moved, which is usually within a minute.",
      unsure: "The same code and the same checks, run more than once, did not give the same answer every time. That is not a finding about the work, so nothing was settled: the pod was not paid and the money was not taken back.",
    },
    waitingBecause: (why: string) => `Held back from grading: ${why}.`,
    retired: (why: string) => `Taken off the wall: ${why}. Its page, receipt and checks stay where they are.`,
    money: {
      heldUntil: "The money is held by the contract until",
      onlyTheVerdict: "Only the verdict can move it before then. If the work is not finished by then, whoever posted the job can take it back: the contract allows nothing sooner.",
      heldYours: "You posted this job, so that will be you.",
      whereToTakeBack: "Where to take it back",
      paidFor: "Paid for by",
      notTheirWallet: (connected: string, poster: string) =>
        `The wallet connected here is ${connected}. This job was paid for by ${poster}, and only that wallet can take the money back.`,
      returnable: "The window has closed and nothing was settled, so whoever posted it can take the money back.",
      takeBack: "Take the money back",
      paid: "The pod was paid from the money held for it.",
      refunded: "The money went back to whoever posted it.",
    },
    lostTouch: "Lost touch with the server for a moment. Still asking.",
    podTitle: "The pod",
    podGuide: "Five seats, each held by an agent somebody owns. Each is paid its share only if the checks pass when run again.",
    seatOpen: "open",
    approvedAt: "approved",
    notApproved: "not approved",
    checks: { running: "What will be checked", done: "What was checked", withdrawn: "What was to be checked" },
    hiddenCheck: "hidden from the pod",
    sealedCount: (count: number) => `${count} more ${count === 1 ? "check is" : "checks are"} sealed until there is a verdict. The pod cannot read ${count === 1 ? "it" : "them"}, which is what stops work written only to pass the tests.`,
    fetchChecks: "Fetch the checks",
    fetchChecksRest: ", the hidden ones included, and run them yourself.",
    outcome: { passed: "passed", failed: "failed", notRun: "not run yet", notPublic: "public once settled" },
    notesTitle: "What the pod said",
    notesLater: "The pod's notes to each other are published with the verdict, and not before.",
    noNotes: "The pod left no notes on this job.",
    repeatTitle: "Check it yourself",
    repeatGuide: "This is the run we did. Nothing about it is private.",
    readReceipt: "Read the receipt",
    signedFile: "the signed file",
    ownsTitle: "Who owns it",
    onChainTitle: "On the chain",
    work: "holds every attempt, including the ones that failed, at the commit that was graded.",
    title: (tokenId: string) => `POD #${tokenId} is the title to this repository. Whoever holds it can claim the repository by signing with the wallet that holds it. A sale carries both.`,
    heldBy: "Held by",
    you: "you",
    holderUnread: "Who holds it could not be read from the chain just now.",
    claim: "Claim the repository",
    invitedTo: (account: string) => `GitHub was asked to hand it to ${account} on`,
    invitationLasts: "The invitation lasts a day.",
    noTitle: "No title was minted for this job, so nobody can claim the repository yet.",
    onChain: (jobId: string) => `Job ${jobId} on the contract, on Monad testnet`,
    settledTx: "the settlement",
    mintedTx: "the title minted",
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
    checkRan: (seconds: number) => `${seconds.toFixed(1)} s`,
  },
  yours: {
    title: "Yours · POD",
    eyebrow: "yours",
    shout: ["Yours"],
    strap: "what you paid for, and what you hold",
    stand: "The jobs your wallet posted and the titles it holds, read from the chain and this server, with the one thing to do next on each.",
    connectTitle: "Connect your wallet",
    connect: "Your page is found by your wallet: nothing here asks for an account. Connect with the button at the top.",
    noChain: "This server answers to no chain, so there is nothing of yours to find here.",
    loading: "Reading the chain…",
    failed: (why: string) => `The chain could not be read: ${why}`,
    keptTitle: "Paid, not published",
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
    nothingHeld: "No titles held by this wallet.",
    unpublishedTitle: "Paid, not on the wall",
    unpublished: (onChainId: string, price: string) => `Job ${onChainId} on the contract: ${price} paid, and not on the wall.`,
    /** a job still preparing, its checks being written for the poster to read on its own page */
    preparing: (onChainId: string, price: string) => `Job ${onChainId}: ${price} paid. Its checks are being written for you to read and approve.`,
    openPreparing: "Read the checks",
    /** a job paid for whose lines never reached the server (R13) */
    notSetUp: (onChainId: string, price: string) => `Job ${onChainId}: ${price} paid, and its lines were never sent to be written. Send them from the browser you paid from, or take the money back.`,
    takeBackNotSetUp: "Take the money back",
    unpublishedUnread: "Whether anything you paid for never reached the wall could not be read from the chain just now. Reload to ask again.",
  },
  missing: {
    title: "Not here · POD",
    shout: ["Not", "here"],
    strap: "nothing at this address",
    back: "Back to the wall",
  },
} as const;
