/**
 * How a passkey becomes accounts, the way Mera recommends: the passkey's PRF output, 32 bytes that the
 * same passkey on the same site always gives back, is the entropy of a 24-word recovery phrase; the
 * phrase is the seed of a tree of numbered Ethereum accounts on the standard path. Account 0 is the
 * person's own wallet. Other numbers are other keys from the same passkey, each unrelated to the next.
 *
 * Because it is the standard phrase on the standard path, the phrase restores the same accounts in any
 * wallet that follows BIP-39 and BIP-44: the way out if the passkey is lost, or POD moves address.
 *
 * Pure: the same bytes always make the same phrase and the same accounts.
 */
import { createSecp256k1SigningSession, getEvmAddress, type EvmAddress, type Secp256k1SigningSession } from "@category-labs/mera";
import { hexToBytes, isAddressEqual, toHex, type Address, type Hex } from "viem";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

/** The person's own wallet: the first account on the path */
export const PERSON_ACCOUNT = 0;
/**
 * The account kept for the person's agent of this number: the first agent is the account after the
 * person's own, the second the one after that. Each is a key of its own, so an agent given one can
 * spend what that address holds and nothing of the person's.
 */
export function agentAccount(number: number): number {
  if (!Number.isInteger(number) || number < 1) throw new Error(`agents are numbered from 1, and ${number} is not one`);
  return PERSON_ACCOUNT + number;
}

/** how many bytes a passkey's PRF output is, and so how much entropy the phrase carries: 24 words */
const PRF_BYTES = 32;

/** The 24-word recovery phrase a passkey's PRF output stands for. */
export function recoveryPhraseOf(prfOutput: Uint8Array): string {
  if (prfOutput.length !== PRF_BYTES) throw new Error(`a passkey's output is ${PRF_BYTES} bytes, not ${prfOutput.length}`);
  return entropyToMnemonic(prfOutput, wordlist);
}

/** The Ethereum account at this number on the standard path, from the phrase. */
export const accountPath = (index: number): string => `m/44'/60'/0'/0/${index}`;

/** An account made from a phrase: its signing session, its address, and the key the session holds. */
export interface Derived {
  readonly session: Secp256k1SigningSession;
  readonly address: EvmAddress;
  /** this account's own key, which the tab keeps so a reload does not ask for the passkey again */
  readonly key: Hex;
}

/**
 * A signing session for the account at this number. The key lives in the session, which zeroes it
 * when ended; the seed it came from is zeroed here as soon as the key is taken from it.
 */
export function accountAt(phrase: string, index: number): Derived {
  const seed = mnemonicToSeedSync(phrase);
  try {
    const node = HDKey.fromMasterSeed(seed).derive(accountPath(index));
    if (!node.privateKey) throw new Error("the path gave no key");
    const key = toHex(node.privateKey);
    const session = createSecp256k1SigningSession({ privateKey: node.privateKey });
    node.wipePrivateData();
    return { session, address: getEvmAddress(session.publicKey), key };
  } finally {
    seed.fill(0);
  }
}

/** The passkey that answered is not the one the open wallet was made from, so its keys are another person's. */
export class NotTheWalletsPasskey extends Error {
  constructor(wallet: Address) {
    super(`that passkey is not the one the open wallet, ${wallet}, was made from`);
  }
}

/**
 * The key for the person's agent of this number, from a passkey's output: given only when that output
 * is the one the open wallet came from, so a second passkey in the same browser cannot hand over the
 * keys of a wallet that is not the one on the page.
 */
export function agentKeyFrom(prfOutput: Uint8Array, number: number, wallet: Address): Derived {
  const index = agentAccount(number);
  const phrase = recoveryPhraseOf(prfOutput);
  const person = accountAt(phrase, PERSON_ACCOUNT);
  person.session.end();
  if (!isAddressEqual(person.address, wallet)) throw new NotTheWalletsPasskey(wallet);
  return accountAt(phrase, index);
}

/** The same account again, from the key a tab kept, with no passkey asked for. */
export function accountFromKey(key: Hex): { readonly session: Secp256k1SigningSession; readonly address: EvmAddress } {
  const bytes = hexToBytes(key);
  try {
    const session = createSecp256k1SigningSession({ privateKey: bytes });
    return { session, address: getEvmAddress(session.publicKey) };
  } finally {
    bytes.fill(0);
  }
}
