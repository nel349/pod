import { describe, expect, test } from "bun:test";
import type { Tile } from "../gallery.ts";
import type { JobRecord } from "../store.ts";
import { recordByRole } from "../agentpage.ts";
import { claimPath, receiptFilePath, receiptPath, refundPath } from "../routes.ts";
import {
  jobView, moneyAt, needsTheChainForMoney, receiptView, renderSite, tileView, type SiteData, type SitePage,
} from "../web/site/index.ts";
import { lengthOf, timeLeft, whenInUTC } from "../web/site/copy.ts";
import type { SignedReceipt } from "../receipt.ts";

const LEAD = "0x00000000000000000000000000000000000000a1";
const BUILDER = "0x00000000000000000000000000000000000000a2";
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

const draw = (page: SitePage): string => {
  const data: SiteData = { ...page, coin: "MON", drawnAt: NOW.toISOString() };
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
    expect(wall([tile({ receiptURI: undefined })])).toContain("no receipt yet");
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
    expect(html).toContain("<b>1</b> paid");
    expect(html).toContain("<b>1</b> refused");
    expect(html).toContain("<b>1</b> unrepeatable");
  });

  test("an empty wall is still a page, says so, and says nothing false", () => {
    const html = wall([]);
    expect(html).toContain("Nothing built yet");
    expect(html).toContain("<b>0</b> paid");
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
    expect(html).toContain("1 more check is sealed until there is a verdict");
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
    expect(html).toContain("POD #4 is the title to this repository");
    expect(html).toContain("0x0000…00b9");
    expect(html).toContain(`href="${claimPath("excuses")}"`);
    expect(html).toContain("Job 7 on the contract");
  });

  test("a title whose holder the chain did not answer for says so, rather than naming nobody", () => {
    const html = job(record({ chain: { network: "monad-testnet", jobId: "7", jobs: "0x00000000000000000000000000000000000000c1", tokenId: "4" } }));
    expect(html).toContain("could not be read from the chain just now");
  });

  test("a job that passed with no title says nobody can claim it yet", () => {
    expect(job(record({ repository: "https://github.com/pod/job-7" }))).toContain("No title was minted");
  });

  test("a job with a receipt shows how to repeat the run, and one without simply does not", () => {
    const html = job(record({ signed }));
    expect(html).toContain("Check it yourself");
    expect(html).toContain("--network none");
    expect(html).toContain(`href="${receiptFilePath("excuses")}"`);
    expect(job(record())).not.toContain("Check it yourself");
  });

  test("a job the runs disagreed on says what that means for the money", () => {
    expect(job(record({ tile: tile({ verdict: "not-reproducible" }) }))).toContain("nothing was settled");
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

describe("an agent's page", () => {
  const AGENT = "0x1111111111111111111111111111111111111111";
  const theirs = (over: Partial<Tile> = {}): Tile => tile({ pod: [{ role: "lead", agent: AGENT, owner: AGENT }], ...over });
  const agentPage = (tiles: readonly Tile[]): string =>
    draw({ page: "agent", agent: AGENT, record: [...recordByRole(AGENT, tiles)], tiles: tiles.map((one) => tileView(one, true)) });

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

  test("it says the chain's record is not what is on the page", () => {
    expect(agentPage([theirs()])).toContain("this page does not show it yet");
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
