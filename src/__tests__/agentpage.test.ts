import { describe, expect, test } from "bun:test";
import { recordByRole, renderAgent } from "../agentpage.ts";
import type { Tile } from "../gallery.ts";

const AGENT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

const tile = (over: Partial<Tile> = {}): Tile => ({
  jobId: "one",
  idea: "a thing that was built",
  mode: "flash",
  verdict: "passed",
  price: 10_000_000_000_000_000_000n,
  pod: [{ role: "lead", agent: AGENT, owner: AGENT }],
  finishedAt: "2026-09-17T10:00:00.000Z",
  ...over,
});

describe("an agent's record, seat by seat", () => {
  test("it counts outcomes under the seat that was held, not overall", () => {
    const record = recordByRole(AGENT, [
      tile({ jobId: "a", verdict: "passed" }),
      tile({ jobId: "b", verdict: "failed" }),
      tile({ jobId: "c", verdict: "passed", pod: [{ role: "reviewer", agent: AGENT, owner: AGENT }] }),
    ]);

    expect(record.find((r) => r.role === "lead")).toMatchObject({ passed: 1, failed: 1, unreproducible: 0 });
    expect(record.find((r) => r.role === "reviewer")).toMatchObject({ passed: 1, failed: 0 });
  });

  test("a seat somebody else held is not this agent's record", () => {
    const record = recordByRole(AGENT, [tile({ pod: [{ role: "lead", agent: OTHER, owner: OTHER }] })]);
    expect(record).toEqual([]);
  });

  test("an address written in another case is the same address", () => {
    const record = recordByRole(AGENT.toUpperCase().replace("0X", "0x"), [tile()]);
    expect(record).toHaveLength(1);
  });

  test("a job that has not finished counts as running, not as a pass", () => {
    const record = recordByRole(AGENT, [tile({ verdict: "running" })]);
    expect(record[0]).toMatchObject({ passed: 0, failed: 0, running: 1 });
  });
});

describe("the page an agent gets", () => {
  test("it names the agent and shows failures as plainly as passes", () => {
    const html = renderAgent(AGENT, [tile({ jobId: "a" }), tile({ jobId: "b", verdict: "failed" })]);
    expect(html).toContain(AGENT);
    expect(html).toContain("<th>failed</th>");
    expect(html).toContain("checks failed");
    expect(html).not.toContain("Bring an idea");
  });

  test("an agent with nothing published says so, without calling it a judgement", () => {
    const html = renderAgent(AGENT, []);
    expect(html).toContain("has not finished a job on this server");
    expect(html).not.toContain("<article");
  });

  test("it says the chain's record is not what is on the page", () => {
    expect(renderAgent(AGENT, [tile()])).toContain("not what this page is showing yet");
  });
});
