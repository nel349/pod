import { describe, expect, test } from "bun:test";
import { allButTheGas, PLAIN_PAYMENT_GAS } from "../web/shared/wallet/passkey/comingBack.ts";

/**
 * What an address can send when it sends everything it holds: all of it but the gas of sending, so
 * that what is sent and what the gas costs add up to what it held.
 */

const FEE = 100_000_000_000n;
const GAS_COSTS = PLAIN_PAYMENT_GAS * FEE;

describe("sending everything an address holds", () => {
  test("what is sent and what the gas costs are, together, everything it held", () => {
    const holds = 50_000_000_000_000_000n;
    const sent = allButTheGas(holds, FEE);
    expect(sent + GAS_COSTS).toBe(holds);
  });

  test("an address that could only just pay for the sending has nothing to send", () => {
    expect(allButTheGas(GAS_COSTS, FEE)).toBe(0n);
    expect(allButTheGas(GAS_COSTS - 1n, FEE)).toBe(0n);
    expect(allButTheGas(0n, FEE)).toBe(0n);
  });

  test("one unit more than the gas is one unit to send", () => {
    expect(allButTheGas(GAS_COSTS + 1n, FEE)).toBe(1n);
  });
});
