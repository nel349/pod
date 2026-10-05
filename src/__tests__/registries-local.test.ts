import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  agentWalletOf, feedbackFrom, identityRegistryOf, ownerOfAgent, record, registerAgent, reputationAbi, requestValidation, verdictOnChain,
  writeFeedback, writeVerdict,
  type Registries,
} from "../registry.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { deployRegistries } from "./support/registries.ts";

/**
 * Our registry client against the ERC-8004 team's own contracts, pinned, on a local chain.
 *
 * Everything the worker and the reference agent do with ERC-8004 is tested against these, so this is
 * the check that they are the registries we think they are: the validation registry answers to the
 * identity registry, an identity belongs to whoever registered it, only its owner may ask, and only
 * the runner an ask names may answer it.
 */

const available = await anvilAvailable();
let anvil: Anvil;
let at: Registries;

beforeAll(async () => {
  if (!available) return;
  anvil = await startAnvil();
  at = await deployRegistries(anvil);
}, 120_000);

afterAll(() => anvil?.stop());

const as = (key: `0x${string}`) => ({ publicClient: anvil.publicClient, wallet: anvil.wallet(key) });
const RUNNER = ANVIL_KEYS[6];
const EVIDENCE = "http://pod.test/receipt/a-coat";

describe.skipIf(!available)("the ERC-8004 registries, as deployed locally", () => {
  test("the validation registry answers to the identity registry, and an identity is its registrant's", async () => {
    expect(await identityRegistryOf(anvil.publicClient, at)).toBe(at.identity);
    const { agentId } = await registerAgent(as(ANVIL_KEYS[2]), at);
    expect(await ownerOfAgent(anvil.publicClient, agentId, at)).toBe(privateKeyToAccount(ANVIL_KEYS[2]).address);
    // version 2 records the wallet an agent acts with, which starts as its registrant
    expect(await agentWalletOf(anvil.publicClient, agentId, at)).toBe(privateKeyToAccount(ANVIL_KEYS[2]).address);
  }, 60_000);

  test("an owner asks, the runner it named answers, and the record counts it under its tag", async () => {
    const owner = as(ANVIL_KEYS[3]);
    const { agentId } = await registerAgent(owner, at);
    const runner = privateKeyToAccount(RUNNER).address;
    const key = `0x${"12".repeat(32)}` as const;
    await requestValidation(owner, { runner, agentId, evidenceURI: EVIDENCE, key }, at);
    expect((await verdictOnChain(anvil.publicClient, key, at)).responseHash).toBe(`0x${"0".repeat(64)}`);

    await writeVerdict(as(RUNNER), { key, score: 100, receiptURI: EVIDENCE, receiptHash: `0x${"34".repeat(32)}`, tag: "pod.tests.builder" }, at);
    const answered = await verdictOnChain(anvil.publicClient, key, at);
    expect(answered.response).toBe(100);
    expect(answered.responseHash).toBe(`0x${"34".repeat(32)}`);
    expect(await record(anvil.publicClient, agentId, "pod.tests.builder", [runner], at)).toEqual({ count: 1, average: 100 });
  }, 60_000);

  test("nobody but the owner may ask, and nobody but the named runner may answer", async () => {
    const { agentId } = await registerAgent(as(ANVIL_KEYS[4]), at);
    const runner = privateKeyToAccount(RUNNER).address;
    await expect(requestValidation(as(ANVIL_KEYS[5]), { runner, agentId, evidenceURI: EVIDENCE, key: `0x${"56".repeat(32)}` }, at)).rejects.toThrow();

    const key = `0x${"78".repeat(32)}` as const;
    await requestValidation(as(ANVIL_KEYS[4]), { runner, agentId, evidenceURI: EVIDENCE, key }, at);
    await expect(writeVerdict(as(ANVIL_KEYS[5]), { key, score: 100, receiptURI: EVIDENCE, receiptHash: `0x${"9a".repeat(32)}`, tag: "pod.tests.qa" }, at)).rejects.toThrow();
  }, 60_000);

  test("a key once asked for is nobody else's to ask with", async () => {
    const first = await registerAgent(as(ANVIL_KEYS[1]), at);
    const second = await registerAgent(as(ANVIL_KEYS[2]), at);
    const runner = privateKeyToAccount(RUNNER).address;
    const key = `0x${"bc".repeat(32)}` as const;
    await requestValidation(as(ANVIL_KEYS[1]), { runner, agentId: first.agentId, evidenceURI: EVIDENCE, key }, at);
    await expect(requestValidation(as(ANVIL_KEYS[2]), { runner, agentId: second.agentId, evidenceURI: EVIDENCE, key }, at)).rejects.toThrow();
  }, 60_000);
});

describe.skipIf(!available)("the reputation registry, where POD writes what a seat did", () => {
  const RECEIPT = `0x${"56".repeat(32)}` as const;
  const entry = (agentId: bigint, over: { readonly score?: number; readonly tag?: string } = {}) => ({
    agentId, score: over.score ?? 100, tag: over.tag ?? "pod.reviewer", site: "http://pod.test", receiptURI: EVIDENCE, receiptHash: RECEIPT,
  });

  test("it is the ERC-8004 team's own, wired to the same identities", async () => {
    expect(await anvil.publicClient.readContract({ address: at.reputation, abi: reputationAbi, functionName: "getIdentityRegistry" })).toBe(at.identity);
    expect(await anvil.publicClient.readContract({ address: at.reputation, abi: reputationAbi, functionName: "getVersion" })).toBe("2.0.0");
  }, 60_000);

  test("the grader writes a seat's verdict with nothing asked of the agent or its owner, and it reads back", async () => {
    const { agentId } = await registerAgent(as(ANVIL_KEYS[2]), at);
    const grader = privateKeyToAccount(RUNNER).address;
    expect(await feedbackFrom(anvil.publicClient, agentId, grader, at)).toEqual([]);

    await writeFeedback(as(RUNNER), entry(agentId), at);
    await writeFeedback(as(RUNNER), entry(agentId, { score: 0, tag: "pod.builder" }), at);
    expect(await feedbackFrom(anvil.publicClient, agentId, grader, at)).toEqual([
      { score: 100, tag: "pod.reviewer" },
      { score: 0, tag: "pod.builder" },
    ]);
  }, 60_000);

  test("an agent's own owner is refused, which is why an entry here is one it could not have written", async () => {
    const owner = as(ANVIL_KEYS[3]);
    const { agentId } = await registerAgent(owner, at);
    await expect(writeFeedback(owner, entry(agentId), at)).rejects.toThrow(/Self-feedback not allowed/);
    expect(await feedbackFrom(anvil.publicClient, agentId, privateKeyToAccount(ANVIL_KEYS[3]).address, at)).toEqual([]);
  }, 60_000);

  test("what somebody else writes about an agent is not read as the grader's", async () => {
    const { agentId } = await registerAgent(as(ANVIL_KEYS[4]), at);
    // a stranger may write, since anybody but the owner can; a reader who names the grader never sees it
    await writeFeedback(as(ANVIL_KEYS[5]), entry(agentId, { score: 100 }), at);
    expect(await feedbackFrom(anvil.publicClient, agentId, privateKeyToAccount(RUNNER).address, at)).toEqual([]);
    expect(await feedbackFrom(anvil.publicClient, agentId, privateKeyToAccount(ANVIL_KEYS[5]).address, at)).toEqual([{ score: 100, tag: "pod.reviewer" }]);
  }, 60_000);

  test("an identity that was never registered cannot be written about", async () => {
    await expect(writeFeedback(as(RUNNER), entry(999_999n), at)).rejects.toThrow();
  }, 60_000);
});
