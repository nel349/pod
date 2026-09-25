/**
 * A real EVM, on this machine, for as long as a test needs one.
 *
 * Anvil is a chain rather than a stand-in: the same bytecode, the same reverts, the same balances. It
 * is not Monad, so nothing Monad-specific is proven against it — only the contract's own rules and
 * the code that talks to them.
 */
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { neededOnCI } from "./tools.ts";

/** Anvil's published test keys. Public knowledge, worthless, and the reason they are safe to name. */
export const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
] as const;

export async function anvilAvailable(): Promise<boolean> {
  let isHere = false;
  try {
    isHere = (await Bun.spawn(["anvil", "--version"], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
  } catch {
    isHere = false;
  }
  return neededOnCI("anvil", isHere);
}

export interface Anvil {
  readonly port: number;
  readonly rpc: string;
  readonly publicClient: PublicClient;
  wallet(key: Hex): WalletClient;
  deploy(artefact: string, args: readonly unknown[], by?: Hex): Promise<Address>;
  /** Send a key something to spend, from the first of anvil's own keys */
  fund(to: Address, value?: bigint): Promise<void>;
  stop(): void;
}

export async function startAnvil(): Promise<Anvil> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const node = Bun.spawn(["anvil", "--port", `${port}`, "--silent"], { stdout: "pipe", stderr: "pipe" });
  const chain = defineChain({
    id: 31337, name: "anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } },
  });
  const publicClient = createPublicClient({ chain, transport: http() }) as PublicClient;

  // wait until it answers, and say what it said if it never does
  let up = false;
  for (let i = 0; i < 300 && !up; i++) {
    try { await publicClient.getBlockNumber(); up = true; } catch { await Bun.sleep(100); }
  }
  if (!up) {
    // stopped before it is read: what a running process printed can never be read to the end
    node.kill();
    await node.exited;
    const said = await new Response(node.stderr as ReadableStream).text();
    throw new Error(`anvil never answered on ${port}. It said: ${said.slice(0, 400) || "(nothing)"}`);
  }

  const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain, transport: http() });

  return {
    port,
    rpc: `http://127.0.0.1:${port}`,
    publicClient,
    wallet,
    async deploy(artefact, args, by = ANVIL_KEYS[0]) {
      const built = await Bun.file(new URL(`../../../contracts/out/${artefact}.sol/${artefact}.json`, import.meta.url)).json();
      const deployer = wallet(by);
      const hash = await deployer.deployContract({
        abi: built.abi, bytecode: built.bytecode.object as Hex, args,
      } as Parameters<typeof deployer.deployContract>[0]);
      return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
    },
    async fund(to, value = parseEther("10")) {
      const payer = privateKeyToAccount(ANVIL_KEYS[0]);
      await publicClient.waitForTransactionReceipt({ hash: await wallet(ANVIL_KEYS[0]).sendTransaction({ to, value, account: payer, chain }) });
    },
    stop: () => node.kill(),
  };
}
