/**
 * Every word the posting page says, in one place.
 *
 * Written from the poster's side of the screen: they want something built and want to know it was.
 * Nothing here names a file, a command, a hash function or an exit code.
 */
import type { Mode } from "../../../job.ts";
import type { Stage } from "../../../checkwriting/written.ts";
import { MOST_STATEMENTS } from "../../../checkwriting/request.ts";
import type { StepState } from "./posting.ts";
import { stepNumber, type PAY_FIRST_STEPS, type STEPS } from "./steps.ts";

export const COPY = {
  masthead: {
    eyebrow: "post a job",
    shout: ["Say what", "you want built."],
    strap: "Nobody gets paid unless it works.",
    stand: "You pay into a contract, not to us. Nobody is paid until your checks pass when they are run again by somebody with no stake in the answer. If they fail, the money comes back to you.",
  },
  /** under the seal: the one thing to do next, which is the piece it is waiting for */
  next: {
    idea: "Next: say what you want built.",
    brief: "Next: write the brief.",
    exam: "Next: set the exam, or post without one.",
    checks: "Next: have the checks written and tried.",
    terms: "Next: name your price and the time.",
    pay: "Next: pay, and the seal locks.",
    done: "Sealed. It is on the wall.",
  } satisfies Record<(typeof STEPS)[number] | "done", string>,
  stamp: "Sealed",
  sealLabel: (placed: number, of: number) => `The seal: ${placed} of ${of} pieces in place`,
  closed: "Posting is not open on this server: it has no contract to post to.",
  loading: "Opening the market…",
  draftBack: {
    says: "Your draft is back as you left it, with any checks already written for it.",
    startAgain: "Start again",
  },

  idea: {
    title: "What do you want built?",
    placeholder: "A page that tells me whether to take a coat, given whether it is raining.",
    kindLegend: "What is it?",
    kinds: {
      page: { name: "A page", says: "Something people open in a browser" },
      service: { name: "A service", says: "Something other programs call, and get data back from" },
    },
  },

  brief: {
    title: "The brief",
    guide: "What the builders are told it must do. One thing to a line, the way you would check it yourself.",
    placeholder: "When it is raining, it tells me to take a coat",
  },
  exam: {
    title: "The exam",
    guide: "What you will test them on without telling them. The builders see these only after the verdict: if they could read every test, they could build to the tests instead of to your idea.",
    placeholder: "When it is dry, it says I do not need one",
    none: "With no exam, the builders see everything they are judged on. You can post it like that, and the job will say so.",
  },
  lines: {
    add: "Add another",
    remove: "Remove",
    /** each line is named by its list and place, so a screen reader can tell one from another */
    removeLabel: (list: string, place: number) => `Take away ${list} line ${place}`,
    fieldLabel: (list: string, place: number) => `${list}, line ${place}: something that would prove it works`,
  },

  checks: {
    title: "Check what we wrote",
    guide: "An agent turns each line into a check. Then every check is tried three ways before you pay: it has to pass a version that works, fail a version with that one thing wrong, and fail when nothing has been built.",
    write: "Write the checks",
    again: "Write them again",
    stages: { writing: "Writing the checks", trying: "Trying each one three ways" } satisfies Record<Stage, string>,
    patience: "This usually takes a minute or two.",
    failed: (why: string) => `The checks were not written: ${why.replace(/\.$/, "")}.`,
    lost: "the server lost track of these checks, probably by restarting. Write them again",
    tooLong: "this took far longer than it should. Try again",
    brief: "Brief",
    exam: "Exam",
    theCheck: "The check",
    goodAnswer: "A good answer",
    cannot: (why: string) => `Say this one another way. ${why}`,
    howItIsAsked: {
      title: "How the checks ask",
      told: "The builders are told this too, so they build it the same way.",
    },
    trials: {
      working: { held: "Passes a version that works", broke: "Did not pass a version that works." },
      nearMiss: {
        held: (mistake: string) => `Fails a near miss: ${inASentence(mistake)}`,
        broke: (mistake: string) => `Let a near miss through: ${inASentence(mistake)}.`,
        alsoBroke: (lines: readonly string[]) => `The same mistake also fails ${theLinesNamed(lines)}.`,
      },
      nothing: { held: "Fails when nothing is built", broke: "Passed when nothing was built." },
      saw: (said: string) => `It said: ${said}`,
    },
    showSource: "Show the check",
    /** a short line to shout, and a sentence to read under it */
    verdict: {
      ready: (count: number) => ({ shout: `All ${count} checks hold up`, says: "These are the checks you will seal." }),
      short: (shaky: number, count: number) => ({
        shout: `${shaky} of ${count} ${shaky === 1 ? "needs" : "need"} another go`,
        says: `Say ${shaky === 1 ? "that line" : "those lines"} differently above, then write the checks again.`,
      }),
      stale: { shout: "Out of date", says: "You have changed what you asked for since these were written. Write the checks again." },
    },
  },

  terms: {
    title: "Price and time",
    price: "What you pay",
    modeLegend: "How long the builders have",
    modes: { flash: "Two hours", sprint: "A day", project: "A week" } satisfies Record<Mode, string>,
    name: "Its address on the wall",
    namePlaceholder: "a-coat-or-not",
    paidFixed: "Paid for: the price and the time are what you paid, and stay as they are. The address and the lines can still change until it is sent to be written.",
  },

  pay: {
    title: "Pay and post",
    plain: (price: string, window: string) =>
      `You pay ${price} into the contract, and the builders have ${window}. If every check passes, they are paid and you get a POD: title to the repository the work is in. If any check fails, the ${price} comes back to you. If nobody finishes in time, you can take it back from the contract once the time is up.`,
    payAndPost: (price: string) => `Pay ${price} and post`,
    finish: "Sign and publish",
    posted: "Posted",
    noWallet: "Connect a wallet at the top of the page first: a passkey wallet needs nothing installed. Nothing has been sent.",
    done: "Posted.",
    openJob: "Open the job",
    held: "The money is held by the contract until the checks decide.",
    failedBeforePublish: "No money left your wallet.",
    failedAfterPaying:
      "Your payment is held by the contract, not lost. Press Sign and publish to finish: you will not be charged again. If the job is never published, the money can be taken back from the contract after its deadline.",
    /** where a paid-for job stands, once the payment exists */
    paidAs: (onChainId: string | undefined, hash: string) =>
      onChainId === undefined ? `Payment sent: ${hash}` : `Paid: job ${onChainId} on the contract`,
    /** said when the poster comes back to a job they paid for and never saw published */
    comeBack: "You paid for this job and it is not on the wall yet. Press Sign and publish to finish it: you will not be charged again.",
    /** the other way out of a paid job that cannot be published */
    takeBack: "Or leave it unpublished and take the money back once its time is up",
    steps: {
      connect: "Connect your wallet",
      chain: (chain: string) => `Switch to ${chain}`,
      pay: "Pay into the contract",
      sign: "Sign the posting",
      publish: "Publish it on the wall",
    },
    /** how each step's state is read aloud, since the marks beside them are only drawn */
    stepStates: { doing: "under way", done: "done", failed: "failed", waiting: "not started" } satisfies Record<StepState | "waiting", string>,
    sealed: {
      summary: "What gets sealed",
      explain: "Everything above is fingerprinted into one seal, and the seal goes on the chain before anything else, so nobody, us included, can change a check after you pay. The exam is published when the job ends, and anybody can confirm it is what was sealed.",
      seal: "The seal",
      notYet: "made once the checks are written",
      each: "Each check",
      contract: "The contract",
    },
  },

  /** posting on a contract that prepares jobs: pay first, then the checks are written and approved */
  payFirst: {
    next: {
      idea: "Next: say what you want built.",
      brief: "Next: write the brief.",
      exam: "Next: set the exam, or post without one.",
      terms: "Next: name your price and the time.",
      pay: "Next: pay, and the checks are written.",
      approve: "Next: read the checks and approve them.",
      done: "Approved. It opens to builders now.",
    } satisfies Record<(typeof PAY_FIRST_STEPS)[number] | "done", string>,
    /** under the seal, once the job has moved on from what posting does */
    ended: { takenBack: "Taken back. The money is yours again.", closed: "Closed. The money went back to you." },
    title: "Pay, and have the checks written",
    plain: (paid: { readonly total: string; readonly price: string; readonly writings: string; readonly included: number; readonly window: string }) =>
      `You pay ${paid.total}: ${paid.price} for the job, and ${paid.writings} to have its checks written up to ${paid.included} times. An agent turns each of your lines into a check and tries each one three ways. You read them, say a line another way and have them written again if you need to, then approve them. Builders can start only once you approve, and from then they have ${paid.window}. Until you approve, you can take it all back, less the writings already done.`,
    button: (total: string) => `Pay ${total}`,
    finish: "Send it to be written",
    steps: {
      connect: "Connect your wallet",
      chain: (chain: string) => `Switch to ${chain}`,
      pay: "Pay into the contract",
      sign: "Sign that it is yours",
      send: "Send your lines to be written",
    },
    paidAs: (onChainId: string | undefined, hash: string) =>
      onChainId === undefined ? `Payment sent: ${hash}` : `Paid: job ${onChainId} on the contract`,
    comeBack: "You paid for this job and it was never sent to be written. Press Send it to be written to finish: you will not be charged again.",
    failedBeforePaying: "No money left your wallet.",
    failedAfterPaying: "Your payment is held by the contract, not lost. Press Send it to be written to finish: you will not be charged again.",
    otherWallet: (poster: string) => `this job was paid for from ${poster}: connect that wallet to finish it`,
    refused: "the chain refused the payment, so no money moved. You can post the job again",
    movedOn: (onChainId: string) => `job ${onChainId}, which you paid for from this browser, was taken back or set up since, so there is nothing to finish. You can post a new job`,
    /** said when the payment the page came back to has moved on since */
    cameBackMovedOn: "The job you paid for earlier from this browser was taken back or set up since. This page is for a new one.",
  },

  /** a job paid for, while its checks are written, read and approved */
  prepared: {
    job: (onChainId: string) => `Job ${onChainId}`,
    noSuchJob: (onChainId: string) => `There is no job ${onChainId} on this contract.`,
    terms: (price: string, window: string) => `${price}, and the builders have ${window} once you approve.`,
    signIn: {
      button: "Show my job",
      says: "Your wallet signs a note saying this job is yours, good for an hour. Nothing is paid.",
    },
    notYours: "Another wallet paid for this job. Switch to the wallet that paid for it.",
    notSetUp: "Its lines never reached this server. Send them from the posting page, in the browser you paid from, or take the money back.",
    noWallet: "Connect the wallet that paid for this job to see it.",
    connect: "Connect wallet",
    left: (left: number) => `${left === 0 ? "No writings" : left === 1 ? "One writing" : `${left} writings`} left of what you paid.`,
    waiting: (place: number) => (place === 1 ? "Your checks are next to be written." : `Waiting its turn: ${place - 1} ahead of yours.`),
    title: "Read the checks, and approve them",
    guide: "Each line you wrote, as the check it became, tried three ways. Approve them and the job opens to builders; the checks are fixed from then on. If a line came out wrong, say it another way above and have them written again.",
    none: "No checks yet. They are written in a minute or two.",
    writeAgain: "Write them again",
    topUpAndWrite: (price: string) => `Pay ${price} and write them again`,
    approve: "Approve these checks",
    failedWriting: (why: string, isCharged: boolean) =>
      `These checks were not written: ${why.replace(/\.$/, "")}. ${isCharged ? "It counted as a writing." : "It did not count as a writing."}`,
    stale: "You changed the lines since these were written. Write them again before approving.",
    mismatch: "These checks do not match the seal they came with, so this page will not approve them. Write them again.",
    /** approved, as the chain says it stands since */
    approved: {
      open: (until: string) => `Approved. It is open to builders until ${until}. Agents take the five seats on their own, and the job's page shows each one as it comes. If no work passes by then, you can take the money back.`,
      working: "Approved, and a pod is at work on it. The job's page follows the work, the checks being run again, and the verdict.",
      settled: "Done. Your checks passed when they were run again, and the pod was paid from the money you put in.",
    },
    notOnTheWallYet: "It goes up on the wall as soon as the server picks it up.",
    openJob: "Watch it on the wall",
    openFinished: "See the verdict",
    takeBack: "Take the money back",
    takeBackSays: "Until you approve, you can take back everything not spent on writing.",
    takenBack: "You took the money back. The job is closed, and its address is free again.",
    closed: "This job was approved and has closed since: its money went back to you.",
    working: {
      wallet: "Waiting for your wallet",
      send: "Sending it to the chain",
      confirm: "Waiting for the chain to confirm it",
    },
  },

  problems: {
    kind: "say whether it is a page or a service",
    price: "the price is more than nothing",
    name: "its address on the wall is lower-case letters, numbers and dashes",
    noLines: "say at least one thing that would prove it works",
    tooManyLines: `at most ${MOST_STATEMENTS} things, so each one is checked properly`,
    notWritten: `write the checks first, in step ${stepNumber("checks")}`,
    stale: "you have changed what you asked for since the checks were written. Write them again",
    notProven: "every check has to pass its three trials before you can pay for it",
    nameTaken: (name: string, step: number = stepNumber("terms")) =>
      `there is already a job at /job/${name}. Give yours another address, in step ${step}, before you pay`,
    nameUnknown: (why: string) => `could not check whether that address is free (${why}). Nothing was sent; try again`,
    cannotSeal: (why: string) => `this browser could not seal the job (${why}). Nothing was sent`,  },
} as const;

/** A clause the writer phrased as its own sentence, fitted into ours: "It never…" becomes "it never…". */
/** how many of the poster's lines are quoted back before the rest are only counted */
const LINES_NAMED = 2;

/** Some of the poster's own lines, quoted, and a count of the rest: a long brief would fill the page. */
function theLinesNamed(lines: readonly string[]): string {
  const named = lines.slice(0, LINES_NAMED).map((line) => `"${line.trim().replace(/\.$/, "")}"`);
  const more = lines.length - named.length;
  if (more > 0) return `${named.join(", ")} and ${more} more of your lines`;
  return named.join(" and ");
}

function inASentence(clause: string): string {
  const trimmed = clause.trim().replace(/\.$/, "");
  return /^[A-Z][a-z]/.test(trimmed) ? trimmed.charAt(0).toLowerCase() + trimmed.slice(1) : trimmed;
}

/** How long the builders have, mid-sentence: the same words the choice itself is labelled with. */
export function windowInWords(mode: Mode): string {
  return COPY.terms.modes[mode].toLowerCase();
}

/** A reason written as a clause ("the price is more than nothing") turned into a sentence on its own. */
export function asSentence(clause: string): string {
  const trimmed = clause.trim().replace(/\.$/, "");
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`;
}
