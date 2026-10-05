import { describe, expect, test } from "bun:test";
import { secondsNow } from "../clock.ts";
import { grantIsGoodNow } from "../door/index.ts";
import { monadClient } from "../live.ts";
import { grantsFor, SESSION_KEY_PLUGIN } from "../mandate.ts";
import { MONAD_TESTNET } from "../registry.ts";

/**
 * The session key plugin on Monad testnet, read as the doors read it (18).
 *
 * The rule itself is tested against a stand-in in mandate.test.ts. This is the other half: that the
 * plugin is at the address we hold, that it answers the two questions the doors ask in the shape they
 * expect, and that a key nobody granted comes back as nothing rather than as an error. Read only:
 * nothing here signs, sends or costs anything.
 *
 * The wallet below is the one the mandate was proven on, on 3 October: a Circle smart wallet owned by
 * a key on this machine, with its agent's keys granted and no end date. Its address is public, it owns
 * ERC-8004 agent 1997, and it is named here so the answer is a real grant rather than an assumption.
 * Should the chain stop saying it is granted, that is a real change to look at, not a test to loosen.
 */

const rpc = process.env.MONAD_TESTNET_RPC ?? MONAD_TESTNET.rpc;
const client = monadClient(rpc);

/** Monad's public node, reached or not: a node that is down is not a reason for the suite to go red. */
const reachable = await (async () => {
  try {
    return (await client.getChainId()) === MONAD_TESTNET.id;
  } catch {
    return false;
  }
})();

/** The wallet the mandate was proven on, and one of the keys it granted */
const WALLET = "0xB0D5AB6792a6abdF22d35e02F6525ae13Afd8e55";
const GRANTED_KEY = "0x948c0177445FE0F9998b989529171Bf08D834E0A";
/** an address nobody granted anything to */
const NOBODY = "0x0000000000000000000000000000000000000009";

describe.skipIf(!reachable)("the session key plugin on Monad testnet", () => {
  test("it is deployed at the address the doors ask", async () => {
    const code = await client.getCode({ address: SESSION_KEY_PLUGIN });
    expect(code).toBeString();
    expect(code).not.toBe("0x");
  }, 60_000);

  test("a key the wallet granted comes back with a window that is good now", async () => {
    const grants = grantsFor({ publicClient: client });
    const window = await grants.granted(WALLET, GRANTED_KEY);
    if (!window) throw new Error(`the plugin no longer says ${WALLET} granted ${GRANTED_KEY}: find a wallet that has granted a key, or grant one`);
    expect(window.from).toBeNumber();
    expect(window.until).toBeNumber();
    expect(grantIsGoodNow(window, secondsNow())).toBe(true);
  }, 60_000);

  test("a key nobody granted comes back as nothing, rather than as a refusal to read", async () => {
    const grants = grantsFor({ publicClient: client });
    expect(await grants.granted(WALLET, NOBODY)).toBeUndefined();
    // and a wallet that is not an account of the plugin's at all answers the same way
    expect(await grants.granted(NOBODY, GRANTED_KEY)).toBeUndefined();
  }, 60_000);
});
