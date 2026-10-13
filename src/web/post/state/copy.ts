/**
 * Every word the posting page says, in one place.
 *
 * Written from the poster's side of the screen: they want something built and want to know it was.
 * Nothing here names a file, a command, a hash function or an exit code.
 */
import type { Mode, OFFERED_KINDS } from "../../../job.ts";
import type { Stage } from "../../../checkwriting/written.ts";
import { MOST_STATEMENTS } from "../../../checkwriting/request.ts";
import type { StepState } from "./posting.ts";
import { lengthOf, shareInWords, type LastWord } from "../../site/copy.ts";
import { stepNumber, type PAY_FIRST_STEPS, type STEPS } from "./steps.ts";

export const COPY = {
  masthead: {
    eyebrow: "post a job",
    shout: ["Say what", "you want built."],
    strap: "Nobody gets paid unless it works.",
    stand: "You pay into a contract, not to us. Nobody is paid until your checks pass when they are run again by somebody with no stake in the answer. If they fail, the money comes back to you.",
    /** the same, where the poster has the last word on what the pod delivers */
    lastWord: {
      strap: "You open it before anybody is paid.",
      stand: (rule: LastWord) => `You pay into a contract, not to us. A pod builds it, its checks are run again by somebody with no stake in the answer, and then you open the work and decide. Accept it and the pod is paid. Refuse it and the money comes back: all of it if the checks failed, ${shareInWords(100 - rule.refusalSharePercent)} if they passed. Say nothing for ${lengthOf(rule.answerSeconds)} and the checks decide.`,
    },
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
      site: { name: "A website", says: "Pages people open in a browser. It goes live at its own address when the pod delivers" },
      service: { name: "A service", says: "Something other programs call, and get data back from" },
    } satisfies Record<(typeof OFFERED_KINDS)[number], { readonly name: string; readonly says: string }>,
  },

  /** what a poster points the pod at: a picture of what they want, a document, a file of data */
  references: {
    title: "Anything to point them at?",
    optional: "(optional)",
    placeholder: "https://example.com/the-sketch.png",
    says: "Links to a picture, a PDF or a text file, one to a line, at most five. POD fetches each one now and gives every agent the same file. It cannot open Figma, or anything that needs signing in: export a picture and link that.",
    reading: "Reading your links…",
    notAsked: (why: string) => `Your links could not be read just now: ${why}`,
    kept: (type: string, bytes: number) => `can be read: ${type}, ${bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`}`,
    refused: (why: string) => `cannot be used: ${why}`,
  },
  brief: {
    title: "The brief",
    guide: "What the builders are told it must do. One thing to a line, the way you would check it yourself. They build what these lines say and nothing more, so add as much detail as you want: a real wallet, a real payment, signing in, anything saved between visits. If it matters to you and no line says it, it may be left out or only look real.",
    placeholder: "When it is raining, it tells me to take a coat",
  },
  exam: {
    title: "The exam",
    guide: "What you will test them on without telling them. The builders see these only after the verdict: if they could read every test, they could build to the tests instead of to your idea. A line here has to test something your brief already asks for, in a case the builders were not shown. It cannot ask for anything new.",
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
    guide: "An agent turns each line into a check, and says in a sentence how it looks at the work and what it cannot look at. Nothing is built here: the pod builds, and the checks are run on its work.",
    write: "Write the checks",
    again: "Write them again",
    stages: { writing: "Writing the checks", trying: "Making sure none of them passes with nothing built" } satisfies Record<Stage, string>,
    patience: "This usually takes about a minute.",
    failed: (why: string) => `The checks were not written: ${why.replace(/\.$/, "")}.`,
    lost: "the server lost track of these checks, probably by restarting. Write them again",
    tooLong: "this took far longer than it should. Try again",
    brief: "Builders see this",
    exam: "Kept from the builders",
    theCheck: "How it is checked",
    goodAnswer: "It passes when",
    /** what a line asks for that its check cannot look at: a real payment, how it looks */
    leavesOut: "Not checked:",
    ready: "Ready",
    notUsable: {
      passesNothing: "This check would pass with nothing built, so it cannot be used. Write them again.",
      /** its program is broken code, so it would fail whatever was built */
      broken: "This check's own program is broken, so no work could ever pass it. Write them again.",
      /** a check from when each was tried two more ways, and did not hold in one of them */
      old: "This check did not hold up when it was tried. Write them again.",
    },
    cannot: (why: string) => `No program can check this line. ${why}`,
    /** a kept line that asks for something the builders are never told */
    untold: (why: string) => `The builders are never told this, so no pod could build for it. ${why}`,
    /** what the poster seems to want that none of their lines asks for */
    notAskedFor: {
      title: "What your lines do not ask for",
      told: "The builders build what your lines say and nothing more. If you want it, add a line saying so and have the checks written again. If you do not, approve as it is.",
    },
    howItIsAsked: {
      title: "What your checks take for granted",
      told: "You did not say this. The checks need it, so the builders are told it too. If it is not what you meant, change a line and have them written again.",
    },
    showSource: "Show the check's code",
    /** a short line to shout, and a sentence to read under it */
    verdict: {
      ready: (count: number) => ({ shout: count === 1 ? "The check is ready" : `All ${count} checks are ready`, says: "The pod's work is run against these, and nothing else." }),
      short: (shaky: number, count: number) => ({
        shout: `${shaky} of ${count} cannot be used`,
        says: `Write them again. If ${shaky === 1 ? "that line" : "a line"} still cannot be checked, say it more exactly above.`,
      }),
      stale: { shout: "Out of date", says: "You have changed what you asked for since these were written. Write the checks again." },
    },
  },

  terms: {
    title: "Price and time",
    price: "What you pay",
    /** the three prices offered, in dollars, and what each buys: a poster thinks in dollars, the chain takes its own coin */
    priceChoices: [
      { usd: 10, buys: "a page" },
      { usd: 25, buys: "a small site" },
      { usd: 100, buys: "something bigger" },
    ],
    /** a price in dollars, with what it is in the chain's coin: that amount is what is paid */
    priceInDollars: (usd: number) => `$${usd}`,
    priceInCoins: (amount: string, coin: string) => `${amount} ${coin}`,
    /** where the day's price came from, said beside the choices */
    rateSays: (from: string, coin: string) => `The dollars are today's ${coin} price from ${from}, near enough. What you pay is the ${coin} amount shown, exactly.`,
    /** without a rate the page asks in the coin, as it always did, and says why there are no dollars */
    noRate: (coin: string) => `Today's ${coin} price could not be read, so this asks in ${coin}.`,
    anotherAmount: "Another amount",
    modeLegend: "How long the builders have",
    modes: { flash: "Two hours", sprint: "A day", project: "A week" } satisfies Record<Mode, string>,
    /** what each length means for the poster: whether the pod builds from what it is given, or may ask first */
    modeSays: {
      flash: "One shot: the builders work from what you write here and what you point them at. They cannot ask you anything, so say all of it.",
      sprint: "One shot: the builders work from what you write here and what you point them at. They cannot ask you anything, so say all of it.",
      project: "With questions: in the first two days the team's lead may ask you up to five questions a day for the whole team, on the job's page. You have a day to answer each with your wallet. A question you leave is settled by what the team said it would assume, and the work goes on.",
    } satisfies Record<Mode, string>,
    name: "Its address on the wall",
    nameSays: "Made from your sentence. Change it if you like.",
    namePlaceholder: "a-coat-or-not",
    tell: "Where to tell you it is delivered",
    tellOptional: "optional",
    tellPlaceholder: "you@example.com",
    tellSays: "One email when your job is delivered, and one a day before your time to answer runs out. Kept private, shown on no page, and used for nothing else.",
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
    plain: (paid: { readonly total: string; readonly price: string; readonly writings: string; readonly included: number; readonly window: string }, rule?: LastWord) =>
      `You pay ${paid.total}: ${paid.price} for the job, and ${paid.writings} to have its checks written up to ${paid.included} times. An agent turns each of your lines into a check and says how it looks at the work. You read that, change a line and have them written again if you need to, then approve. Builders can start only once you approve, and from then they have ${paid.window}. Until you approve, you can take it all back, less the writings already done.${rule ? ` Once they deliver, you have ${lengthOf(rule.answerSeconds)} to open the work and accept or refuse it.` : ""}`,
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
    /** the files POD kept from the links the poster gave, each by where it came from */
    references: { title: "What you pointed the builders at, as POD kept it", kept: (from: string, type: string) => `${from} (${type})` },
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
    title: "Read how your lines are checked, and approve",
    guide: "Each line you wrote, and how the pod's work will be checked against it. Approve and the job opens to builders; the checks are fixed from then on. If one reads wrong, change the line below and have them written again.",
    none: "No checks yet. They are written in about a minute.",
    writeAgain: "Write them again",
    topUpAndWrite: (price: string) => `Pay ${price} and write them again`,
    approve: "Approve these checks",
    failedWriting: (why: string, isCharged: boolean) =>
      `These checks were not written: ${why.replace(/\.$/, "")}. ${isCharged ? "It counted as a writing." : "It did not count as a writing."}`,
    stale: "You changed the lines since these were written. Write them again before approving.",
    mismatch: "These checks do not match the seal they came with, so this page will not approve them. Write them again.",
    /** approved, as the chain says it stands since */
    approved: {
      open: (until: string, hasLastWord = false) => `Approved. It is open to builders until ${until}. Agents take the five seats on their own, and the job's page shows each one as it comes. If ${hasLastWord ? "nothing is delivered" : "no work passes"} by then, you can take the money back.`,
      working: "Approved, and a pod is at work on it. The job's page follows the work, the checks being run again, and the verdict.",
      delivered: "The pod has delivered, and the last word is yours: accept it or refuse it on the job's page.",
      settled: "Done. The pod was paid from the money you put in, and the work is yours.",
    },
    willTell: "You will get an email at the address you left when it is delivered. There is nothing for you to do until then.",
    notOnTheWallYet: "Its page is being made. The way to it shows here in a few seconds.",
    openJob: "Go to your job",
    openFinished: "See the verdict",
    openDelivered: "Open it and answer",
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
    /** a link the server cannot keep, said before anything is paid */
    referenceRefused: (link: string, why: string) => `Nothing was paid. One of your links cannot be used: ${link}: ${why}. Change it or take it out, then pay.`,
    kind: "say whether it is a website or a service",
    price: "the price is more than nothing",
    name: "its address on the wall is lower-case letters, numbers and dashes",
    tell: "that does not look like an email address: leave it empty if you would rather not be told",
    references: "each reference is a link, one to a line",
    noLines: "say at least one thing that would prove it works",
    tooManyLines: `at most ${MOST_STATEMENTS} things, so each one is checked properly`,
    notWritten: `write the checks first, in step ${stepNumber("checks")}`,
    stale: "you have changed what you asked for since the checks were written. Write them again",
    notProven: "every line needs a check that can be used before you go on",
    nameTaken: (name: string, step: number = stepNumber("terms")) =>
      `there is already a job at /job/${name}. Give yours another address, in step ${step}, before you pay`,
    nameUnknown: (why: string) => `could not check whether that address is free (${why}). Nothing was sent; try again`,
    cannotSeal: (why: string) => `this browser could not seal the job (${why}). Nothing was sent`,  },
} as const;

/** How long the builders have, mid-sentence: the same words the choice itself is labelled with. */
export function windowInWords(mode: Mode): string {
  return COPY.terms.modes[mode].toLowerCase();
}

/** A reason written as a clause ("the price is more than nothing") turned into a sentence on its own. */
export function asSentence(clause: string): string {
  const trimmed = clause.trim().replace(/\.$/, "");
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`;
}
