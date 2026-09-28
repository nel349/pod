import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseEther, type Account, type Address, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { stateOf } from "../jobs.ts";
import { checksDigest, podJobsV2Abi, readJobV2, readWritingMoney, readWritingPrice, stateOfV2, WriterKey } from "../jobsV2.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";

/**
 * The new contract, as the server reads it and as the writer key acts on it, against the real
 * contract on a real local chain.
 */
const available = await anvilAvailable();

const [DEPLOYER, VALIDATOR, WRITER, POSTER, STRANGER] = ANVIL_KEYS;
const WRITING = parseEther("0.05");
const PRICE = parseEther("1");
const WINDOW = 2n * 60n * 60n;
const FIRST_JOB = 10n;
const SEAL: Hex = "0x1111111111111111111111111111111111111111111111111111111111111111";

describe("a state number nobody knows", () => {
  test("is an error, on either contract, never read as open", () => {
    expect(stateOf(1)).toBe("working");
    expect(() => stateOf(4)).toThrow("has no word for");
    expect(stateOfV2(4)).toBe("preparing");
    expect(() => stateOfV2(5)).toThrow("has no word for");
  });
});

describe.skipIf(!available)("the new contract, from the server", () => {
  let anvil: Anvil;
  let jobs: Address;
  let writer: WriterKey;
  let poster: WalletClient & { account: Account };

  beforeAll(async () => {
    anvil = await startAnvil();
    const validator = privateKeyToAccount(VALIDATOR).address;
    jobs = await anvil.deploy("PodJobsV2", [validator, privateKeyToAccount(WRITER).address, FIRST_JOB, WRITING, 100_000n], DEPLOYER);
    writer = new WriterKey({ address: jobs, publicClient: anvil.publicClient, wallet: anvil.wallet(WRITER) });
    poster = anvil.wallet(POSTER);
  });
  afterAll(() => anvil?.stop());

  async function aPaidJob(): Promise<bigint> {
    const { request, result } = await anvil.publicClient.simulateContract({
      address: jobs, abi: podJobsV2Abi, functionName: "post", args: [WINDOW, 1], value: PRICE + 3n * WRITING, account: poster.account,
    });
    await anvil.publicClient.waitForTransactionReceipt({ hash: await poster.writeContract(request) });
    return result;
  }

  test("a paid job reads as preparing, with its price, its window and three writings' money", async () => {
    const id = await aPaidJob();
    expect(id).toBeGreaterThanOrEqual(FIRST_JOB);
    const job = await readJobV2({ address: jobs, publicClient: anvil.publicClient }, id);
    expect(job).toMatchObject({ poster: poster.account.address, price: PRICE, state: "preparing", window: WINDOW, endsAt: 0n });
    expect(await readWritingMoney({ address: jobs, publicClient: anvil.publicClient }, id)).toEqual({ balance: 3n * WRITING, reserved: 0n, kept: 0 });
    expect(await readWritingPrice({ address: jobs, publicClient: anvil.publicClient })).toBe(WRITING);
  });

  test("a number the contract never gave reads as no job", async () => {
    expect(await readJobV2({ address: jobs, publicClient: anvil.publicClient }, 9999n)).toBeUndefined();
  });

  test("the digest worked out here is the one the contract checks", async () => {
    const id = await aPaidJob();
    const onChain = await anvil.publicClient.readContract({ address: jobs, abi: podJobsV2Abi, functionName: "checksDigest", args: [id, SEAL] });
    expect(checksDigest({ jobs, chainId: 31337, jobId: id, seal: SEAL })).toBe(onChain);
  });

  test("the writer sets a writing's money aside, then keeps it for the validator", async () => {
    const id = await aPaidJob();
    const validatorBefore = await anvil.publicClient.getBalance({ address: privateKeyToAccount(VALIDATOR).address });
    await writer.reserve(id);
    expect(await readWritingMoney({ address: jobs, publicClient: anvil.publicClient }, id)).toEqual({ balance: 2n * WRITING, reserved: WRITING, kept: 0 });
    await writer.keep(id);
    expect(await readWritingMoney({ address: jobs, publicClient: anvil.publicClient }, id)).toEqual({ balance: 2n * WRITING, reserved: 0n, kept: 1 });
    expect(await anvil.publicClient.getBalance({ address: privateKeyToAccount(VALIDATOR).address })).toBe(validatorBefore + WRITING);
  });

  test("a writing released goes back to the job's balance", async () => {
    const id = await aPaidJob();
    await writer.reserve(id);
    await writer.release(id);
    expect(await readWritingMoney({ address: jobs, publicClient: anvil.publicClient }, id)).toEqual({ balance: 3n * WRITING, reserved: 0n, kept: 0 });
  });

  test("the writer's actions go one at a time, in the order they were asked, even asked together", async () => {
    const id = await aPaidJob();
    // asked in one breath: keeping only works once the reservation is on the chain
    await Promise.all([writer.reserve(id), writer.keep(id), writer.reserve(id), writer.release(id)]);
    expect(await readWritingMoney({ address: jobs, publicClient: anvil.publicClient }, id)).toEqual({ balance: 2n * WRITING, reserved: 0n, kept: 1 });
  });

  test("a refused action says why, and the next one still goes", async () => {
    const id = await aPaidJob();
    await expect(writer.keep(id)).rejects.toThrow("NoWritingUnderWay");
    await writer.reserve(id);
    expect((await readWritingMoney({ address: jobs, publicClient: anvil.publicClient }, id)).reserved).toBe(WRITING);
  });

  test("the writer's signature opens the job when its poster approves; anybody else's does not", async () => {
    const id = await aPaidJob();
    const forged = await anvil.wallet(STRANGER).signMessage({
      account: privateKeyToAccount(STRANGER), message: { raw: checksDigest({ jobs, chainId: 31337, jobId: id, seal: SEAL }) },
    });
    await expect(anvil.publicClient.simulateContract({
      address: jobs, abi: podJobsV2Abi, functionName: "approveChecks", args: [id, SEAL, forged], account: poster.account,
    })).rejects.toThrow("NotWritten");

    const signature = await writer.sign(id, SEAL);
    const { request } = await anvil.publicClient.simulateContract({
      address: jobs, abi: podJobsV2Abi, functionName: "approveChecks", args: [id, SEAL, signature], account: poster.account,
    });
    await anvil.publicClient.waitForTransactionReceipt({ hash: await poster.writeContract(request) });
    const job = await readJobV2({ address: jobs, publicClient: anvil.publicClient }, id);
    expect(job?.state).toBe("open");
    expect(job?.seal).toBe(SEAL);
  });
});
