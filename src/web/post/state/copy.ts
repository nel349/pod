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
import { stepNumber, type StepName } from "./steps.ts";

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
  } satisfies Record<StepName | "done", string>,
  stamp: "Sealed",
  sealLabel: (placed: number, of: number) => `The seal: ${placed} of ${of} pieces in place`,
  closed: "Posting is not open on this server: it has no contract to post to.",
  broken: (why: string) => `This page stopped working: ${why.replace(/\.$/, "")}. Nothing has been sent. Reload the page to start again.`,
  loading: "Opening the market…",

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
  },

  pay: {
    title: "Pay and post",
    plain: (price: string, window: string) =>
      `You pay ${price} into the contract, and the builders have ${window}. If every check passes, they are paid and you get a POD: title to the repository the work is in. If any check fails, the ${price} comes back to you. If nobody finishes in time, you can take it back from the contract once the time is up.`,
    connect: "Connect a wallet",
    payAndPost: (price: string) => `Pay ${price} and post`,
    finish: "Sign and publish",
    posted: "Posted",
    noWallet: "There is no wallet in this browser. Install one, such as MetaMask or Rabby, and come back. Nothing has been sent.",
    done: "Posted.",
    openJob: "Open the job",
    held: "The money is held by the contract until the checks decide.",
    failedBeforePublish: "No money left your wallet.",
    failedAfterPaying:
      "Your payment is held by the contract, not lost. Press Sign and publish to finish: you will not be charged again. If the job is never published, the money can be taken back from the contract after its deadline.",
    /** where a paid-for job stands, once the payment exists */
    paidAs: (onChainId: string | undefined, hash: string) =>
      onChainId === undefined ? `Payment sent: ${hash}` : `Paid: job ${onChainId} on the contract`,
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

  problems: {
    kind: "say whether it is a page or a service",
    price: "the price is more than nothing",
    name: "its address on the wall is lower-case letters, numbers and dashes",
    noLines: "say at least one thing that would prove it works",
    tooManyLines: `at most ${MOST_STATEMENTS} things, so each one is checked properly`,
    notWritten: `write the checks first, in step ${stepNumber("checks")}`,
    stale: "you have changed what you asked for since the checks were written. Write them again",
    notProven: "every check has to pass its three trials before you can pay for it",
    nameTaken: (name: string) =>
      `there is already a job at /job/${name}. Give yours another address, in step ${stepNumber("terms")}, before you pay`,
    nameUnknown: (why: string) => `could not check whether that address is free (${why}). Nothing was sent; try again`,
    cannotSeal: (why: string) => `this browser could not seal the job (${why}). Nothing was sent`,  },
} as const;

/** A clause the writer phrased as its own sentence, fitted into ours: "It never…" becomes "it never…". */
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
