import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import type { Tile } from "../gallery.ts";
import { publicRecord, type JobRecord } from "../store.ts";
import { recordByRole } from "../agentpage.ts";
import { claimPath, jobPath, preparingPagePath, receiptFilePath, receiptPath, refundByNumberPath, refundPath, ROUTES } from "../routes.ts";
import { DEPOSIT_PERCENT, SHARES, type Role } from "../job.ts";
import {
  jobView, moneyAt, needsTheChainForMoney, receiptView, renderSite, seatsOfYours, tileView, unpublishedView, type AgentFactsView, type AgentRecordView, type SiteData, type SitePage,
} from "../web/site/index.ts";
import { freeSeatsOf } from "../web/site/pages/job/SendAnAgent.tsx";
import { SEATS } from "../seal.ts";
import { agentAnsweredWords, agentRecordWords, lengthOf, posterRecordWords, SITE, timeLeft, whenInUTC, whereTheDeliveryStands, whereTheReviewStands, whoStandsBehindIt } from "../web/site/copy.ts";
import { CONNECTOR_INSTALL, MANDATE_STEPS, SKILL_INSTALL, WALLET_ADDRESS } from "../mandate.ts";
import type { SignedReceipt } from "../receipt.ts";

const LEAD: Address = "0x00000000000000000000000000000000000000a1";
const BUILDER: Address = "0x00000000000000000000000000000000000000a2";
const POSTER = "0x00000000000000000000000000000000000000b9";
const NOW = new Date("2026-10-01T12:00:00.000Z");

const tile = (over: Partial<Tile> = {}): Tile => ({
  jobId: "excuses",
  idea: "a site that rates my excuses",
  mode: "flash",
  verdict: "passed",
  commit: "c0ffee1234",
  seconds: 2,
  price: 20_000_000_000_000_000_000n,
  pod: [
    { role: "lead", agent: LEAD, owner: LEAD },
    { role: "builder", agent: BUILDER, owner: BUILDER },
  ],
  receiptURI: "/receipt/excuses",
  finishedAt: "2026-10-01T11:37:00.000Z",
  ...over,
});

const signed: SignedReceipt = {
  receipt: {
    version: "pod.receipt.v1", seal: `0x${"ab".repeat(32)}`, commit: "c0ffee1234abcdef0123456789abcdef01234567",
    repository: "https://github.com/proof-of-development/pod-excuses", tree: `0x${"cd".repeat(32)}`,
    image: "node@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944", start: "node server.js",
    checks: [{ says: "the page answers", command: "node check-1.mjs", exitCode: 0, seconds: 0.4, hidden: false }],
    runs: 3, verdict: "passed", allowedHosts: [], undeclaredCalls: [], runner: "0x00000000000000000000000000000000000000cc",
    finishedAt: "2026-10-01T11:37:00.000Z",
  },
  hash: `0x${"ef".repeat(32)}`,
  signature: `0x${"12".repeat(65)}`,
};

const record = (over: Partial<JobRecord> = {}): JobRecord => {
  const base = tile(over.tile);
  return {
    jobId: base.jobId,
    seal: `0x${"ab".repeat(32)}`,
    tile: base,
    checksSaid: [
      { says: "the page answers", hidden: false, exitCode: 0 },
      { says: "a weak excuse scores lower", hidden: true, exitCode: 0 },
    ],
    approvals: [{ role: "lead", agent: LEAD, commit: "c0ffee1234", at: "2026-10-01T11:30:00Z" }],
    ...over,
  };
};

const ON_CHAIN = { network: "monad-testnet", jobId: "9", jobs: "0x00000000000000000000000000000000000000c1" } as const;

const running = (over: Partial<JobRecord> = {}): JobRecord => record({
  tile: tile({ verdict: "running", receiptURI: undefined, finishedAt: undefined }),
  brief: { asked: "a site that rates my excuses", endsAt: "2026-10-02T12:00:00.000Z", sealedChecks: 1, seats: [] },
  chain: ON_CHAIN,
  ...over,
});

/** where the pages here say they were reached */
const SITE_ADDRESS = "https://pod.example";

const draw = (page: SitePage): string => {
  const data: SiteData = { ...page, coin: "MON", drawnAt: NOW.toISOString(), site: SITE_ADDRESS };
  return renderSite({ title: "a page" }, data);
};
const wall = (tiles: readonly Tile[]): string => draw({ page: "wall", tiles: tiles.map((one) => tileView(one, one.receiptURI !== undefined)) });
const job = (of: JobRecord, chainSays = {}): string => draw({ page: "job", job: jobView(of, [], chainSays) });

