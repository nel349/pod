import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { deployment, live, monadTestnet } from "../live.ts";

const KEY = `0x${"7".repeat(64)}` as const;
const VALIDATOR = privateKeyToAccount(KEY).address;
const SOMEWHERE = "0x1111111111111111111111111111111111111111";

const good = {
  POD_JOBS_ADDRESS: SOMEWHERE,
  POD_TOKEN_ADDRESS: "0x2222222222222222222222222222222222222222",
  POD_VALIDATOR_ADDRESS: VALIDATOR,
  POD_VALIDATOR_KEY: KEY,
};

describe("reading the deployment", () => {
  test("it is the chain we said it was", () => {
    expect(monadTestnet.id).toBe(10143);
    expect(monadTestnet.nativeCurrency.symbol).toBe("MON");
  });

  test("a missing address is named, not shrugged at", () => {
    expect(() => deployment({ ...good, POD_JOBS_ADDRESS: undefined }))
      .toThrow("POD_JOBS_ADDRESS is not set");
  });

  test("something that is not an address is refused before anything is sent", () => {
    expect(() => deployment({ ...good, POD_TOKEN_ADDRESS: "the token" }))
      .toThrow("does not look like the PodToken contract's address");
  });

  test("a key that is not the validator's is caught here rather than by a revert", () => {
    expect(() => live({ ...good, POD_VALIDATOR_ADDRESS: SOMEWHERE }))
      .toThrow(/answer to 0x1111/);
  });

  test("with everything in place it hands back both contracts and the address that signs", () => {
    const contracts = live(good);
    expect(contracts.jobs.address).toBe(SOMEWHERE);
    expect(contracts.validator).toBe(VALIDATOR);
    expect(contracts.jobs.wallet.account?.address).toBe(VALIDATOR);
  });
});
