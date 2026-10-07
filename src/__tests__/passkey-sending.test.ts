import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { defineChain, numberToHex, parseEther, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  EndpointHasNotCaughtUp, onWalletWaits, sendWithCare, WalletIsShort, walletWaits, type Sending, type WalletWaits,
} from "../web/shared/wallet/passkey/index.ts";

/**
 * A payment from the passkey wallet, through an endpoint that refuses a wallet it has not caught up
 * with and then goes on refusing it, as Monad's public endpoint was measured to on 6 October 2026.
 *
 * The endpoints here are stand-ins that behave as that one was seen to: they are the third party,
 * which is not what is being tested. What is tested is the wallet: that it never sends for a wallet
 * that cannot pay, waits when the money is new, and goes round an endpoint that refuses a wallet
 * which holds the money. The signing is real, and so is every request.
 */

const signer = privateKeyToAccount(generatePrivateKey());
const PAYEE = "0x00000000000000000000000000000000000000aa";
const LATEST = 1000n;
const GAS = 21_000n;
const BASE_FEE = 100_000_000_000n;
const REFUSAL = { code: -32000, message: "Signer had insufficient balance" };

interface Endpoint {
  readonly url: string;
  /** every raw transaction it was asked to send, taken or not */
  readonly asked: Hex[];
  readonly stop: () => void;
}

/**
 * A node, as far as a wallet asks one: what the wallet holds now and held some blocks ago, what a
 * payment would cost, and whether it takes a raw transaction or says the signer is short.
 */
function endpoint(state: { holdsNow: bigint; heldBefore: bigint; takes: boolean; pricesIt?: () => boolean }): Endpoint {
  const asked: Hex[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { id, method, params } = await request.json() as { id: number; method: string; params: unknown[] };
      const answer = (result: unknown): Response => Response.json({ jsonrpc: "2.0", id, result });
      const refuse = (): Response => Response.json({ jsonrpc: "2.0", id, error: REFUSAL });
      switch (method) {
        case "eth_chainId": return answer(numberToHex(CHAIN_ID));
        case "eth_blockNumber": return answer(numberToHex(LATEST));
        case "eth_getTransactionCount": return answer("0x0");
        case "eth_maxPriorityFeePerGas": return answer(numberToHex(2_000_000_000n));
        case "eth_getBlockByNumber": return answer({ number: numberToHex(LATEST), baseFeePerGas: numberToHex(BASE_FEE), timestamp: "0x1", transactions: [] });
        case "eth_estimateGas": return state.pricesIt?.() === false ? Response.json({ jsonrpc: "2.0", id, error: { code: -32000, message: "insufficient balance" } }) : answer(numberToHex(GAS));
        case "eth_getBalance": return answer(numberToHex(params[1] === numberToHex(LATEST) || params[1] === "latest" ? state.holdsNow : state.heldBefore));
        case "eth_sendRawTransaction": {
          asked.push(params[0] as Hex);
          return state.takes ? answer(`0x${"ab".repeat(32)}`) : refuse();
        }
        default: return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `this stand-in does not answer ${method}` } });
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, asked, stop: () => void server.stop(true) };
}

const CHAIN_ID = 10143;
const chainThrough = (url: string) => defineChain({
  id: CHAIN_ID, name: "Monad testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [url] } },
});
/** a moment short enough for a test, and long enough to see the wallet say it is waiting */
const SETTLES = { settledAfterBlocks: 25, settledAfterSeconds: 0.2 } as const;
const PAYMENT = { to: PAYEE, value: parseEther("1.15") } as const;
const PLENTY = parseEther("10");

const made: Endpoint[] = [];
const an = (state: Parameters<typeof endpoint>[0]): Endpoint => { const one = endpoint(state); made.push(one); return one; };
afterAll(() => made.forEach((one) => one.stop()));

/** What the wallet said it was waiting for while a payment was on its way, in order. */
function listening(): { readonly said: WalletWaits[]; readonly stop: () => void } {
  const said: WalletWaits[] = [];
  const stop = onWalletWaits(() => { const now = walletWaits(); if (now) said.push(now); });
  return { said, stop };
}
let heard: ReturnType<typeof listening> | undefined;
afterEach(() => { heard?.stop(); heard = undefined; });

