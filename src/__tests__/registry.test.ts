import { describe, expect, test } from "bun:test";
import { decodeFunctionData, toHex } from "viem";
import {
  MONAD_TESTNET, agentWalletOf, approvePlatformCall, identityRegistryOf, ownerOfAgent, readOnlyClient, record,
  requestCall, validationAbi, verdictCall,
} from "../registry.ts";

const KEY = `0x${"11".repeat(32)}` as const;
const RECEIPT = `0x${"22".repeat(32)}` as const;
const RUNNER = "0x00000000000000000000000000000000000000aa" as const;

describe("what we send", () => {
  test("a seat's approval names the platform and grants it", () => {
    const data = approvePlatformCall(RUNNER);
    expect(data.startsWith("0xa22cb465")).toBe(true); // setApprovalForAll
    expect(data.toLowerCase()).toContain(RUNNER.slice(2).toLowerCase());
  });

  test("a request carries the runner, the agent, the evidence and the key", () => {
    const data = requestCall({ runner: RUNNER, agentId: 1873n, evidenceURI: "https://pod/job/7", key: KEY });
    const decoded = decodeFunctionData({ abi: validationAbi, data });
    expect(decoded.functionName).toBe("validationRequest");
    expect(String(decoded.args?.[0]).toLowerCase()).toBe(RUNNER);  // viem checksums it back
    expect(decoded.args?.[1]).toBe(1873n);
    expect(decoded.args?.[3]).toBe(KEY);
  });

  test("a verdict carries the score, the receipt and the role tag", () => {
    const data = verdictCall({ key: KEY, score: 100, receiptURI: "https://pod/receipt/7", receiptHash: RECEIPT, tag: "pod.tests" });
    const decoded = decodeFunctionData({ abi: validationAbi, data });
    expect(decoded.functionName).toBe("validationResponse");
    expect(decoded.args?.[1]).toBe(100);
    expect(decoded.args?.[4]).toBe("pod.tests");
  });

  test("a score outside 0 to 100 is refused before it reaches the chain", () => {
    const bad = { key: KEY, receiptURI: "u", receiptHash: RECEIPT, tag: "pod.tests" };
    expect(() => verdictCall({ ...bad, score: 101 })).toThrow("0 to 100");
    expect(() => verdictCall({ ...bad, score: -1 })).toThrow("0 to 100");
    expect(() => verdictCall({ ...bad, score: 99.5 })).toThrow("0 to 100");
  });
});

// These read the live testnet. They are skipped when it cannot be reached, so a flaky network
// never turns into a failing suite.
const live = await (async () => {
  try {
    const res = await fetch(MONAD_TESTNET.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(8000),
    });
    return ((await res.json()) as { result?: string }).result === "0x279f";
  } catch {
    return false;
  }
})();

describe.skipIf(!live)("against Monad testnet", () => {
  const client = readOnlyClient();

  test("the validation registry checks ownership against the identity registry we expect", async () => {
    expect(await identityRegistryOf(client)).toBe(MONAD_TESTNET.identityRegistry);
  }, 30_000);

  test("an agent that exists has an owner", async () => {
    const owner = await ownerOfAgent(client, 1n);
    expect(owner).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }, 30_000);

  test("an agent with no verdicts has an empty record rather than an error", async () => {
    const summary = await record(client, 1n, "pod.tests");
    expect(summary.count).toBe(0);
    expect(summary.average).toBe(0);
  }, 30_000);

  /**
   * What the worker and the reference agent depend on, against the registry as deployed rather than
   * the pinned copy the local tests run: simulated, so nothing is sent and nothing is spent.
   */
  test("the deployed registry takes an agent's own request for its verdict, and refuses it from anybody else", async () => {
    const owner = await ownerOfAgent(client, 1n);
    const ask = requestCall({
      runner: SOMEBODY_ELSE, agentId: 1n, evidenceURI: "https://pod.invalid/receipt/a-coat",
      key: toHex(crypto.getRandomValues(new Uint8Array(32))),
    });
    await client.call({ account: owner, to: MONAD_TESTNET.validationRegistry, data: ask });
    await expect(client.call({ account: SOMEBODY_ELSE, to: MONAD_TESTNET.validationRegistry, data: ask })).rejects.toThrow("Not authorized");
  }, 30_000);

  test("the deployed registry answers the two reads the worker makes: who a runner was asked by, and an identity's wallet", async () => {
    expect(Array.isArray(await client.readContract({
      address: MONAD_TESTNET.validationRegistry, abi: validationAbi, functionName: "getValidatorRequests", args: [SOMEBODY_ELSE],
    }))).toBe(true);
    expect(await agentWalletOf(client, 1n)).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }, 30_000);
});

/** An address that owns no agent here, the way a stranger asking in somebody else's name would look */
const SOMEBODY_ELSE = "0x000000000000000000000000000000000000dEaD" as const;
