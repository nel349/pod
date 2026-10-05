import { describe, expect, test } from "bun:test";
import { mnemonicToAccount } from "viem/accounts";
import { accountAt, PERSON_ACCOUNT, recoveryPhraseOf } from "../web/shared/wallet/passkey/derive.ts";

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

  test("anything but a passkey's 32 bytes is refused", () => {
    expect(() => recoveryPhraseOf(new Uint8Array(16))).toThrow("32 bytes");
  });
});
