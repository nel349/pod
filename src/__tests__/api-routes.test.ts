import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle, MOST_A_POSTING_MAY_WEIGH, MOST_A_REQUEST_TO_WRITE_MAY_WEIGH, type Market } from "../server.ts";
import { JobStore } from "../store.ts";
import { CheckWriting, ProvenChecks } from "../checkwriting/index.ts";
import { jobNamePath, ROUTES, writingPath } from "../routes.ts";
import { COAT_REQUEST, GOOD_REPLY, replying, writerWith } from "./support/coat.ts";

/**
 * The routes the posting page talks to, answered as the server answers them, without a browser.
 *
 * Every refusal here is one a person or a script could meet by sending the wrong thing, so each is
 * asserted with its status and its words. None of these reaches the model or a box: the one route
 * that starts writing for real is tested where Docker is, in checkwriting.test.ts.
 */

const MARKET_PAGE = {
  chainId: 31337, chainName: "a local chain", rpc: "http://127.0.0.1:8545",
  jobs: "0x0000000000000000000000000000000000000001" as const, explorer: "http://explorer.invalid", coin: "ETH",
};

async function aMarket(atOnce = 0): Promise<Market> {
  const proven = new ProvenChecks(await mkdtemp(join(tmpdir(), "pod-proven-")));
  return {
    page: MARKET_PAGE,
    // nothing here reaches the chain; a reader that would say so if it were asked
    chain: { jobs: MARKET_PAGE.jobs, job: async () => { throw new Error("the chain was not meant to be asked"); } },
    // atOnce 0: nothing is ever started, so nothing reaches the model
    writing: new CheckWriting({ writer: writerWith(replying(GOOD_REPLY).model), proven, atOnce }),
    proven,
  };
}

const aStore = async (): Promise<JobStore> => new JobStore(await mkdtemp(join(tmpdir(), "pod-routes-")));

const post = (path: string, body: string, headers: Record<string, string> = {}): Request =>
  new Request(`http://pod.test${path}`, { method: "POST", body, headers });
const get = (path: string): Request => new Request(`http://pod.test${path}`);

describe("the market the page reads first", () => {
  test("a server with no contract says posting is not open, as a 404 the page can show", async () => {
    const answer = await handle(get(ROUTES.market), await aStore());
    expect(answer.status).toBe(404);
    expect(await answer.json()).toEqual({ why: "posting is not open on this server: it has no contract to post to" });
  });

  test("a server with a contract hands the page exactly its chain, contract and coin", async () => {
    const answer = await handle(get(ROUTES.market), await aStore(), { market: await aMarket() });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual(MARKET_PAGE);
  });
});

describe("asking for checks to be written", () => {
  test("with no market there is nobody to write them", async () => {
    const answer = await handle(post(ROUTES.writeChecks, JSON.stringify(COAT_REQUEST)), await aStore());
    expect(answer.status).toBe(503);
  });

  test("a request that declares itself too large is refused before it is read", async () => {
    const answer = await handle(
      post(ROUTES.writeChecks, "{}", { "content-length": String(MOST_A_REQUEST_TO_WRITE_MAY_WEIGH + 1) }),
      await aStore(), { market: await aMarket() },
    );
    expect(answer.status).toBe(413);
  });

  test("a request that is too large, whatever it declares, is refused", async () => {
    const answer = await handle(post(ROUTES.writeChecks, "x".repeat(MOST_A_REQUEST_TO_WRITE_MAY_WEIGH + 1)), await aStore(), { market: await aMarket() });
    expect(answer.status).toBe(413);
  });

  test("something that is not JSON is refused as not a request", async () => {
    const answer = await handle(post(ROUTES.writeChecks, "write me some checks"), await aStore(), { market: await aMarket() });
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ why: "that is not a request to write checks" });
  });

  test("a request missing what would prove it is refused in the same words the page uses", async () => {
    const answer = await handle(post(ROUTES.writeChecks, JSON.stringify({ ...COAT_REQUEST, statements: [] })), await aStore(), { market: await aMarket() });
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ why: "say at least one thing that would prove it works" });
  });

  test("a full server says so with 429 and starts nothing", async () => {
    const answer = await handle(post(ROUTES.writeChecks, JSON.stringify(COAT_REQUEST)), await aStore(), { market: await aMarket(0) });
    expect(answer.status).toBe(429);
  });

  test("asking after writing the server has never heard of, or has forgotten, is a 404 with a reason", async () => {
    const answer = await handle(get(writingPath("not-a-real-id")), await aStore(), { market: await aMarket() });
    expect(answer.status).toBe(404);
    expect(await answer.json()).toEqual({ why: "those checks are not being written here any more" });
  });
});

describe("whether a name is taken", () => {
  test("a name nobody has is free, and one on the wall is taken", async () => {
    const store = await aStore();
    expect(await (await handle(get(jobNamePath("nobody-has-this")), store)).json()).toEqual({ taken: false });

    const { openJob } = await import("../publish.ts");
    await openJob(store, {
      jobId: "somebody-has-this", seal: `0x${"ab".repeat(32)}`,
      spec: { idea: "A page", mode: "flash", price: 1n, checks: [], allowed: [], salt: "s" },
      endsAt: new Date("2026-10-01T00:00:00Z"), seats: [],
    });
    expect(await (await handle(get(jobNamePath("somebody-has-this")), store)).json()).toEqual({ taken: true });
  });

  test("a name that could reach outside the jobs folder is refused, not looked up", async () => {
    // an encoded slash survives URL parsing, which a plain ".." would not; this is the one that arrives
    const answer = await handle(get(jobNamePath("..%2F.env")), await aStore());
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ why: "..%2F.env is not a name a job can have" });
  });
});

describe("a posting at the door", () => {
  test("one that declares itself larger than any set of checks is refused before it is read", async () => {
    const answer = await handle(
      post(ROUTES.postJob, "{}", { "content-length": String(MOST_A_POSTING_MAY_WEIGH + 1) }),
      await aStore(), { market: await aMarket() },
    );
    expect(answer.status).toBe(413);
  });

  test("one in the wrong shape is a 400 that says what is wrong, not a crash", async () => {
    const answer = await handle(post(ROUTES.postJob, JSON.stringify({ jobId: "a-coat" })), await aStore(), { market: await aMarket() });
    expect(answer.status).toBe(400);
    expect((await answer.json() as { why: string }).why.length).toBeGreaterThan(0);
  });
});
