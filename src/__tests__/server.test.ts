import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle } from "../server.ts";
import { JobStore, type JobRecord } from "../store.ts";
import { ROUTES, cardPath, checkFilePath, checksPath, jobPath, receiptPath } from "../routes.ts";
import type { Tile } from "../gallery.ts";

const LEAD = "0x1111111111111111111111111111111111111111" as const;
const BUILDER = "0x2222222222222222222222222222222222222222" as const;
const STRANGER = "0x3333333333333333333333333333333333333333" as const;

function tile(over: Partial<Tile> = {}): Tile {
  return {
    jobId: "a-weather-page",
    idea: "A page that tells me whether to take a coat",
    mode: "flash",
    verdict: "passed",
    open: "https://example.test/coat",
    commit: "c0ffee1234",
    seconds: 61,
    price: 25_000_000_000_000_000_000n,
    pod: [
      { role: "lead", agent: LEAD, owner: LEAD },
      { role: "builder", agent: BUILDER, owner: BUILDER },
    ],
    finishedAt: "2026-09-17T10:00:00.000Z",
    ...over,
  };
}

function record(over: Partial<JobRecord> = {}): JobRecord {
  const base = tile(over.tile);
  return {
    jobId: base.jobId,
    seal: `0x${"ab".repeat(32)}`,
    tile: base,
    checksSaid: [
      { says: "the page answers", hidden: false, exitCode: 0 },
      { says: "a cold day says take a coat", hidden: true, exitCode: 0 },
    ],
    approvals: [{ role: "lead", agent: LEAD, commit: "c0ffee1234", at: "2026-09-17T09:58:00.000Z" }],
    ...over,
  };
}

async function storeWith(...records: readonly JobRecord[]): Promise<JobStore> {
  const store = new JobStore(await mkdtemp(join(tmpdir(), "pod-store-")));
  for (const r of records) {
    await store.save(r, { "loads.mjs": "// asks the page for a page\n", "cold.mjs": "// the hidden one\n" });
  }
  return store;
}

const get = (store: JobStore, path: string): Promise<Response> =>
  handle(new Request(`http://pod.test${path}`), store);

describe("the wall", () => {
  test("an empty wall says it is empty rather than looking broken", async () => {
    const response = await get(await storeWith(), ROUTES.wall);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("Nothing has been built yet");
    expect(body).not.toContain("<article");
  });

  test("it shows what it is given, failures included, newest first", async () => {
    const store = await storeWith(
      record({ tile: tile({ jobId: "older", finishedAt: "2026-09-16T10:00:00.000Z" }) }),
      record({ tile: tile({ jobId: "newer", verdict: "failed", finishedAt: "2026-09-17T10:00:00.000Z" }) }),
    );
    const body = await (await get(store, ROUTES.wall)).text();
    expect(body.indexOf(jobPath("newer"))).toBeLessThan(body.indexOf(jobPath("older")));
    expect(body).toContain("checks failed");
    expect(body).toContain("1 paid");
    expect(body).toContain("1 refused");
  });

  test("what is running is at the top, then what happened, newest first", async () => {
    const store = await storeWith(
      record({ tile: tile({ jobId: "older", finishedAt: "2026-09-16T10:00:00.000Z" }) }),
      record({ tile: tile({ jobId: "newer", finishedAt: "2026-09-17T10:00:00.000Z" }) }),
      record({ tile: tile({ jobId: "happening-now", verdict: "running", finishedAt: undefined }) }),
    );
    const body = await (await get(store, ROUTES.wall)).text();
    expect(body.indexOf(jobPath("happening-now"))).toBeLessThan(body.indexOf(jobPath("newer")));
    expect(body.indexOf(jobPath("newer"))).toBeLessThan(body.indexOf(jobPath("older")));
  });

  test("an agent's page holds only the jobs it sat on", async () => {
    const store = await storeWith(record());
    const mine = await (await get(store, `${ROUTES.agent}${BUILDER}`)).text();
    expect(mine).toContain("A page that tells me whether to take a coat");

    const theirs = await (await get(store, `${ROUTES.agent}${STRANGER}`)).text();
    expect(theirs).not.toContain("A page that tells me whether to take a coat");

    expect((await get(store, `${ROUTES.agent}not-an-address`)).status).toBe(404);
  });
});

