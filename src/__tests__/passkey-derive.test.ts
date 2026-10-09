import { describe, expect, test } from "bun:test";
import { mnemonicToAccount } from "viem/accounts";
import { accountAt, agentAccount, agentKeyFrom, NotTheWalletsPasskey, PERSON_ACCOUNT, recoveryPhraseOf } from "../web/shared/wallet/passkey/derive.ts";

/**
 * A passkey's output becomes a recovery phrase and numbered accounts on the standard path, as Mera
 * recommends. Checked against viem's own implementation of the same standards, which shares no code
 * with this one beyond the word list, so a phrase written down restores the same wallet anywhere.
 */

const PRF = Uint8Array.from({ length: 32 }, (_, index) => index * 7 + 3);

describe("a passkey's output, as a wallet", () => {
  test("is a 24-word phrase, the same every time", () => {
    const phrase = recoveryPhraseOf(PRF);
    expect(phrase.split(" ")).toHaveLength(24);
    expect(recoveryPhraseOf(Uint8Array.from(PRF))).toBe(phrase);
  });

  test("the person's account is the one any standard wallet restores from the phrase", () => {
    const phrase = recoveryPhraseOf(PRF);
    const { address, session } = accountAt(phrase, PERSON_ACCOUNT);
    expect(address).toBe(mnemonicToAccount(phrase, { addressIndex: 0 }).address);
    session.end();
  });

  test("each number is its own key, unrelated to the person's", () => {
    const phrase = recoveryPhraseOf(PRF);
    const person = accountAt(phrase, PERSON_ACCOUNT);
    const another = accountAt(phrase, 1);
    expect(another.address).not.toBe(person.address);
    expect(another.address).toBe(mnemonicToAccount(phrase, { addressIndex: 1 }).address);
    person.session.end();
    another.session.end();
  });

  test("an agent's key is the account after the person's, a different one for each agent, and the same one every time", () => {
    const phrase = recoveryPhraseOf(PRF);
    const wallet = mnemonicToAccount(phrase, { addressIndex: 0 }).address;
    const first = agentKeyFrom(Uint8Array.from(PRF), 1, wallet);
    const second = agentKeyFrom(Uint8Array.from(PRF), 2, wallet);
    expect(first.address).toBe(mnemonicToAccount(phrase, { addressIndex: 1 }).address);
    expect(second.address).toBe(mnemonicToAccount(phrase, { addressIndex: 2 }).address);
    expect(new Set([wallet, first.address, second.address]).size).toBe(3);
    // made again, it is the same key: nothing has to be kept for it not to be lost
    const again = agentKeyFrom(Uint8Array.from(PRF), 1, wallet);
    expect(again.key).toBe(first.key);
    for (const made of [first, second, again]) made.session.end();
  });

  test("a passkey that is not the open wallet's gives no agent key", () => {
    const wallet = mnemonicToAccount(recoveryPhraseOf(PRF), { addressIndex: 0 }).address;
    const anotherPasskey = Uint8Array.from({ length: 32 }, (_, index) => index * 5 + 1);
    expect(() => agentKeyFrom(anotherPasskey, 1, wallet)).toThrow(NotTheWalletsPasskey);
  });

  test("agents are numbered from one: the person's own account is never handed out as an agent's", () => {
    expect(agentAccount(1)).toBe(PERSON_ACCOUNT + 1);
    for (const notOne of [0, -1, 1.5, Number.NaN]) expect(() => agentAccount(notOne)).toThrow("numbered from 1");
  });

  test("anything but a passkey's 32 bytes is refused", () => {
    expect(() => recoveryPhraseOf(new Uint8Array(16))).toThrow("32 bytes");
  });
});
