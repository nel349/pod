/**
 * The passkey prompts: making a passkey wallet, opening it again, reading its recovery phrase, and
 * making a key for the person's agent.
 *
 * Each runs one passkey ceremony (Face ID, Touch ID, a security key or a device PIN) through Mera, and
 * gets back the passkey's PRF output, from which the wallet is worked out (derive.ts). Nothing secret
 * is stored: only which passkey to ask for next time, so the browser does not offer a choice.
 */
import { createPasskeyWithPrfOutput, getPasskeyPrfOutput, type PasskeyCredentialMetadata } from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import type { Address, Hex, LocalAccount } from "viem";
import { z } from "zod";
import { accountAt, accountFromKey, agentKeyFrom, PERSON_ACCOUNT, recoveryPhraseOf } from "./derive.ts";
import { forgetForThisTab, keepForThisTab, keptForThisTab } from "./kept.ts";

/** what the passkey is called in the person's password manager */
const PASSKEY_NAME = "POD wallet";
const RELYING_PARTY_NAME = "Proof of Development";

/** where the page remembers which passkey is the wallet's, for this site: never anything secret */
const credentialKey = (rpId: string): string => `pod.passkey.${rpId}`;

const CredentialSchema = z.object({ credentialId: z.string().min(1), transports: z.array(z.string()).optional() });

/** The site a passkey belongs to: this page's own host. A passkey made here opens only here. */
export const siteOfThePasskey = (): string => window.location.hostname;

function remembered(rpId: string): PasskeyCredentialMetadata | undefined {
  try {
    const read = CredentialSchema.safeParse(JSON.parse(localStorage.getItem(credentialKey(rpId)) ?? "null"));
    return read.success ? read.data : undefined;
  } catch {
    return undefined;
  }
}

function remember(rpId: string, credential: PasskeyCredentialMetadata): void {
  try {
    localStorage.setItem(credentialKey(rpId), JSON.stringify({ credentialId: credential.credentialId, transports: credential.transports }));
  } catch {
    // not remembered: next time the browser offers every passkey for this site, which works as well
  }
}

/** Whether this browser was ever told which passkey is the wallet's: a returning visitor opens rather than makes one. */
export const hasRememberedPasskey = (): boolean => remembered(siteOfThePasskey()) !== undefined;

/** A wallet open in this tab: the account that signs, and the way to end it, which zeroes its key. */
export interface OpenPasskeyWallet {
  readonly account: LocalAccount;
  readonly end: () => void;
}

/** The person's wallet from a passkey's output, which is zeroed once the key is taken from it. */
function walletFrom(prfOutput: Uint8Array): OpenPasskeyWallet {
  try {
    const { session, key } = accountAt(recoveryPhraseOf(prfOutput), PERSON_ACCOUNT);
    // kept for this tab, so a reload does not ask for their face to show them the page they were on
    keepForThisTab(key);
    return { account: toViemAccount(session), end: () => { forgetForThisTab(); session.end(); } };
  } finally {
    prfOutput.fill(0);
  }
}

/**
 * The wallet this tab had open before it was reloaded, if it is still the same tab. No passkey is
 * asked for: what it is made from was derived by one, in this tab, and kept only until it closes.
 */
export function walletThisTabKept(): OpenPasskeyWallet | undefined {
  const key = keptForThisTab();
  if (key === undefined) return undefined;
  try {
    const { session } = accountFromKey(key);
    return { account: toViemAccount(session), end: () => { forgetForThisTab(); session.end(); } };
  } catch {
    // whatever is there is not a key this page can use; it is no use keeping it
    forgetForThisTab();
    return undefined;
  }
}

/** Make a new passkey, and with it a new wallet. One prompt, two on authenticators that need a second look. */
export async function makePasskeyWallet(): Promise<OpenPasskeyWallet> {
  const rpId = siteOfThePasskey();
  const made = await createPasskeyWithPrfOutput({
    rp: { id: rpId, name: RELYING_PARTY_NAME },
    user: { name: PASSKEY_NAME, displayName: PASSKEY_NAME },
  });
  remember(rpId, made);
  return walletFrom(made.prfOutput);
}

/** One prompt of a passkey made before: the one this browser remembers, or whichever the person picks. */
async function askThePasskey(): Promise<{ readonly prfOutput: Uint8Array; readonly credentialId: string; readonly known: PasskeyCredentialMetadata | undefined }> {
  const rpId = siteOfThePasskey();
  const known = remembered(rpId);
  const answered = await getPasskeyPrfOutput({ rpId, ...(known ? { credential: known } : {}) });
  return { prfOutput: answered.prfOutput, credentialId: answered.credentialId, known };
}

/** Open the wallet of a passkey made before. One prompt. */
export async function openPasskeyWallet(): Promise<OpenPasskeyWallet> {
  const opened = await askThePasskey();
  // the passkey that opens the wallet is the one asked for from now on
  remember(siteOfThePasskey(), opened.known?.credentialId === opened.credentialId ? opened.known : { credentialId: opened.credentialId });
  return walletFrom(opened.prfOutput);
}

/** The wallet's 24-word recovery phrase, after a fresh prompt: shown, never kept. */
export async function readRecoveryPhrase(): Promise<string> {
  const { prfOutput } = await askThePasskey();
  try {
    return recoveryPhraseOf(prfOutput);
  } finally {
    prfOutput.fill(0);
  }
}

/** A key for the person's agent, open on the page: the account that signs, the key to hand over, and the way to end it. */
export interface OpenAgentKey {
  /** which of the person's agents it is for, counted from 1 */
  readonly number: number;
  readonly account: LocalAccount;
  /** what the agent is given. Shown when asked for, never stored */
  readonly key: Hex;
  readonly end: () => void;
}

/**
 * The key for the person's agent of this number, from the same passkey as their wallet, after a fresh
 * prompt. It is worked out again each time it is asked for and stored nowhere, so it cannot be lost,
 * and once the page ends it nothing of it is left in this browser.
 *
 * @param wallet the open passkey wallet's address, which the passkey that answers has to be the one for
 */
export async function openAgentKey(number: number, wallet: Address): Promise<OpenAgentKey> {
  const { prfOutput } = await askThePasskey();
  try {
    const { session, key } = agentKeyFrom(prfOutput, number, wallet);
    return { number, account: toViemAccount(session), key, end: () => session.end() };
  } finally {
    prfOutput.fill(0);
  }
}

/** Whether this browser can make a passkey wallet at all, as far as it says before trying. */
export async function canMakePasskeyWallets(): Promise<boolean> {
  if (typeof window === "undefined" || !window.isSecureContext || typeof window.PublicKeyCredential === "undefined") return false;
  // older browsers cannot say; for them the prompt itself tells
  if (!("getClientCapabilities" in window.PublicKeyCredential)) return true;
  try {
    // a browser that says it has no PRF has none; one that does not say may have it, and the prompt tells
    return (await window.PublicKeyCredential.getClientCapabilities())["extension:prf"] !== false;
  } catch {
    return true;
  }
}