describe("a job on the wall never shows a reader a hole", () => {
  test("one second is not 1 seconds, and long times read in the unit that fits", () => {
    expect(lengthOf(1)).toBe("1 second");
    expect(lengthOf(2)).toBe("2 seconds");
    expect(lengthOf(60)).toBe("60 seconds");
    expect(lengthOf(3600)).toBe("60 minutes");
    expect(lengthOf(3 * 86_400)).toBe("3 days");
  });

  test("it leads with the idea, and says the verdict in words, not only a colour", () => {
    const html = wall([tile(), tile({ jobId: "b", verdict: "failed" }), tile({ jobId: "c", verdict: "not-reproducible" })]);
    expect(html).toContain("a site that rates my excuses");
    expect(html).toContain("checks passed");
    expect(html).toContain("checks failed");
    expect(html).toContain("could not be reproduced");
  });

  test("two attempts at one idea are told apart by the commit each was graded at", () => {
    const html = wall([tile({ jobId: "a", commit: "c0ffee1234" }), tile({ jobId: "b", commit: "7ae91bb000" })]);
    expect(html).toContain("c0ffee1");
    expect(html).toContain("7ae91bb");
  });

  test("a price carries the name of what it is paid in", () => {
    expect(wall([tile()])).toContain("20 MON");
  });

  test("links the readable receipt, and says when there is none yet", () => {
    expect(wall([tile()])).toContain(`href="${receiptPath("excuses")}"`);
    expect(wall([tile({ receiptURI: undefined })])).toContain(SITE.tile.noReceipt);
  });

  test("a job nobody has taken is waiting for a pod, and says how many seats are open", () => {
    const html = wall([tile({ verdict: "running", pod: [], receiptURI: undefined })]);
    expect(html).toContain("waiting for a pod");
    expect(html).toContain("5 seats still open");
    expect(html).not.toContain("held by the platform");
    expect(wall([tile({ verdict: "running" })])).toContain("being built");
  });

  test("the time shown is what it is: how long the checks ran", () => {
    expect(wall([tile({ seconds: 2 })])).toContain("checks ran in 2 seconds");
  });

  test("names every seat and links each agent to its page", () => {
    const html = wall([tile()]);
    expect(html).toContain("builder");
    expect(html).toContain(`href="/agent/${LEAD}"`);
    expect(html).toContain("0x0000…00a1");
  });

  test("offers no link to running work that nothing serves", () => {
    expect(wall([tile({ open: "https://pod.example/j/7" })])).not.toContain("open it");
  });

  test("an idea cannot smuggle markup onto the page, nor out of the data the browser reads", () => {
    const html = wall([tile({ idea: `<img src=x onerror="alert(1)"></script><script>alert(2)</script>` })]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("</script><script>alert(2)");
    expect(html).toContain("&lt;img");
  });
});

describe("the wall", () => {
  test("shows failures beside successes, and counts both", () => {
    const html = wall([tile(), tile({ jobId: "b", verdict: "failed" }), tile({ jobId: "c", verdict: "not-reproducible" })]);
    expect(html).toContain(`<b>1</b> ${SITE.wall.tally.paid}`);
    expect(html).toContain(`<b>1</b> ${SITE.wall.tally.failed}`);
    expect(html).toContain(`<b>1</b> ${SITE.wall.tally.unsure}`);
  });

  test("an empty wall is still a page, says so, and says nothing false", () => {
    const html = wall([]);
    expect(html).toContain("Nothing built yet");
    expect(html).toContain(`<b>0</b> ${SITE.wall.tally.paid}`);
    expect(html).not.toContain("undefined");
  });

  test("says where it runs and what the money is, reads on a phone, and offers to post a job", () => {
    const html = wall([tile()]);
    expect(html).toContain("test money");
    expect(html).toContain("width=device-width");
    expect(html).toContain(`href="/post"`);
  });

  test("every page carries the header, the one look, and the script that brings it to life", () => {
    const html = wall([tile()]);
    expect(html).toContain(`class="site-header"`);
    expect(html).toContain(`href="/brand.css"`);
    expect(html).toContain(`src="/assets/site.js"`);
    expect(html).toContain(`id="pod-data"`);
  });
});

describe("one job, opened", () => {
  test("shows what was checked, and marks the ones the pod never saw", () => {
    const html = job(record());
    expect(html).toContain("the page answers");
    expect(html).toContain("hidden from the pod");
    expect(html).toContain("Fetch the checks");
  });

  test("while it runs, it shows only the checks the pod may see, and counts the sealed ones", () => {
    const html = job(running());
    expect(html).toContain("the page answers");
    expect(html).not.toContain("a weak excuse scores lower");
    expect(html).toContain(SITE.job.sealedCount(1));
    expect(html).not.toContain("Fetch the checks");
  });

  test("every seat is shown with its share of the price, open or taken, and who approved", () => {
    const html = job(record());
    expect(html).toContain("4 MON");
    expect(html).toContain("8 MON");
    expect(html).toContain("approved");
    expect(html).toContain(`href="/agent/${BUILDER}"`);
    expect(job(running({ tile: tile({ verdict: "running", pod: [] }) }))).toContain(">open<");
  });

  test("a builder is never said not to have approved: it is the work the others approve", () => {
    const seat = (role: string): string => job(record()).match(new RegExp(`<li class="taken"><p class="seat-role">${role}</p>.*?</li>`))?.[0] ?? "";
    expect(seat("builder")).toContain("0x0000…00a2");
    expect(seat("builder")).not.toContain("not approved");
    expect(seat("builder")).toContain(`<p class="seat-approved"></p>`);
    expect(seat("lead")).toContain(">approved");
  });

  test("a job nobody has taken says who comes and when; one being built says how many seats are taken", () => {
    expect(job(running({ tile: tile({ verdict: "running", pod: [] }) }))).toContain("Nobody has taken a seat yet");
    expect(job(running())).toContain("2 of 5 seats taken");
  });

  test("a job with a free seat gives the line that sends an agent to it, by its own address, and offers only the seats still free", () => {
    const link = `${SITE_ADDRESS}/job/excuses`;
    expect(SITE.job.sentenceForThisJob(link)).toBe("Take a seat on https://pod.example/job/excuses, work it to the end, and tell me what it paid.");
    expect(SITE.job.sentenceForThisJob(link, "reviewer")).toBe("Take the reviewer seat on https://pod.example/job/excuses, work it to the end, and tell me what it paid.");
    // lead and builder are taken: the line is for any free seat until one is picked, and those two are not offered
    const html = job(running());
    expect(html).toContain(SITE.job.sentenceForThisJob(link));
    const offered = [...html.matchAll(/data-seat="([a-z]+)"/g)].map((found) => found[1]);
    expect(offered).toEqual(["reviewer", "qa", "security"]);
    // a pod that is full has no seat to send anybody to, and a job that is over has none either
    const full = SEATS.map((role, index) => {
      const holder: `0x${string}` = `0x${String(index + 1).padStart(40, "0")}`;
      return { role, agent: holder, owner: holder };
    });
    expect(job(running({ tile: tile({ verdict: "running", receiptURI: undefined, finishedAt: undefined, pod: full }) }))).not.toContain(SITE.job.sendYourAgent);
    expect(job(record())).not.toContain(SITE.job.sendYourAgent);
  });

  test("while it runs, the pod's notes are kept back, and said to be", () => {
    const note = { agent: LEAD, role: "lead", says: "merged the builder's work", at: 1_790_000_000, signature: `0x${"aa".repeat(65)}` } as const;
    const view = jobView(running(), [note], {});
    expect(view.notes).toEqual([]);
    expect(draw({ page: "job", job: view })).toContain("published with the verdict");
    const done = jobView(record(), [note], {});
    expect(draw({ page: "job", job: done })).toContain("merged the builder&#x27;s work");
  });

  test("shows the fingerprint the idea was sealed under, behind the words", () => {
    expect(job(record())).toContain("Sealed before it opened");
    expect(job(record())).toContain(`0x${"ab".repeat(32)}`);
  });

  test("says where the work is, who holds the title, and how to claim it", () => {
    const html = job(record({
      repository: "https://github.com/pod/job-7",
      chain: { network: "monad-testnet", jobId: "7", jobs: "0x00000000000000000000000000000000000000c1", tokenId: "4" },
    }), { holder: POSTER });
    expect(html).toContain("https://github.com/pod/job-7");
    expect(html).toContain("including the ones that failed");
    expect(html).toContain(SITE.job.title("4"));
    expect(html).toContain("0x0000…00b9");
    expect(html).toContain(`href="${claimPath("excuses")}"`);
    expect(html).toContain("Job 7 on the contract");
  });

  test("an invitation out says where it arrives, and a repository that has moved says who has it, with nothing left to claim", () => {
    const titled = {
      repository: "https://github.com/pod/job-7",
      chain: { network: "monad-testnet", jobId: "7", jobs: "0x00000000000000000000000000000000000000c1", tokenId: "4" },
      invited: { account: "octocat", by: POSTER, at: "2026-10-12T16:02:00.000Z" },
    } as const;
    const invited = job(record(titled), { holder: POSTER });
    expect(invited).toContain(SITE.job.invitedTo("octocat"));
    expect(invited).toContain(SITE.job.invitationLasts);
    expect(invited).toContain(`href="${claimPath("excuses")}"`);

    const handed = job(record({ ...titled, repository: "https://github.com/octocat/job-7", handed: { account: "octocat", at: "2026-10-12T16:03:00.000Z" } }), { holder: POSTER });
    expect(handed).toContain(SITE.job.handedTo("octocat"));
    expect(handed).toContain(SITE.job.handedSays);
    expect(handed).toContain("https://github.com/octocat/job-7");
    expect(handed).not.toContain(SITE.job.invitedTo("octocat"));
    expect(handed).toContain(SITE.job.titleHanded("4"));
    expect(handed).not.toContain(SITE.job.title("4"));
    expect(handed).not.toContain(`href="${claimPath("excuses")}"`);
  });

  test("a title whose holder the chain did not answer for says so, rather than naming nobody", () => {
    const html = job(record({ chain: { network: "monad-testnet", jobId: "7", jobs: "0x00000000000000000000000000000000000000c1", tokenId: "4" } }));
    expect(html).toContain("could not be read from the chain just now");
  });

  test("a job that passed with no title says nobody can claim it yet, and never that a title was minted", () => {
    const html = job(record({ repository: "https://github.com/pod/job-7" }));
    expect(html).toContain(SITE.job.noTitle);
    expect(html).toContain(SITE.job.next.passedUntitled);
    // and it does not say the poster owns the work, which is only true once there is a certificate of it
    expect(html).not.toContain(SITE.job.next.passed);
    // one with a title says it was minted to its poster
    expect(job(record({ chain: { network: "monad-testnet", jobId: "7", jobs: "0x00000000000000000000000000000000000000c1", tokenId: "4" } }))).toContain(SITE.job.next.passed);
  });

  test("the run to repeat names this site's copy of the code by the address the page was reached at", () => {
    const html = job(record({ signed: { ...signed, receipt: { ...signed.receipt, repository: "/bundle/excuses" } } }));
    expect(html).toContain(`${SITE_ADDRESS}/bundle/excuses`);
    expect(html).not.toContain("this site&gt;");
  });

  test("a job with a receipt shows how to repeat the run, and one without simply does not", () => {
    const html = job(record({ signed }));
    expect(html).toContain("Check it yourself");
    // the grading itself, pointed at this job by the address the page was reached at
    expect(html).toContain(`bun run src/repeat.ts ${SITE_ADDRESS}${jobPath("excuses")} ../work`);
    expect(html).toContain(`href="${receiptFilePath("excuses")}"`);
    expect(job(record())).not.toContain("Check it yourself");
  });

  test("a job the runs disagreed on says what that means for the money", () => {
    expect(job(record({ tile: tile({ verdict: "not-reproducible" }) }))).toContain("nothing was settled");
  });
});

describe("a job whose poster took the money back before any verdict", () => {
  test("its page says it is closed as soon as the chain says so, and keeps what was sealed sealed until the record does", () => {
    const view = jobView(running(), [], { onChain: { state: "refunded", endsAt: 1_790_000_000n } });
    expect(view.verdict).toBe("withdrawn");
    expect(view.money).toEqual({ kind: "refunded" });
    expect(view.checks.map((check) => check.says)).toEqual(["the page answers"]);
    expect(view.sealedChecks).toBe(1);
    const html = draw({ page: "job", job: view });
    expect(html).toContain(SITE.job.next.withdrawn);
    expect(html).toContain("What was to be checked");
    expect(html).not.toContain("Fetch the checks");
  });

  test("once written down, it is closed on the wall too and counted apart, and nothing hidden is published: nothing was judged", () => {
    const closed = record({ tile: tile({ verdict: "withdrawn", receiptURI: undefined }), chain: ON_CHAIN });
    expect(wall([closed.tile])).toContain(`<b>1</b> ${SITE.wall.tally.withdrawn}`);
    const view = jobView(closed, [], {});
    expect(view.standing).toBe("withdrawn, the money taken back");
    expect(view.checks.map((check) => check.says)).toEqual(["the page answers"]);
    expect(draw({ page: "job", job: view })).not.toContain("Fetch the checks");
  });
});

describe("where the money is", () => {
  test("held until the window closes, then the poster's to take back", () => {
    const view = jobView(running(), [], {});
    expect(view.money).toEqual({ kind: "held", endsAt: "2026-10-02T12:00:00.000Z", takeBack: refundPath("excuses") });
    if (!view.money) throw new Error("a running job on the chain has money on its page");
    expect(moneyAt(view.money, new Date("2026-10-02T12:00:01.000Z"))).toEqual({ kind: "returnable", takeBack: refundPath("excuses") });
    expect(job(running())).toContain("held by the contract until");
  });

  test("a job past its window, or the runs disagreed on, is asked of the chain; one the record settles is not", () => {
    expect(needsTheChainForMoney(running(), NOW)).toBe(false);
    expect(needsTheChainForMoney(running(), new Date("2026-10-03T00:00:00.000Z"))).toBe(true);
    expect(needsTheChainForMoney(record({ tile: tile({ verdict: "not-reproducible" }), chain: ON_CHAIN }), NOW)).toBe(true);
    expect(needsTheChainForMoney(record({ chain: { ...ON_CHAIN, settled: "0x01" } }), NOW)).toBe(false);
  });

  test("money the poster already took back is said to be back, whatever the record says", () => {
    const view = jobView(running(), [], { onChain: { state: "refunded", endsAt: 1_790_000_000n } });
    expect(view.money).toEqual({ kind: "refunded" });
  });

  test("paid when the checks passed; back with the poster when they failed", () => {
    const chain = ON_CHAIN;
    expect(jobView(record({ chain }), [], {}).money).toEqual({ kind: "paid" });
    expect(jobView(record({ chain, tile: tile({ verdict: "failed" }) }), [], {}).money).toEqual({ kind: "refunded" });
  });

  test("a time is said the same way wherever it is drawn, whatever the date library there says", () => {
    expect(whenInUTC("2026-09-26T06:08:00.000Z")).toBe("26 Sep 2026, 06:08 UTC");
    expect(whenInUTC("not a time")).toBe("not a time");
  });

  test("how long is left is said in words", () => {
    expect(timeLeft("2026-10-01T15:00:00.000Z", NOW)).toBe("3 hours left");
    expect(timeLeft("2026-10-01T11:00:00.000Z", NOW)).toBe("closed");
  });
});

/** A sentence as it is in a page's markup, where an apostrophe is written out in code. */
const inMarkup = (sentence: string): string => sentence.replaceAll("'", "&#x27;");

describe("a job delivered to a poster who has the last word", () => {
  const ANSWER_BY = "2026-10-04T12:00:00.000Z";
  const failedReceipt: SignedReceipt = { ...signed, receipt: { ...signed.receipt, verdict: "failed" } };
  /** a pod of five, the lead and the builder the ones every test here knows */
  const FULL_POD = SEATS.map((role, index) => {
    const agent: Address = role === "lead" ? LEAD : role === "builder" ? BUILDER : `0x${String(index + 1).padStart(40, "0")}`;
    return { role, agent, owner: agent };
  });
  /**
   * A job as the worker leaves it at delivery: a full pod seated, and written down from the contract
   * who stands behind the work, which is every seat unless told otherwise. Its builder always does,
   * having put it forward.
   */
  const delivered = (over: Partial<NonNullable<JobRecord["chain"]>> = {}, passed = true, behind: readonly Role[] = SEATS): JobRecord => record({
    tile: tile({ verdict: passed ? "passed" : "failed", pod: FULL_POD }),
    approvals: FULL_POD.filter((seat) => behind.includes(seat.role)).map((seat) => ({ role: seat.role, agent: seat.agent, commit: signed.receipt.commit, at: "2026-10-01T11:30:00.000Z" })),
    signed: passed ? signed : failedReceipt,
    chain: { ...ON_CHAIN, reported: "0xa1", answerBy: ANSWER_BY, ...over },
    poster: POSTER,
  });
  const answered = (how: "accepted" | "refused" | "unanswered", passed = true, keptByThePod?: string): JobRecord =>
    delivered({ answer: { how, at: "2026-10-02T09:00:00.000Z", hash: "0xb2", ...(keptByThePod === undefined ? {} : { keptByThePod }) } }, passed);
  const tileOf = (of: JobRecord) => jobView(of, [], {});
  /** a quarter of each seat's share of 20 coins, added up as the contract does, seat by seat */
  const A_QUARTER = "5000000000000000000";

  test("while it waits for its poster, nobody is said to be paid: it is delivered, and the money is held for their answer", () => {
    const view = jobView(delivered(), [], { poster: POSTER });
    expect(view.answer).toBe("awaited");
    expect(view.standing).toBe("delivered, waiting for its poster");
    expect(view.money).toEqual({ kind: "awaiting", answerBy: ANSWER_BY, answerAt: jobPath(delivered().jobId) });
    expect(view.delivery).toEqual({
      answer: "awaited", answerBy: ANSWER_BY, checksPassed: true,
      behind: [...SEATS], notBehind: [], paidOnAcceptance: "20000000000000000000", keptOnRefusal: A_QUARTER,
    });

    const html = job(delivered(), { poster: POSTER });
    expect(html).toContain(SITE.job.next.delivered.awaited.passed);
    expect(html).toContain(SITE.job.money.awaiting);
    expect(html).toContain(SITE.job.answer.theirSilence.passed);
    expect(html).toContain(`<p class="bill-stamp" aria-hidden="true">delivered</p>`);
    // the page for a job that only passed its checks said the pod was paid and the work owned: neither is true yet
    expect(html).not.toContain(SITE.job.money.paid);
    expect(html).not.toContain(SITE.job.next.passed);
  });

  test("it says who put the work forward and which seats stand behind it, before the poster answers, and beside each seat", () => {
    // the whole pod behind it
    const whole = job(delivered(), { poster: POSTER });
    expect(whole).toContain(`<p id="behind-it">${SITE.job.behind.wholePod}</p>`);
    const saidBesideASeat = (html: string, words: string): number => html.split(`<p class="seat-approved">${words}<`).length - 1;
    expect(saidBesideASeat(whole, SITE.job.behind.stands)).toBe(4);
    expect(saidBesideASeat(whole, SITE.job.behind.putForward)).toBe(1);
    expect(whole).not.toContain(SITE.job.behind.doesNot);

    // security held its seat and said nothing: the page says so, to whoever is about to pay
    const silent = delivered({}, true, ["lead", "builder", "reviewer", "qa"]);
    const view = jobView(silent, [], { poster: POSTER });
    expect(view.delivery?.behind).toEqual(["lead", "builder", "reviewer", "qa"]);
    expect(view.delivery?.notBehind).toEqual(["security"]);
    const html = job(silent, { poster: POSTER });
    expect(html).toContain(`<p id="behind-it">Its builder put it forward, and the lead, the reviewer and QA stand behind it. Security did not.</p>`);
    expect(html).toContain(`<p class="seat-approved">${SITE.job.behind.doesNot}</p>`);
    expect(saidBesideASeat(html, SITE.job.behind.stands)).toBe(3);
    expect(saidBesideASeat(html, SITE.job.behind.putForward)).toBe(1);
    // nothing of the older contracts' words for an approval is said where a seat stands behind work or does not
    expect(html).not.toContain(`>${SITE.job.notApproved}<`);
  });

  test("who stands behind it is said in a sentence, whatever the mix of voices and silences", () => {
    const said = (behind: readonly Role[], notBehind: readonly Role[] = []): string => whoStandsBehindIt({ behind: [...behind], notBehind: [...notBehind] });
    expect(said(["builder"])).toBe("Its builder put it forward. No other seat was taken.");
    expect(said([...SEATS])).toBe("Its builder put it forward, and the whole pod stands behind it.");
    expect(said(["lead", "builder"])).toBe("Its builder put it forward, and the lead stands behind it.");
    expect(said(["builder", "qa", "security"])).toBe("Its builder put it forward, and QA and security stand behind it.");
    expect(said(["builder"], ["lead", "reviewer", "qa", "security"])).toBe("Its builder put it forward, and no other seat stands behind it. The lead, the reviewer, QA and security did not say.");
    expect(said(["builder", "qa"], ["lead"])).toBe("Its builder put it forward, and QA stands behind it. The lead did not.");
    expect(said(["lead", "builder"], ["qa", "security"])).toBe("Its builder put it forward, and the lead stands behind it. QA and security did not.");
  });

  test("what accepting pays, and what a refusal leaves, are the shares of the seats behind the work and of no other", () => {
    // 20 coins: the lead's 4, the builder's 8, the reviewer's 3 and QA's 3, and not security's 2
    const silent = jobView(delivered({}, true, ["lead", "builder", "reviewer", "qa"]), [], {}).delivery;
    expect(silent?.paidOnAcceptance).toBe("18000000000000000000");
    expect(silent?.keptOnRefusal).toBe("4500000000000000000");
    // a builder nobody stands behind: its own 8, and a quarter of that
    const alone = jobView(delivered({}, true, ["builder"]), [], {}).delivery;
    expect(alone?.paidOnAcceptance).toBe("8000000000000000000");
    expect(alone?.keptOnRefusal).toBe("2000000000000000000");
    expect(jobView(delivered({}, false, ["builder"]), [], {}).delivery?.keptOnRefusal).toBe("0");
    // once the poster has refused, what was kept is the chain's own word, whatever this would have worked out
    expect(jobView(answered("refused", true, "123"), [], {}).delivery?.keptOnRefusal).toBe("123");
  });

  test("while work is under review, no lead's seat is offered where the lead names who is paid, and every other free seat is", () => {
    const underReview = record({
      tile: tile({ verdict: "running", pod: [] }),
      chain: { ...ON_CHAIN, leadNames: true },
      review: { commit: signed.receipt.commit, reviewBy: "2026-10-01T13:00:00.000Z", behind: [], putForwardAt: "2026-10-01T11:00:00.000Z" },
    });
    const view = jobView(underReview, [], {});
    expect(view.leadNames).toBe(true);
    expect(view.seats.filter((seat) => !seat.agent).map((seat) => seat.role)).toEqual([...SEATS]);
    // the seats a page offers an agent: every free one, the lead's apart, since the contract refuses that now
    expect(freeSeatsOf(view.seats, view.leadNames === true && view.review !== undefined).map((seat) => seat.role))
      .toEqual(SEATS.filter((role) => role !== "lead"));
    // before work is put forward, and on a contract where every seat that says yes is paid, the lead's seat is offered
    const notYetBuilt = jobView({ ...underReview, review: undefined }, [], {});
    expect(freeSeatsOf(notYetBuilt.seats, notYetBuilt.leadNames === true && notYetBuilt.review !== undefined).map((seat) => seat.role)).toEqual([...SEATS]);
    const onTheThird = jobView({ ...underReview, chain: { ...ON_CHAIN } }, [], {});
    expect(onTheThird.leadNames).toBeUndefined();
    expect(freeSeatsOf(onTheThird.seats, onTheThird.leadNames === true && onTheThird.review !== undefined).map((seat) => seat.role)).toEqual([...SEATS]);
  });

  test("a seat its lead kept from the pay stands behind the work and is paid nothing: the page says so, and counts its share as the poster's", () => {
    // 20 coins, the whole pod behind it, and the lead named the reviewer and QA and not security: 4 + 8 + 3 + 3, and security's 2 goes back
    const whole = delivered();
    const named: JobRecord = { ...whole, approvals: whole.approvals.map((approval) => (approval.role === "security" ? { ...approval, isKeptFromPay: true } : approval)) };
    const view = jobView(named, [], {});
    expect(view.delivery?.behind).toEqual([...SEATS]);
    expect(view.delivery?.keptFromPay).toEqual(["security"]);
    expect(view.delivery?.paidOnAcceptance).toBe("18000000000000000000");
    expect(view.delivery?.keptOnRefusal).toBe("4500000000000000000");
    expect(view.seats.find((seat) => seat.role === "security")?.isKeptFromPay).toBe(true);
    expect(view.seats.find((seat) => seat.role === "reviewer")?.isKeptFromPay).toBeUndefined();
    expect(whoStandsBehindIt(view.delivery!)).toBe("Its builder put it forward, and the whole pod stands behind it. The lead read what each seat said it did and named who earned their pay. Security was not named, so its share goes back to whoever posted the job.");
    expect(whoStandsBehindIt({ behind: [...SEATS], notBehind: [], keptFromPay: ["reviewer", "qa"] }))
      .toContain("The reviewer and QA were not named, so their share goes back to whoever posted the job.");
    // where nobody is kept from the pay, nothing is said of it, and every seat behind the work is paid
    expect(jobView(whole, [], {}).delivery?.keptFromPay).toBeUndefined();
    expect(jobView(whole, [], {}).delivery?.paidOnAcceptance).toBe("20000000000000000000");
  });

  test("what a refusal would leave the pod is a quarter when the checks passed, and nothing when they failed", () => {
    expect(tileOf(delivered()).delivery?.keptOnRefusal).toBe(A_QUARTER);
    expect(tileOf(delivered({}, false)).delivery?.keptOnRefusal).toBe("0");
    expect(job(delivered({}, false))).toContain(SITE.job.next.delivered.awaited.failed);
    expect(job(delivered({}, false))).toContain(SITE.job.answer.theirSilence.failed);
  });

  test("accepted: the pod is paid, whatever the checks found, and the page says both", () => {
    for (const passed of [true, false]) {
      const view = jobView(answered("accepted", passed), [], {});
      expect(view.answer).toBe("accepted");
      expect(view.money).toEqual({ kind: "paid" });
      expect(view.verdict).toBe(passed ? "passed" : "failed");
      const html = job(answered("accepted", passed));
      expect(html).toContain(SITE.job.next.delivered.accepted[passed ? "passed" : "failed"]);
      expect(html).toContain(`<p class="bill-stamp" aria-hidden="true">paid</p>`);
    }
  });

  test("refused though its checks passed: the pod kept what the chain says it kept, and the rest went back", () => {
    const view = jobView(answered("refused", true, "4999999999999999999"), [], {});
    expect(view.money).toEqual({ kind: "shared", keptByThePod: "4999999999999999999" });
    const html = job(answered("refused", true, A_QUARTER));
    expect(html).toContain(SITE.job.next.delivered.refused.passed);
    expect(html).toContain(SITE.job.money.shared("5 MON"));
    expect(html).toContain(`<p class="bill-stamp" aria-hidden="true">refused</p>`);
  });

  test("refused after its checks failed: everything went back", () => {
    const view = jobView(answered("refused", false, "0"), [], {});
    expect(view.money).toEqual({ kind: "refunded" });
    expect(job(answered("refused", false, "0"))).toContain(SITE.job.next.delivered.refused.failed);
  });

  test("a poster who said nothing left it to the checks: paid when they passed, back when they failed, and stamped as the checks found", () => {
    expect(jobView(answered("unanswered"), [], {}).money).toEqual({ kind: "paid" });
    expect(jobView(answered("unanswered", false), [], {}).money).toEqual({ kind: "refunded" });
    expect(job(answered("unanswered"))).toContain(SITE.job.next.delivered.unanswered.passed);
    expect(job(answered("unanswered"))).toContain(`<p class="bill-stamp" aria-hidden="true">paid</p>`);
    expect(job(answered("unanswered", false))).toContain(`<p class="bill-stamp" aria-hidden="true">failed</p>`);
  });

  test("the wall counts each by how it ended, and stamps a refusal as one whatever its checks found", () => {
    const tiles = [delivered(), answered("accepted", false), answered("refused"), answered("unanswered", false), record()]
      .map((one, index) => tileView({ ...one.tile, jobId: `job-${index}` }, false, jobView(one, [], {}).answer));
    const html = draw({ page: "wall", tiles });
    expect(html).toContain(`<b>1</b> ${SITE.wall.tally.delivered}`);
    // accepted though it failed, and one that only ever passed its checks
    expect(html).toContain(`<b>2</b> ${SITE.wall.tally.paid}`);
    expect(html).toContain(`<b>1</b> ${SITE.wall.tally.refused}`);
    expect(html).toContain(`<b>1</b> ${SITE.wall.tally.failed}`);
    expect(html).toContain(`<article class="flyer passed answer-refused"><p class="flyer-stamp" aria-hidden="true">refused</p>`);
    expect(html).toContain(`<article class="flyer failed answer-accepted"><p class="flyer-stamp" aria-hidden="true">paid</p>`);
    expect(html).toContain(`<article class="flyer passed answer-awaited"><p class="flyer-stamp" aria-hidden="true">delivered</p>`);
  });

  test("a delivered website says where it is live, with one thing to press; once taken down it says so and links nowhere", () => {
    const live = { host: "Netlify", siteId: "site-1", url: "https://pod-excuses-abababab.netlify.app", at: "2026-10-01T11:40:00.000Z" };
    const up = job({ ...delivered(), live });
    expect(up).toContain(`<a class="primary" href="${live.url}" rel="noopener noreferrer">${SITE.job.live.open}</a>`);
    expect(up).toContain(inMarkup(SITE.job.live.says("Netlify")));

    const down = job({ ...answered("refused"), live: { ...live, removedAt: "2026-10-02T09:00:10.000Z" } });
    expect(down).toContain(inMarkup(SITE.job.live.down));
    expect(down).not.toContain(live.url);

    const never = job({ ...delivered(), notLiveBecause: "the website has no index.html at its top, so there is no front page to open" });
    expect(never).toContain(inMarkup(SITE.job.live.not("the website has no index.html at its top, so there is no front page to open")));
    // nothing of a live address is said of a job that has none
    expect(job(delivered())).not.toContain(SITE.job.live.open);
  });

  test("until the pod is paid, the page offers no way to fetch its code, and says whose it is; once paid, the command is there", () => {
    const waiting = delivered({ lastWord: true });
    expect(jobView(waiting, [], {}).isCodePrivate).toBe(true);
    expect(job(waiting)).toContain(inMarkup(SITE.job.repeatOnceItIsPaidFor));
    expect(job(waiting)).not.toContain(`<pre class="repeat">`);
    // refused: it stays the pod's
    expect(jobView(answered("refused"), [], {}).isCodePrivate).toBeUndefined();
    const refusedOnThisContract = { ...answered("refused"), chain: { ...answered("refused").chain!, lastWord: true as const } };
    expect(jobView(refusedOnThisContract, [], {}).isCodePrivate).toBe(true);
    // accepted: anybody can repeat the run
    const acceptedOnThisContract = { ...answered("accepted"), chain: { ...answered("accepted").chain!, lastWord: true as const } };
    expect(jobView(acceptedOnThisContract, [], {}).isCodePrivate).toBeUndefined();
    expect(job(acceptedOnThisContract)).toContain(`<pre class="repeat">`);
  });

  test("its receipt is stamped as the job is, never paid on a verdict alone, and links no code that is still the pod's", () => {
    const receiptOf = (of: JobRecord): string => draw({ page: "receipt", receipt: receiptView(of, of.signed!, "/job/excuses") });
    const stamped = (word: string): string => `<p class="stamp" aria-hidden="true">${word}</p>`;
    const onThisContract = (of: JobRecord): JobRecord => ({ ...of, chain: { ...of.chain!, lastWord: true } });

    // delivered and waiting: the checks passed, and nobody has been paid
    const waiting = receiptOf(onThisContract(delivered()));
    expect(waiting).toContain(stamped("delivered"));
    expect(waiting).not.toContain(stamped("paid"));
    expect(waiting).toContain(inMarkup(SITE.receipt.codeIsPrivate));
    expect(waiting).not.toContain(`href="${signed.receipt.repository}"`);

    // accepted: paid, and the code is anybody's to fetch
    const paid = receiptOf(onThisContract(answered("accepted")));
    expect(paid).toContain(stamped("paid"));
    expect(paid).toContain(`href="${signed.receipt.repository}"`);

    // refused although it passed: stamped so, and the code stays the pod's
    const refused = receiptOf(onThisContract(answered("refused")));
    expect(refused).toContain(stamped("refused"));
    expect(refused).not.toContain(`href="${signed.receipt.repository}"`);

    // a poster who said nothing left it to the checks, as on the contracts that settle on the verdict
    expect(receiptOf(onThisContract(answered("unanswered")))).toContain(stamped("paid"));
    expect(receiptOf(onThisContract(answered("unanswered", false)))).toContain(stamped("failed"));
    expect(receiptOf(record({ signed }))).toContain(stamped("paid"));
  });

  test("each side's record is said in a sentence, with what matters most first, and nothing is made of a wallet with no history", () => {
    expect(posterRecordWords({ posted: 6, accepted: 3, refusedPassed: 2, refusedFailed: 1, unanswered: 0 }))
      .toBe("Of 6 jobs this wallet has posted here, it has refused 2 whose checks passed, accepted 3 and refused 1 whose checks failed.");
    expect(posterRecordWords({ posted: 1, accepted: 0, refusedPassed: 0, refusedFailed: 0, unanswered: 0 })).toBe(SITE.job.records.posterNothingYet(1));
    expect(posterRecordWords({ posted: 3, accepted: 0, refusedPassed: 0, refusedFailed: 0, unanswered: 0 })).toBe("This wallet has posted 3 jobs here, and has not answered a delivery yet.");
    expect(agentRecordWords({ accepted: 2, paidUnanswered: 1, refusedPassed: 1, failed: 0, undelivered: 1 })).toBe("before this: 3 paid, 1 refused, 1 not delivered");
    expect(agentRecordWords({ accepted: 0, paidUnanswered: 0, refusedPassed: 0, failed: 0, undelivered: 0 })).toBe(SITE.job.records.agentNothingYet);

    const html = job(delivered(), { poster: POSTER, posterRecord: { posted: 2, accepted: 1, refusedPassed: 0, refusedFailed: 0, unanswered: 0 },
      agentRecords: { [LEAD]: { accepted: 1, paidUnanswered: 0, refusedPassed: 0, failed: 0, undelivered: 0 } } });
    expect(html).toContain("Of 2 jobs this wallet has posted here, it has accepted 1.");
    expect(html).toContain(`<span class="seat-record">before this: 1 paid</span>`);
  });

  test("it leads with what its poster decides by: the door to the work, what its checks found, then the answer; the record of how it got there comes after", () => {
    const live = { host: "Netlify", siteId: "site-1", url: "https://pod-coat-1a2b3c4d.netlify.app", at: "2026-10-01T12:00:00.000Z" };
    const html = job({ ...delivered(), live }, { poster: POSTER });
    const at = (id: string): number => html.indexOf(`id="${id}"`);
    for (const id of ["open", "checks", "stands", "record", "pod", "owns", "asked"]) expect(at(id), `the page has #${id}`).toBeGreaterThan(-1);
    expect([at("open"), at("checks"), at("stands"), at("record"), at("pod"), at("owns"), at("asked")]).toEqual([at("open"), at("checks"), at("stands"), at("record"), at("pod"), at("owns"), at("asked")].sort((a, b) => a - b));

    // what the checks found is counted in a sentence, the hidden ones named, before the list of them
    const view = jobView(delivered(), [], { poster: POSTER });
    const passed = view.checks.filter((check) => check.exitCode === 0);
    expect(view.checks.length).toBeGreaterThan(0);
    expect(html).toContain(SITE.job.checksFound(passed.length, view.checks.length, passed.filter((check) => check.hidden).length));
    expect(html).toContain(`>${SITE.job.checks.found}</h2>`);

    // work with no address of its own has no door to draw, and the page starts with what its checks found
    const withNothingToOpen = job(delivered(), { poster: POSTER });
    expect(withNothingToOpen).not.toContain(`id="open"`);
    expect(withNothingToOpen.indexOf(`id="checks"`)).toBeLessThan(withNothingToOpen.indexOf(`id="stands"`));

    // while it waits, nobody holds its title: the page says when that changes, and never that none was made
    expect(html).toContain(inMarkup(SITE.job.titleOnAcceptance));
    expect(html).not.toContain(inMarkup(SITE.job.noTitle));
  });

  test("once it is its poster's, whose it is comes straight after the door, ahead of the record", () => {
    const live = { host: "Netlify", siteId: "site-1", url: "https://pod-coat-1a2b3c4d.netlify.app", at: "2026-10-01T12:00:00.000Z" };
    for (const mine of [answered("accepted"), answered("unanswered")]) {
      const html = job({ ...mine, live }, { poster: POSTER });
      expect(html.indexOf(`id="open"`)).toBeLessThan(html.indexOf(`id="owns"`));
      expect(html.indexOf(`id="owns"`)).toBeLessThan(html.indexOf(`id="checks"`));
      expect(html.split(`id="owns"`).length, "drawn once").toBe(2);
    }
    // refused, or left to checks that failed: it is not theirs, and who owns it stays in the record
    for (const notMine of [answered("refused"), answered("unanswered", false)]) {
      const html = job(notMine, { poster: POSTER });
      expect(html.indexOf(`id="record"`)).toBeLessThan(html.indexOf(`id="owns"`));
    }
  });

  test("its poster is spoken to as you, in every way a delivery can stand", () => {
    for (const answer of ["awaited", "accepted", "refused", "unanswered"] as const) {
      for (const checksPassed of [true, false]) {
        const toYou = whereTheDeliveryStands({ answer, checksPassed }, true);
        expect(toYou).not.toBe(whereTheDeliveryStands({ answer, checksPassed }));
        expect(toYou).toMatch(/\b(you|your|yours)\b/i);
        expect(toYou).not.toContain("whoever posted");
      }
    }
  });

  test("work under review says who stands behind it so far, who has yet to say, and when it goes to its checks at the latest", () => {
    const REVIEW_BY = "2026-10-01T12:30:00.000Z";
    const underReview = (behind: readonly Role[], pod = FULL_POD): JobRecord => running({
      tile: tile({ verdict: "running", pod }), chain: { ...ON_CHAIN, lastWord: true },
      review: { commit: signed.receipt.commit, putForwardAt: "2026-10-01T12:00:00.000Z", reviewBy: REVIEW_BY, behind },
    });
    // the builder put it forward, so it is never counted among those behind it or those yet to say
    const view = jobView(underReview(["builder", "qa", "security"]), [], {});
    expect(view.review).toEqual({ putForwardAt: "2026-10-01T12:00:00.000Z", reviewBy: REVIEW_BY, behind: ["qa", "security"], notYet: ["lead", "reviewer"] });
    const html = job(underReview(["builder", "qa", "security"]));
    expect(html).toContain("The builder has put its work forward. QA and security stand behind it so far; the lead and the reviewer have yet to say.");
    expect(html).toContain(SITE.job.next.underReview.goesToItsChecks);
    expect(html).toContain(SITE.job.next.underReview.nothingToDo);
    expect(html).not.toContain(SITE.job.next.buildingForAnAnswer(5));

    expect(whereTheReviewStands({ behind: [], notYet: ["lead"] })).toBe("The builder has put its work forward. No other seat stands behind it yet; the lead has yet to say.");
    expect(whereTheReviewStands({ behind: ["lead"], notYet: ["qa"] })).toBe("The builder has put its work forward. The lead stands behind it so far; QA has yet to say.");
    expect(whereTheReviewStands({ behind: ["lead", "qa"], notYet: [] })).toBe(SITE.job.next.underReview.all);
    // a builder alone: no seat is waited for, and nothing says when a review runs out
    const alone = underReview(["builder"], FULL_POD.filter((seat) => seat.role === "builder"));
    expect(jobView(alone, [], {}).review).toEqual({ putForwardAt: "2026-10-01T12:00:00.000Z", reviewBy: REVIEW_BY, behind: [], notYet: [] });
    expect(job(alone)).toContain(SITE.job.next.underReview.alone);
    expect(job(alone)).not.toContain(SITE.job.next.underReview.goesToItsChecks);

    // a review that has run out waits for nobody: the page says the work has gone to its checks, never that a seat has yet to say
    const ranOut = underReview(["builder", "qa", "security"]);
    const over = job({ ...ranOut, review: { ...ranOut.review!, reviewBy: "2026-10-01T11:00:00.000Z" } });
    expect(over).toContain(inMarkup("The builder's work has gone to its checks. QA and security stand behind it."));
    expect(over).not.toContain("yet to say");
    expect(over).not.toContain(SITE.job.next.underReview.goesToItsChecks);
    expect(whereTheReviewStands({ behind: [], notYet: ["lead"] }, true)).toBe(SITE.job.next.underReview.ranOutAlone);

    // once it is delivered the review is over, and the page says nothing of it even if the record still held one
    expect(jobView({ ...delivered(), review: underReview(["builder"]).review! }, [], {}).review).toBeUndefined();
  });

  test("a job nobody has come to, where a builder alone can deliver, never says it needs five agents", () => {
    const open = running({ tile: tile({ verdict: "running", pod: [] }), chain: { ...ON_CHAIN, lastWord: true } });
    const html = job(open);
    expect(html).toContain(SITE.job.next.waitingForAnAnswer);
    expect(html).not.toContain(SITE.job.next.waiting);
    expect(SITE.job.next.waitingForAnAnswer + SITE.job.forAPod + SITE.job.podGuideForAnAnswer).not.toMatch(/(?<!up to )five AI agents|\bis five\b/);
    // on the contracts before, a pod of five is what a job needs, and its page still says so
    expect(job(running({ tile: tile({ verdict: "running", pod: [] }) }))).toContain(SITE.job.next.waiting);
  });

  test("a built job's card carries the door to its live website, once its result is public and for as long as it is up", () => {
    const tileOfRecord = (of: JobRecord, liveAt?: string) => tileView(of.tile, of.signed !== undefined, jobView(of, [], {}).answer, liveAt);
    const url = "https://pod-coat-1a2b3c4d.netlify.app";
    const withADoor = draw({ page: "wall", tiles: [tileOfRecord(answered("accepted"), url)] });
    expect(withADoor).toContain(`<a class="open-it" href="${url}" rel="noopener noreferrer">${SITE.tile.open}</a>`);
    expect(draw({ page: "wall", tiles: [tileOfRecord(answered("accepted"))] })).not.toContain("open-it");
  });

  test("the welcome's six steps: a pod of up to five, the refusal and the silence by the contract's own rule, and what a poster needs before they start", () => {
    const rule = { answerSeconds: 3 * 24 * 3600, refusalSharePercent: 25, reviewSharePercent: 25 };
    const steps = Object.values(SITE.welcome.steps(rule)).map((step) => `${step.title}. ${step.says}`);
    expect(steps).toHaveLength(6);
    expect(steps.join(" ")).toContain("Up to five AI agents");
    expect(steps.join(" ")).not.toMatch(/(?<!up to )five AI agents/i);
    expect(steps.join(" ")).toContain("all of it if the checks failed, three quarters if they passed. Say nothing for 3 days, and the checks decide.");
    // a contract with another rule is told by its own numbers, never these
    const other = Object.values(SITE.welcome.steps({ ...rule, answerSeconds: 12 * 3600, refusalSharePercent: 50 })).map((step) => step.says).join(" ");
    expect(other).toContain("half if they passed. Say nothing for 12 hours");
    expect(SITE.welcome.needs).toContain("a wallet with test MON");
  });

  test("a check that failed says why in its own last word, once its result is public and never before", () => {
    const failedRecord = delivered({}, false);
    const withWhy: JobRecord = { ...failedRecord, checksSaid: failedRecord.checksSaid.map((check, index) => (index === 0 ? { ...check, exitCode: 1, said: "Card page not found" } : check)) };
    const html = job(withWhy, { poster: POSTER });
    // React marks where one piece of text ends and the next begins, which is all that sits between the two
    expect(html.replaceAll("<!-- -->", "")).toContain(`<span class="check-said">${SITE.job.checkSaid} Card page not found</span>`);
    // a check that passed has nothing to explain, whatever it printed
    const passedWithWords: JobRecord = { ...delivered(), checksSaid: delivered().checksSaid.map((check) => ({ ...check, said: "all good" })) };
    expect(job(passedWithWords, { poster: POSTER })).not.toContain("check-said");
    // and what a check printed is the grader's to keep until the result is public: the record a page is drawn from has none of it
    const sealed = publicRecord({ ...withWhy, chain: { ...ON_CHAIN } }, NOW);
    expect(JSON.stringify(sealed.checksSaid)).not.toContain("Card page not found");
  });

  test("the price says where the money is now, and an answered delivery says where it went once", () => {
    const billOf = (of: JobRecord): string => job(of, { poster: POSTER });
    expect(billOf(delivered())).toContain(SITE.job.priceSays.awaiting);
    expect(billOf(answered("accepted"))).toContain(SITE.job.priceSays.paid);
    expect(billOf(answered("refused", false))).toContain(SITE.job.priceSays.refunded);
    expect(billOf(answered("refused", true, A_QUARTER))).toContain(SITE.job.priceSays.shared);
    for (const settled of [answered("accepted"), answered("refused", false)]) {
      expect(billOf(settled)).not.toContain(SITE.job.priceSays.held);
      // the first sentence says where the money went, so the line under it does not say it again
      expect(billOf(settled)).not.toContain(SITE.job.money.paid);
      expect(billOf(settled)).not.toContain(SITE.job.money.refunded);
    }
    // what a pod kept of refused work is an amount, and is still said
    expect(billOf(answered("refused", true, A_QUARTER))).toContain(inMarkup(SITE.job.money.shared("5 MON")));
  });

  test("a poster's own record and standing are said to them as you, in words that never call them a wallet or a poster", () => {
    const record = { posted: 6, accepted: 3, refusedPassed: 1, refusedFailed: 0, unanswered: 0 };
    expect(posterRecordWords(record, true)).toBe("Of 6 jobs you have posted here, you have refused 1 whose checks passed and accepted 3. Agents see this before they take a seat on your next one.");
    expect(posterRecordWords({ posted: 1, accepted: 0, refusedPassed: 0, refusedFailed: 0, unanswered: 0 }, true)).toBe("This is the first job you have posted here.");
    for (const said of [...Object.values(SITE.job.standingYours), ...Object.values(SITE.job.nothingToDo)]) {
      expect(said).toMatch(/\b(you|your)\b/i);
      expect(said).not.toMatch(/its poster|this wallet|whoever posted/);
    }
  });

  test("a wallet that sends agents sees each seat it owns or holds, and what that seat paid, however its job ended", () => {
    const OWNER: Address = "0x00000000000000000000000000000000000000aa";
    const QA: Address = `0x${"4".padStart(40, "0")}`;
    // the builder's seat is worked by an agent under a grant from OWNER, so OWNER owns it; every other seat is its own agent's
    const owned = (of: JobRecord): JobRecord => ({ ...of, tile: { ...of.tile, pod: of.tile.pod.map((seat) => (seat.role === "builder" ? { ...seat, owner: OWNER } : seat)) } });
    const outcomeOf = (of: JobRecord): string[] => seatsOfYours(owned(of), OWNER).map((seat) => `${seat.role} ${seat.outcome}`);

    expect(outcomeOf(running({ tile: tile({ verdict: "running", pod: FULL_POD }), chain: { ...ON_CHAIN, lastWord: true } }))).toEqual(["builder seated"]);
    expect(outcomeOf(delivered())).toEqual(["builder awaiting"]);
    expect(outcomeOf(answered("accepted"))).toEqual(["builder paid"]);
    expect(outcomeOf(answered("unanswered"))).toEqual(["builder paid"]);
    expect(outcomeOf(answered("refused", true, A_QUARTER))).toEqual(["builder keptPart"]);
    expect(outcomeOf(answered("refused", false))).toEqual(["builder nothing"]);
    expect(outcomeOf(answered("unanswered", false))).toEqual(["builder nothing"]);

    // a seat that did not stand behind what was delivered is paid nothing for it, and its owner is told so
    expect(seatsOfYours(delivered({}, true, ["lead", "builder", "reviewer", "security"]), QA).map((seat) => seat.outcome)).toEqual(["notBehind"]);
    // a wallet's own key in a seat is its seat too; a wallet with no seat has none, its poster included
    expect(seatsOfYours(delivered(), LEAD).map((seat) => seat.role)).toEqual(["lead"]);
    expect(seatsOfYours(delivered(), POSTER)).toEqual([]);

    // each says which job, which seat, which agent, where the job stands and the seat's share of the price
    expect(seatsOfYours(owned(delivered()), OWNER)[0]).toEqual({
      jobId: delivered().jobId, idea: delivered().tile.idea, standing: "delivered, waiting for its poster",
      role: "builder", agent: BUILDER, pay: "8000000000000000000", outcome: "awaiting",
    });
    for (const says of Object.values(SITE.yours.seatOutcome)) expect(says("8 MON")).toContain("8 MON");
  });

  test("where the poster has the last word, a job still being built says so, and what its money waits on", () => {
    const building = running({ chain: { ...ON_CHAIN, lastWord: true } });
    const html = job(building);
    expect(html).toContain(SITE.job.next.buildingForAnAnswer(2));
    expect(html).toContain(inMarkup(SITE.job.money.onlyTheAnswer));
    expect(html).toContain(SITE.job.podGuideForAnAnswer);
    // and a job on a contract that settles on the checks alone still says that
    expect(job(running())).toContain(SITE.job.next.building(2));
    expect(job(running())).toContain(SITE.job.money.onlyTheVerdict);
  });

  test("where the checks alone decide the list of jobs says how it works itself; where the poster has the last word it is the jobs alone, and the welcome is the film", () => {
    const tiles = [tileView(tile(), false)];
    const byChecks = draw({ page: "wall", tiles });
    expect(byChecks).toContain(SITE.wall.strap);
    expect(byChecks).toContain(`id="how-it-works"`);
    const market = { chainId: 31337, chainName: "a local chain", rpc: "http://127.0.0.1:8545", jobs: ON_CHAIN.jobs, explorer: "http://explorer.invalid", coin: "MON", lastWord: { answerSeconds: 3 * 86_400, refusalSharePercent: 25, reviewSharePercent: 25 } };
    const drawn = (page: "wall" | "welcome"): string => renderSite({ title: "a page" }, { page, tiles, coin: "MON", drawnAt: NOW.toISOString(), site: SITE_ADDRESS, market });

    const jobs = drawn("wall");
    expect(jobs).toContain(SITE.wall.jobs.strap);
    expect(jobs).not.toContain(SITE.wall.strap);
    expect(jobs).not.toContain(`id="how-it-works"`);
    expect(jobs).toContain(`<a class="quiet" href="${ROUTES.welcome}">${SITE.wall.jobs.how}</a>`);

    const welcome = drawn("welcome").replaceAll("<!-- -->", "");
    expect(welcome).toContain(SITE.welcome.strap);
    // the film is drawn at its first scene, with every prop where that scene ends, and is kept from a screen reader
    expect(welcome).toContain(`<div class="stage" data-beat="say" aria-hidden="true">`);
    expect(welcome).toContain(`<p class="stage-title">You say what you want</p>`);
    expect(welcome).toContain(`<p class="ticket-price">1 MON</p>`);
    expect(welcome).toContain(`<div class="film-rail" data-money="arriving">`);
    expect(welcome).toContain("1 MON is held, not paid.");
    expect(welcome.match(/data-state="empty" data-role=/g)).toHaveLength(5);
    // the same six steps in words, for whoever reads rather than watches, by the contract's own rule
    expect(welcome.match(/<ol class="story-steps">(.*?)<\/ol>/s)?.[1]?.match(/<li>/g)).toHaveLength(6);
    expect(welcome).toContain("all of it if the checks failed, three quarters if they passed. Say nothing for 3 days, and the checks decide.");
    // and the newest jobs really built here, with the way to all of them
    expect(welcome).toContain(SITE.welcome.builtTitle);
    expect(welcome).toContain(`<a href="${ROUTES.wall}">${SITE.welcome.everyJob}</a>`);
    // with nothing built yet it promises nothing: no heading over an empty space
    expect(renderSite({ title: "a page" }, { page: "welcome", tiles: [], coin: "MON", drawnAt: NOW.toISOString(), site: SITE_ADDRESS, market })).not.toContain(SITE.welcome.builtTitle);
    // a welcome asked of a server with no such rule is the list of jobs, saying how it works itself
    expect(draw({ page: "welcome", tiles })).toContain(`id="how-it-works"`);
  });

  test("a job on a contract that settles on the verdict alone has no delivery to speak of", () => {
    const view = jobView(record({ chain: { ...ON_CHAIN, settled: "0x01" }, signed }), [], {});
    expect(view.answer).toBeUndefined();
    expect(view.delivery).toBeUndefined();
    expect(view.money).toEqual({ kind: "paid" });
  });
});

describe("a job on the contract that prepares jobs", () => {
  test("open with nobody seated, its page says the money can be taken back now, and once a seat is taken, that only the verdict moves it", () => {
    const open = running({ tile: tile({ verdict: "running", pod: [] }) });
    expect(jobView(open, [], { takesBackBeforeASeat: true }).money).toMatchObject({ kind: "held", isOpenToTakeBack: true });
    expect(job(open, { takesBackBeforeASeat: true })).toContain("Nobody has taken a seat yet, so whoever posted the job can take the money back now");
    // a seat taken, on the record or on the chain, and the first contract, say what they always said
    expect(jobView(running(), [], { takesBackBeforeASeat: true }).money).not.toHaveProperty("isOpenToTakeBack");
    expect(jobView(open, [], { takesBackBeforeASeat: true, onChain: { state: "working", endsAt: 1_790_000_000n } }).money).not.toHaveProperty("isOpenToTakeBack");
    expect(jobView(open, [], {}).money).not.toHaveProperty("isOpenToTakeBack");
    expect(job(open)).toContain("Only the verdict can move it before then");
    // where the poster has the last word no verdict moves the money, and the open job's page never says one does
    const forAnAnswer = job(running({ tile: tile({ verdict: "running", pod: [] }), chain: { ...ON_CHAIN, lastWord: true } }), { takesBackBeforeASeat: true });
    expect(forAnAnswer).toContain(inMarkup(SITE.job.money.beforeASeatForAnAnswer));
    expect(forAnAnswer).not.toContain("only the verdict");
  });
});

describe("a job paid for and never published", () => {
  const paid = (state: "open" | "settled" | "refunded" | "preparing") => ({
    jobs: "0x00000000000000000000000000000000000000c1",
    onChainId: 7n,
    job: { poster: POSTER, price: 10n ** 18n, seal: `0x${"ab".repeat(32)}`, endsAt: 1_790_000_000n, state, commit: `0x${"00".repeat(32)}`, reviewers: 1 },
  } as const);

  test("its money is held until the window closes, then taken back by its number, or said to be back", () => {
    expect(unpublishedView(paid("open"))).toEqual({
      onChainId: "7", price: "1000000000000000000",
      money: { kind: "held", endsAt: new Date(1_790_000_000_000).toISOString(), takeBack: refundByNumberPath("7", "0x00000000000000000000000000000000000000c1") },
    });
    expect(unpublishedView(paid("refunded")).money).toEqual({ kind: "refunded" });
    expect(unpublishedView(paid("settled")).money).toEqual({ kind: "paid" });
  });

  test("one still preparing is sent to its own page: to read its checks, or, never set up, to take the money back", () => {
    expect(unpublishedView(paid("preparing"), true).money).toEqual({ kind: "preparing", page: preparingPagePath("7") });
    expect(unpublishedView(paid("preparing"), false).money).toEqual({ kind: "notSetUp", page: preparingPagePath("7") });
    // whether it was set up says nothing about a job that is not preparing
    expect(unpublishedView(paid("open"), true).money.kind).toBe("held");
  });

  test("one open on the contract that prepares jobs was approved by its poster, and is on its way to the wall", () => {
    expect(unpublishedView({ ...paid("open"), prepares: true }).money).toEqual({
      kind: "approved", endsAt: new Date(1_790_000_000_000).toISOString(), takeBack: refundByNumberPath("7", "0x00000000000000000000000000000000000000c1"),
    });
    // settled or taken back, it says so on either contract
    expect(unpublishedView({ ...paid("refunded"), prepares: true }).money).toEqual({ kind: "refunded" });
  });
});

describe("the page for bringing an agent", () => {
  test("says what each seat does and is paid, what a seat costs, and where to point an agent", () => {
    const html = draw({ page: "agents" });
    expect(html).toContain(`${SHARES.builder}%`);
    expect(html).toContain(SITE.agents.deposit(DEPOSIT_PERCENT));
    // the address an agent is given is this site's own, and it is one press away
    expect(html).toContain(`${SITE_ADDRESS}${ROUTES.guide}`);
    expect(html).toContain('class="copyable"');
    expect(html).toContain(`href="${ROUTES.guide}"`);
    expect(html).toContain(`href="${ROUTES.jobList}"`);
  });

  test("the mandate is the five steps, in the order the wallet and the connector take them, each line one press away", () => {
    const html = draw({ page: "agents" });
    const steps = [...html.matchAll(/data-step="(\w+)" data-where="(\w+)"/g)].map(([, id, where]) => ({ id, where }));
    expect(steps).toEqual(MANDATE_STEPS.map((step) => ({ id: step.id, where: step.where })));
    for (const line of [SKILL_INSTALL, CONNECTOR_INSTALL]) expect(html).toContain(line);
    // the sentence the owner gives their agent names this site, so it can be given as it is
    expect(html).toContain(SITE.agents.mandate.sentence(SITE_ADDRESS));
    expect(html).toContain(WALLET_ADDRESS);
    // one wallet address, for Arc and Monad alike: the preview's address is gone from every page
    expect(WALLET_ADDRESS).toBe("https://kuiralabs.github.io/mandate/");
    expect(html).not.toContain("mandate-next");
  });
});

describe("an agent's page", () => {
  const AGENT = "0x1111111111111111111111111111111111111111";
  const OWNER = "0x2222222222222222222222222222222222222222";
  const theirs = (over: Partial<Tile> = {}): Tile => tile({ pod: [{ role: "lead", agent: AGENT, owner: AGENT }], ...over });
  const agentPage = (tiles: readonly Tile[], facts: AgentFactsView = { isUnread: false }, answered?: AgentRecordView): string =>
    draw({ page: "agent", agent: AGENT, record: [...recordByRole(AGENT, tiles)], facts, tiles: tiles.map((one) => tileView(one, true)), ...(answered ? { answered } : {}) });

  test("it names the agent and shows failures as plainly as passes", () => {
    const html = agentPage([theirs({ jobId: "a" }), theirs({ jobId: "b", verdict: "failed" })]);
    expect(html).toContain(AGENT);
    expect(html).toContain(">failed</th>");
    expect(html).toContain("checks failed");
  });

  test("an agent with nothing published says so, without calling it a judgement", () => {
    const html = agentPage([]);
    expect(html).toContain("has not finished a job on this server");
    expect(html).not.toContain("<article");
  });

  test("it says who the agent is: its ERC-8004 identity, who owns it, and what the chain holds of it seat by seat", () => {
    const html = agentPage([theirs()], {
      isUnread: false,
      identity: { id: "1875", owner: OWNER, seats: [{ role: "lead", recorded: 3, passed: 2, unsure: 1 }] },
      github: { login: "octocat", gist: "https://gist.github.com/octocat/abc" },
    });
    expect(html).toContain("Agent #1875");
    expect(html).toContain("ERC-8004 identity #1875, owned by");
    expect(html).toContain("0x2222…2222");
    expect(html).toContain("Its record on the chain, seat by seat");
    expect(html).toMatch(/<th scope="row">lead<\/th><td>3<\/td><td>2<\/td><td>1<\/td>/);
    expect(html).toContain(`href="https://github.com/octocat"`);
    expect(html).toContain(`href="https://gist.github.com/octocat/abc"`);
  });

  test("with no identity it says why, with the chain unread it says that instead, and never claims credit it has not got", () => {
    const none = agentPage([theirs()]);
    expect(none).toContain("none of its verdicts has been recorded on the chain yet");
    expect(none).toContain("has not linked a GitHub account");
    expect(none).not.toContain("Its record on the chain");
    expect(agentPage([theirs()], { isUnread: true })).toContain("could not be read just now");
  });

  test("where a contract counts it, the page says what the posters of its jobs said, a refusal of passed work as plainly as a payment", () => {
    const counted = { accepted: 3, paidUnanswered: 1, refusedPassed: 2, failed: 1, undelivered: 1 };
    expect(agentAnsweredWords(counted)).toBe(
      "Of the jobs it held a seat on: 3 accepted by the poster, 1 paid on the checks when the poster said nothing, 2 refused although the checks passed, 1 failed the checks and 1 closed with nothing delivered.",
    );
    const html = agentPage([theirs()], { isUnread: false }, counted);
    expect(html).toContain(SITE.agent.answeredTitle);
    expect(html).toContain(agentAnsweredWords(counted));

    // nothing counted yet is said as that, and a server whose contract keeps no count says nothing at all
    const nothing = { accepted: 0, paidUnanswered: 0, refusedPassed: 0, failed: 0, undelivered: 0 };
    expect(agentAnsweredWords(nothing)).toBe(SITE.agent.answeredNothingYet);
    expect(agentPage([theirs()], { isUnread: false }, nothing)).toContain(`id="answered"`);
    expect(agentPage([theirs()])).not.toContain(`id="answered"`);
  });
});

describe("a receipt, for a person", () => {
  test("says what ran, on what, and links the signed file and the job", () => {
    const html = draw({ page: "receipt", receipt: receiptView(record({ signed }), signed, "/job/excuses") });
    expect(html).toContain("node server.js");
    expect(html).toContain(signed.hash);
    expect(html).toContain(`href="${receiptFilePath("excuses")}"`);
    expect(html).toContain(`href="/job/excuses"`);
  });
});

describe("an address with nothing at it", () => {
  test("is a page in the same look, with the way back", () => {
    const html = draw({ page: "missing", why: "No job called nowhere" });
    expect(html).toContain("No job called nowhere");
    expect(html).toContain("Back to the wall");
    expect(html).toContain(`class="site-header"`);
  });
});
