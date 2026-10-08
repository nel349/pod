import { afterAll, describe, expect, test } from "bun:test";
import { createPublicClient, defineChain, http, numberToHex } from "viem";
import { GAS_HEADROOM, gasAskedPlainly } from "../gas.ts";

/**
 * Asking a node what a call needs, the way it answers truthfully.
 *
 * The node here is a stand-in that answers as Monad's was measured to on 8 October 2026: the call's
 * real need when asked about the call alone, and many times more when the fee is stated with it. It
 * keeps every question it was asked, so the test can see how the question was put.
 */
const NEEDS = 56_742n;
const WITH_THE_FEE_STATED = 1_183_207n;
const CHAIN_ID = 10143;

const questions: Record<string, unknown>[] = [];
const node = Bun.serve({
  port: 0,
  async fetch(request) {
    const { id, method, params } = await request.json() as { id: number; method: string; params: unknown[] };
    const answer = (result: unknown): Response => Response.json({ jsonrpc: "2.0", id, result });
    if (method === "eth_chainId") return answer(numberToHex(CHAIN_ID));
    if (method === "eth_estimateGas") {
      const call = params[0] as Record<string, unknown>;
      questions.push(call);
      return answer(numberToHex(call.maxFeePerGas !== undefined || call.gasPrice !== undefined ? WITH_THE_FEE_STATED : NEEDS));
    }
    return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `this stand-in does not answer ${method}` } });
  },
});
afterAll(() => void node.stop(true));

const chain = defineChain({ id: CHAIN_ID, name: "a stand-in", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [`http://127.0.0.1:${node.port}`] } } });
const reads = createPublicClient({ chain, transport: http() });
const POSTER = "0x00000000000000000000000000000000000000b1";
const CONTRACT = "0x00000000000000000000000000000000000000c2";

describe("the gas stated for a call", () => {
  test("is what the node says the call alone needs, and a quarter over", async () => {
    questions.length = 0;
    const gas = await gasAskedPlainly(reads, { account: POSTER, to: CONTRACT, data: "0x1234abcd" });
    expect(gas).toBe((NEEDS * GAS_HEADROOM.times) / GAS_HEADROOM.over);
    expect(gas).toBe(70_927n);
  });

  test("is asked with no fee stated, which is the whole of the difference", async () => {
    questions.length = 0;
    await gasAskedPlainly(reads, { account: POSTER, to: CONTRACT, data: "0x1234abcd", value: 5n });
    expect(questions).toHaveLength(1);
    const [asked] = questions;
    expect(asked?.from).toBe(POSTER);
    expect(asked?.to).toBe(CONTRACT);
    expect(asked?.data).toBe("0x1234abcd");
    expect(asked?.value).toBe("0x5");
    expect(asked?.maxFeePerGas).toBeUndefined();
    expect(asked?.maxPriorityFeePerGas).toBeUndefined();
    expect(asked?.gasPrice).toBeUndefined();
  });

  test("the stand-in really does answer the other way when the fee is stated, so the test above means something", async () => {
    expect(await reads.estimateGas({ account: POSTER, to: CONTRACT, data: "0x1234abcd", maxFeePerGas: 100n })).toBe(WITH_THE_FEE_STATED);
  });
});