describe("a payment from the passkey wallet, through an endpoint that has to be allowed for", () => {
  test("a wallet that has held the money a while is sent at once, and says nothing", async () => {
    const node = an({ holdsNow: PLENTY, heldBefore: PLENTY, takes: true });
    heard = listening();
    const started = Date.now();
    const hash = await sendWithCare(signer, chainThrough(node.url), PAYMENT, SETTLES);
    expect(hash).toBe(`0x${"ab".repeat(32)}`);
    expect(Date.now() - started).toBeLessThan(SETTLES.settledAfterSeconds * 1000);
    expect(heard.said).toEqual([]);
    // what was sent is the payment asked for, signed by the wallet itself
    expect(node.asked).toHaveLength(1);
    const [raw] = node.asked;
    if (raw === undefined) throw new Error("nothing was sent");
    expect(parseTransaction(raw).value).toBe(PAYMENT.value);
    expect(await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` })).toBe(signer.address);
  });

  test("a wallet that cannot pay is told what it holds, and the endpoint is never asked to send for it", async () => {
    const empty = an({ holdsNow: 0n, heldBefore: 0n, takes: false, pricesIt: () => false });
    const sent = sendWithCare(signer, chainThrough(empty.url), PAYMENT, SETTLES);
    await expect(sent).rejects.toBeInstanceOf(WalletIsShort);
    await expect(sent).rejects.toThrow(`this wallet, ${signer.address}, holds 0 MON, and this takes 1.15 MON, and gas on top`);
    // an ask would have been remembered by the endpoint, and held against the wallet once it was funded
    expect(empty.asked).toEqual([]);

    // enough for the payment and not for its gas is short as well, and is not sent either
    const nearly = an({ holdsNow: PAYMENT.value, heldBefore: PAYMENT.value, takes: false });
    await expect(sendWithCare(signer, chainThrough(nearly.url), PAYMENT, SETTLES)).rejects.toThrow("with its gas");
    expect(nearly.asked).toEqual([]);
  });

  test("money that has only just arrived is given its moment before the endpoint is asked", async () => {
    const node = an({ holdsNow: PLENTY, heldBefore: 0n, takes: true });
    heard = listening();
    const started = Date.now();
    await sendWithCare(signer, chainThrough(node.url), PAYMENT, SETTLES);
    expect(Date.now() - started).toBeGreaterThanOrEqual(SETTLES.settledAfterSeconds * 1000);
    expect(heard.said).toEqual(["settling"]);
    expect(node.asked).toHaveLength(1);
    // and it is no longer waiting once the payment is on its way
    expect(walletWaits()).toBeUndefined();
  });

  test("refused while it holds the money, the same signed payment goes through the other endpoint", async () => {
    const refusing = an({ holdsNow: PLENTY, heldBefore: PLENTY, takes: false });
    const other = an({ holdsNow: PLENTY, heldBefore: PLENTY, takes: true });
    heard = listening();
    const hash = await sendWithCare(signer, chainThrough(refusing.url), PAYMENT, { ...SETTLES, otherRpc: other.url });
    expect(hash).toBe(`0x${"ab".repeat(32)}`);
    expect(heard.said).toEqual(["another way"]);
    // the same transaction, byte for byte: whichever endpoint takes it, it can be taken only once
    expect(refusing.asked).toHaveLength(1);
    expect(other.asked).toEqual(refusing.asked);
  });

  test("refused by every endpoint, the person is told it is the network and when to try again", async () => {
    const refusing = an({ holdsNow: PLENTY, heldBefore: PLENTY, takes: false });
    const other = an({ holdsNow: PLENTY, heldBefore: PLENTY, takes: false });
    const both = sendWithCare(signer, chainThrough(refusing.url), PAYMENT, { ...SETTLES, otherRpc: other.url });
    await expect(both).rejects.toBeInstanceOf(EndpointHasNotCaughtUp);
    await expect(both).rejects.toThrow("Monad testnet has not caught up with the money in this wallet");
    // with no other endpoint named, the same is said at once
    const alone = an({ holdsNow: PLENTY, heldBefore: PLENTY, takes: false });
    await expect(sendWithCare(signer, chainThrough(alone.url), PAYMENT, SETTLES)).rejects.toBeInstanceOf(EndpointHasNotCaughtUp);
    expect(walletWaits()).toBeUndefined();
  });

  test("a refusal about anything else is passed on as it was said, and nothing is sent twice", async () => {
    const sending: Sending = { ...SETTLES, otherRpc: an({ holdsNow: PLENTY, heldBefore: PLENTY, takes: true }).url };
    const odd = endpointThatSays("nonce too low");
    made.push(odd);
    await expect(sendWithCare(signer, chainThrough(odd.url), PAYMENT, sending)).rejects.toThrow("nonce too low");
    expect(odd.asked).toHaveLength(1);
  });

  test("where the market names nothing to allow for, a payment is simply sent", async () => {
    // money that is new, and no waiting: a single node knows what it mined
    const node = an({ holdsNow: PLENTY, heldBefore: 0n, takes: true });
    heard = listening();
    const started = Date.now();
    await sendWithCare(signer, chainThrough(node.url), PAYMENT, undefined);
    expect(Date.now() - started).toBeLessThan(SETTLES.settledAfterSeconds * 1000);
    expect(heard.said).toEqual([]);
    expect(node.asked).toHaveLength(1);
  });
});

/** An endpoint that takes no payment and gives its own reason, which is not about money. */
function endpointThatSays(words: string): Endpoint {
  const inner = endpoint({ holdsNow: PLENTY, heldBefore: PLENTY, takes: true });
  const asked: Hex[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text();
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      if (method === "eth_sendRawTransaction") {
        asked.push(params[0] as Hex);
        return Response.json({ jsonrpc: "2.0", id, error: { code: -32000, message: words } });
      }
      return fetch(inner.url, { method: "POST", headers: { "content-type": "application/json" }, body });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, asked, stop: () => { server.stop(true); inner.stop(); } };
}
