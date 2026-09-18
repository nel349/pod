import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { approve, podJobsAbi, policyMet, post, readJob, seatPay, settle, takeSeat, type Contract } from "../jobs.ts";
import type { Role } from "../job.ts";

/**
 * The money path, against a real EVM.
 *
 * Anvil is a chain, not a stand-in: the same bytecode, the same reverts, the same balances. What it
 * is not is Monad, so anything Monad-specific still has to be proven there. Everything here is about
 * the contract's own rules, which are the same on any EVM.
 */

// anvil's published test accounts. Public knowledge, worthless, and the reason they are safe to name.
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
] as const;

const anvilChain = (port: number) => defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } },
});

const anvilAvailable = await (async () => {
  try {
    return (await Bun.spawn(["anvil", "--version"], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
  } catch {
    return false;
  }
})();

let node: ReturnType<typeof Bun.spawn> | undefined;
let publicClient: PublicClient;
let address: Address;
let port = 0;

const at = (key: (typeof KEYS)[number]): Contract => ({
  address,
  publicClient,
  wallet: createWalletClient({ account: privateKeyToAccount(key), chain: anvilChain(port), transport: http() }),
});

const COMMIT = `0x${"c0ffee".padEnd(64, "0")}` as Hex;
const SEAL = `0x${"ab".repeat(32)}` as Hex;
const PRICE = parseEther("1");

async function fullPod(jobId: bigint): Promise<void> {
  const seats: readonly [Role, number][] = [["lead", 0], ["builder", 1], ["reviewer", 2], ["qa", 3], ["security", 4]];
  for (const [role, index] of seats) {
    const owner = privateKeyToAccount(KEYS[index + 1]!).address;
    await takeSeat(at(KEYS[index + 1]!), jobId, role, owner);
  }
}

/** Move the chain past a job's window, which is the only way to reach the reclaim path. */
async function pastTheWindow(): Promise<void> {
  const rpc = `http://127.0.0.1:${port}`;
  const call = (method: string, params: unknown[]) =>
    fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  await call("evm_increaseTime", [3601]);
  await call("evm_mine", []);
}

/** An hour from the chain's own clock, which a test that travels in time has already moved. */
async function post1Hour(): Promise<bigint> {
  const now = (await publicClient.getBlock()).timestamp;
  return post(at(KEYS[0]!), { seal: SEAL, endsAt: now + 3600n, reviewers: 1, price: PRICE });
}

describe.skipIf(!anvilAvailable)("the money, on a chain that behaves like the real one", () => {
  beforeAll(async () => {
    port = 8545 + Math.floor(Math.random() * 900);
    node = Bun.spawn(["anvil", "--port", `${port}`, "--silent"], { stdout: "ignore", stderr: "ignore" });
    publicClient = createPublicClient({ chain: anvilChain(port), transport: http() }) as PublicClient;

    // wait for the node, then deploy the contract the tests were just built from
    for (let i = 0; i < 100; i++) {
      try { await publicClient.getBlockNumber(); break; } catch { await Bun.sleep(100); }
    }

    const artefact = await Bun.file(new URL("../../contracts/out/PodJobs.sol/PodJobs.json", import.meta.url)).json();
    const validator = privateKeyToAccount(KEYS[6]!).address;
    const deployer = createWalletClient({ account: privateKeyToAccount(KEYS[0]!), chain: anvilChain(port), transport: http() });
    // the artefact's own abi, because ours is written by hand and has no constructor in it
    const hash = await deployer.deployContract({
      abi: artefact.abi,
      bytecode: artefact.bytecode.object as Hex,
      args: [validator],
    } as Parameters<typeof deployer.deployContract>[0]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    address = receipt.contractAddress!;
  });

  afterAll(() => { node?.kill(); });

  test("a job posted holds the money until somebody else says the work is good", async () => {
    const jobId = await post1Hour();
    const job = await readJob({ address, publicClient }, jobId);
    expect(job.price).toBe(PRICE);
    expect(job.state).toBe("open");
    expect(await publicClient.getBalance({ address })).toBeGreaterThanOrEqual(PRICE);
  });

  test("a pod cannot be packed: one owner, one seat", async () => {
    const jobId = await post1Hour();
    const owner = privateKeyToAccount(KEYS[1]!).address;
    await takeSeat(at(KEYS[1]!), jobId, "lead", owner);
    // the same owner behind a different agent is still the same owner
    expect(takeSeat(at(KEYS[2]!), jobId, "builder", owner)).rejects.toThrow();
  });

  test("nobody is paid until the verdict arrives, and then everybody is", async () => {
    const jobId = await post1Hour();
    await fullPod(jobId);
    for (const [role, index] of [["lead", 0], ["reviewer", 2], ["qa", 3], ["security", 4]] as const) {
      await approve(at(KEYS[index + 1]!), jobId, role as Role, COMMIT);
    }
    expect(await policyMet({ address, publicClient }, jobId, COMMIT)).toBe(true);

    // the approvals are in place, and the money has still not moved
    expect((await readJob({ address, publicClient }, jobId)).state).toBe("working");

    const builder = privateKeyToAccount(KEYS[2]!).address;
    const before = await publicClient.getBalance({ address: builder });
    const pay = await seatPay({ address, publicClient }, jobId, "builder");

    await settle(at(KEYS[6]!), jobId, COMMIT, true);

    expect((await readJob({ address, publicClient }, jobId)).state).toBe("settled");
    const after = await publicClient.getBalance({ address: builder });
    // the seat's share, plus the deposit it put down to hold the seat
    expect(after - before).toBe(pay + pay / 10n);
  });

  test("a verdict that did not pass refunds the person who paid", async () => {
    const jobId = await post1Hour();
    await fullPod(jobId);
    const poster = privateKeyToAccount(KEYS[0]!).address;
    const before = await publicClient.getBalance({ address: poster });

    await settle(at(KEYS[6]!), jobId, COMMIT, false);

    expect((await readJob({ address, publicClient }, jobId)).state).toBe("refunded");
    expect(await publicClient.getBalance({ address: poster })).toBe(before + PRICE);
  });

  test("a job nobody could reproduce is held, and the poster takes the money back when time runs out", async () => {
    const jobId = await post1Hour();
    await fullPod(jobId);

    // this is what "hold" means on chain: the runner calls nothing at all
    expect((await readJob({ address, publicClient }, jobId)).state).toBe("working");

    await pastTheWindow();

    const poster = privateKeyToAccount(KEYS[0]!).address;
    const before = await publicClient.getBalance({ address: poster });
    const reclaimer = at(KEYS[0]!);
    const { request } = await publicClient.simulateContract({
      address, abi: podJobsAbi, functionName: "reclaim", args: [jobId], account: reclaimer.wallet.account!,
    });
    const hash = await reclaimer.wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    expect((await readJob({ address, publicClient }, jobId)).state).toBe("refunded");
    const spent = receipt.gasUsed * receipt.effectiveGasPrice;
    expect(await publicClient.getBalance({ address: poster })).toBe(before + PRICE - spent);
  });

  test("a stranger cannot report a verdict, however good it is", async () => {
    const jobId = await post1Hour();
    await fullPod(jobId);
    expect(settle(at(KEYS[5]!), jobId, COMMIT, true)).rejects.toThrow();
  });

  test("a later commit clears the approvals that were given for the earlier one", async () => {
    const jobId = await post1Hour();
    await fullPod(jobId);
    for (const [role, index] of [["lead", 0], ["reviewer", 2], ["qa", 3], ["security", 4]] as const) {
      await approve(at(KEYS[index + 1]!), jobId, role as Role, COMMIT);
    }
    const moved = `0x${"beef".padEnd(64, "0")}` as Hex;
    await approve(at(KEYS[1]!), jobId, "lead", moved);

    expect(await policyMet({ address, publicClient }, jobId, COMMIT)).toBe(false);
    expect(await policyMet({ address, publicClient }, jobId, moved)).toBe(false);
  });
});
