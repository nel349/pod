import { afterEach, describe, expect, test } from "bun:test";
import { defineChain, numberToHex, toHex, UnauthorizedProviderError, UnsupportedProviderMethodError, isHex, verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { endPasskeyWallet, holdPasskeyWallet, passkeyProvider } from "../web/shared/wallet/passkey/index.ts";

/**
 * The passkey wallet answers a page as a browser wallet does: it signs as its own address only, and
 * refuses what no page asks of it rather than doing half of it. Sending is tried for real in the
 * browser, against a chain (passkey-in-browser.test.ts); this is the part that needs no chain.
 */

const CHAIN = defineChain({
  id: 31337, name: "a local chain", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  // never reached: nothing here reads the chain
  rpcUrls: { default: { http: ["http://127.0.0.1:9"] } },
});
const provider = passkeyProvider(CHAIN);
const held = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey()).address;
const MESSAGE = toHex("this job is mine");

/** What a request was refused with: its EIP-1193 code. */
async function refusal(asked: Parameters<typeof provider.request>[0]): Promise<number | undefined> {
  try {
    await provider.request(asked);
    return undefined;
  } catch (error) {
    return error instanceof UnauthorizedProviderError || error instanceof UnsupportedProviderMethodError ? error.code : -1;
  }
}

afterEach(() => endPasskeyWallet());

describe("the passkey wallet, as a wallet in the page", () => {
  test("shows no account until one is open, then the open one, on its one chain", async () => {
    expect(await provider.request({ method: "eth_accounts" })).toEqual([]);
    holdPasskeyWallet({ account: held, end: () => undefined });
    expect(await provider.request({ method: "eth_accounts" })).toEqual([held.address]);
    expect(await provider.request({ method: "eth_chainId" })).toBe(numberToHex(CHAIN.id));
  });

  test("signs a note as its own address, and the signature is that address's", async () => {
    holdPasskeyWallet({ account: held, end: () => undefined });
    const signature = await provider.request({ method: "personal_sign", params: [MESSAGE, held.address] });
    if (typeof signature !== "string" || !isHex(signature)) throw new Error(`not a signature: ${String(signature)}`);
    expect(await verifyMessage({ address: held.address, message: { raw: MESSAGE }, signature })).toBe(true);
  });

  test("refuses to sign or send as another address, or with no wallet open", async () => {
    expect(await refusal({ method: "personal_sign", params: [MESSAGE, held.address] })).toBe(UnauthorizedProviderError.code);
    holdPasskeyWallet({ account: held, end: () => undefined });
    expect(await refusal({ method: "personal_sign", params: [MESSAGE, stranger] })).toBe(UnauthorizedProviderError.code);
    expect(await refusal({ method: "eth_sendTransaction", params: [{ from: stranger, to: held.address, value: "0x1" }] })).toBe(UnauthorizedProviderError.code);
  });

  test("refuses what no page asks of it", async () => {
    holdPasskeyWallet({ account: held, end: () => undefined });
    expect(await refusal({ method: "eth_signTypedData_v4", params: [held.address, "{}"] })).toBe(UnsupportedProviderMethodError.code);
    expect(await refusal({ method: "eth_sign", params: [held.address, MESSAGE] })).toBe(UnsupportedProviderMethodError.code);
  });

  test("stays on its one chain", async () => {
    expect(await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(CHAIN.id) }] })).toBeNull();
    await expect(provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(1) }] })).rejects.toThrow("only");
  });
});