describe("one job, opened", () => {
  test("it carries the evidence, and points at the checks anyone can fetch", async () => {
    const store = await storeWith(record());
    const response = await get(store, jobPath("a-weather-page"));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("the page answers");
    expect(body).toContain("hidden from the pod");
    expect(body).toContain(checksPath("a-weather-page"));
  });

  test("a job that has a repository links it, and says what is in it", async () => {
    const store = await storeWith(record({ repository: "https://github.com/kuiralabs/pod-a-weather-page" }));
    const body = await (await get(store, jobPath("a-weather-page"))).text();
    expect(body).toContain("The work itself");
    expect(body).toContain("https://github.com/kuiralabs/pod-a-weather-page");
    expect(body).toContain("including the ones that failed");
  });

  test("a job with no receipt says so instead of showing one", async () => {
    const store = await storeWith(record());
    expect(await (await get(store, jobPath("a-weather-page"))).text()).not.toContain("Check it yourself");
    expect((await get(store, receiptPath("a-weather-page"))).status).toBe(404);
  });

  test("a job still open says what is being asked for, and what is sealed", async () => {
    const store = await storeWith(record({
      tile: tile({ verdict: "running" }),
      brief: {
        asked: "A page that tells me whether to take a coat, from my postcode",
        endsAt: "2026-09-18T10:00:00.000Z",
        sealedChecks: 2,
        seats: [{ role: "lead", taken: true }, { role: "builder", taken: true }, { role: "security", taken: false }],
      },
    }));

    const body = await (await get(store, jobPath("a-weather-page"))).text();
    expect(body).toContain("What is being asked for");
    expect(body).toContain("from my postcode");
    expect(body).toContain("2 checks are sealed until there is a verdict");
    expect(body).toContain("security · open");
  });

  test("a graded job is described by its receipt, not by a brief", async () => {
    const store = await storeWith(record({
      brief: {
        asked: "A page that tells me whether to take a coat",
        endsAt: "2026-09-18T10:00:00.000Z",
        sealedChecks: 2,
        seats: [{ role: "lead", taken: true }],
      },
    }));
    const body = await (await get(store, jobPath("a-weather-page"))).text();
    expect(body).not.toContain("What is being asked for");
  });

  test("a job the runs disagreed on says what that means for the money", async () => {
    const store = await storeWith(record({ tile: tile({ verdict: "not-reproducible" }) }));
    const body = await (await get(store, jobPath("a-weather-page"))).text();
    expect(body).toContain("The runs disagreed");
    expect(body).toContain("nothing was settled");
    expect(body).toContain("when the job's window closes");
  });

  test("a job nobody posted is a 404 that names what was asked for", async () => {
    const response = await get(await storeWith(record()), jobPath("never-happened"));
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("never-happened");
  });
});

describe("the checks a stranger fetches", () => {
  test("both the visible and the hidden one are published once there is a verdict", async () => {
    const store = await storeWith(record());
    const index = await (await get(store, checksPath("a-weather-page"))).text();
    expect(index).toContain(checkFilePath("a-weather-page", "loads.mjs"));
    expect(index).toContain(checkFilePath("a-weather-page", "cold.mjs"));

    const hidden = await get(store, checkFilePath("a-weather-page", "cold.mjs"));
    expect(hidden.status).toBe(200);
    expect(await hidden.text()).toContain("the hidden one");
  });

  test("while the job is still running they are refused, and the refusal says why", async () => {
    const store = await storeWith(record({ tile: tile({ verdict: "running" }) }));
    const response = await get(store, checksPath("a-weather-page"));
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("published when it has a verdict");
    expect((await get(store, checkFilePath("a-weather-page", "cold.mjs"))).status).toBe(404);
  });

  test("a job graded again does not publish a check from the run before", async () => {
    const store = await storeWith(record());
    expect((await get(store, checkFilePath("a-weather-page", "cold.mjs"))).status).toBe(200);

    // the second grading had one check, not two
    await store.save(record(), { "loads.mjs": "// the only check this time\n" });

    const index = await (await get(store, checksPath("a-weather-page"))).text();
    expect(index).toContain(checkFilePath("a-weather-page", "loads.mjs"));
    expect(index).not.toContain("cold.mjs");
    expect((await get(store, checkFilePath("a-weather-page", "cold.mjs"))).status).toBe(404);
  });

  test("a path that climbs out of the job's directory is refused", async () => {
    const store = await storeWith(record());
    for (const climb of ["..%2F..%2Fjob.json", "..", "%2Fetc%2Fpasswd"]) {
      expect((await get(store, `${checksPath("a-weather-page")}/${climb}`)).status).toBe(404);
    }
    expect((await get(store, `${ROUTES.job}../../etc/passwd`)).status).toBe(404);
  });
});

describe("the server itself", () => {
  test("the stylesheet the pages ask for is the stylesheet it serves", async () => {
    const store = await storeWith(record());
    const page = await (await get(store, ROUTES.wall)).text();
    expect(page).toContain(`href="${ROUTES.style}"`);
    const css = await get(store, ROUTES.style);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain(".tile");
  });

  test("a job's card is an image, and the page points at it", async () => {
    const store = await storeWith(record());
    const card = await get(store, cardPath("a-weather-page"));
    expect(card.status).toBe(200);
    expect(card.headers.get("content-type")).toContain("image/svg+xml");
    expect(await card.text()).toContain("checks passed");

    const page = await (await get(store, jobPath("a-weather-page"))).text();
    expect(page).toContain(`content="${cardPath("a-weather-page")}"`);

    expect((await get(store, cardPath("never-happened"))).status).toBe(404);
  });

  test("it answers reads only", async () => {
    const store = await storeWith(record());
    const posted = await handle(new Request(`http://pod.test${ROUTES.wall}`, { method: "POST" }), store);
    expect(posted.status).toBe(405);
  });
});
