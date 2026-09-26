import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPublicClient, http, type PublicClient, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { podJobsAbi } from "../jobs.ts";
import { politeHttp } from "../rpc.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";

/**
 * A node that turns bursts away, the way Monad's public node does, and a client that waits it out.
 *
 * Found on the first run on Monad testnet: the job list read many things at once, the node answered
 * "requests limited to 15/sec" with an error of its own rather than HTTP's "too many requests", and
 * the list failed for every agent. The node here stands in front of a real local chain and refuses in
 * exactly those words, above a few requests a second.
 */

const available = await anvilAvailable();

/** how many requests a second the stand-in node answers before it turns them away */
const LIMIT_PER_SECOND = 5;
const BURST = 30;

let anvil: Anvil;
let jobs: `0x${string}`;
let node: ReturnType<typeof Bun.serve> | undefined;
let nodeUrl = "";
let turnedAway = 0;
let answered: string[] = [];

beforeAll(async () => {
  if (!available) return;
  anvil = await startAnvil();
  jobs = await anvil.deploy("PodJobs", [privateKeyToAccount(ANVIL_KEYS[6]).address]);
  const recent: number[] = [];
  node = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as { id: number; method: string };
      const now = Date.now();
      while (recent.length > 0 && now - (recent[0] ?? now) >= 1000) recent.shift();
      if (recent.length >= LIMIT_PER_SECOND) {
        turnedAway++;
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32011, message: `requests limited to ${LIMIT_PER_SECOND}/sec` } });
      }
      recent.push(now);
      answered.push(body.method);
      return fetch(anvil.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    },
  });
  nodeUrl = `http://127.0.0.1:${node.port}`;
}, 60_000);

afterAll(() => {
  node?.stop(true);
  anvil?.stop();
});

const clientOf = (transport: Transport): PublicClient => createPublicClient({ transport }) as PublicClient;
const aBurst = (client: PublicClient): Promise<PromiseSettledResult<bigint>[]> =>
  Promise.allSettled(Array.from({ length: BURST }, () => client.getBalance({ address: "0x0000000000000000000000000000000000000001" })));

describe.skipIf(!available)("a node that turns bursts away", () => {
  test("a plain client loses reads in a burst: the node really does turn them away", async () => {
    turnedAway = 0;
    const settled = await aBurst(clientOf(http(nodeUrl, { retryCount: 0 })));
    expect(settled.filter((result) => result.status === "rejected").length).toBeGreaterThan(0);
    expect(turnedAway).toBeGreaterThan(0);
  }, 60_000);

  test("the polite client waits and asks again, and every read in the burst comes back", async () => {
    turnedAway = 0;
    const settled = await aBurst(clientOf(politeHttp(nodeUrl)));
    expect(settled.filter((result) => result.status === "rejected")).toEqual([]);
    expect(turnedAway).toBeGreaterThan(0);
  }, 60_000);

  test("any other error is passed on at once, not asked again", async () => {
    await Bun.sleep(1_100); // a quiet node, so nothing here is turned away for the burst before
    answered = [];
    // a seat on a job that does not exist: the contract reverts, and the node answers with that error
    const reading = clientOf(politeHttp(nodeUrl)).readContract({ address: jobs, abi: podJobsAbi, functionName: "seatAt", args: [999n, 0, 0n] });
    await expect(reading).rejects.toThrow("reverted");
    expect(answered.filter((method) => method === "eth_call")).toHaveLength(1);
  }, 60_000);
});
