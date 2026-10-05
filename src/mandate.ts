/**
 * A key somebody's wallet granted, read from the chain.
 *
 * An agent can hold a seat here without ever being handed a private key. The person's own wallet
 * takes the seat and is paid into; the agent signs with a key the wallet granted through the session
 * key plugin, inside a limit the chain enforces. The doors ask this module the one question they
 * need answered: may this key act for that wallet now. Nothing is stored and nothing is issued, so a
 * grant the owner takes away stops the agent at its next knock.
 */
import { parseAbi, toFunctionSignature, type AbiFunction, type Address, type PublicClient } from "viem";
import { podJobsAbi } from "./jobs.ts";

/**
 * The session key plugin. It is the same address on every network because it is deployed through the
 * CREATE2 factory, which is on Monad too: checked on Monad testnet and on Arc, byte for byte the
 * same code.
 */
export const SESSION_KEY_PLUGIN: Address = "0x669Dd1eDb85ABD00f74186d88124614EE81E6670";

/** What the plugin is asked. Reading the window of a key it does not hold refuses, so it is asked second */
export const sessionKeyPluginAbi = parseAbi([
  "function isSessionKeyOf(address account, address sessionKey) view returns (bool)",
  "function getKeyTimeRange(address account, address sessionKey) view returns (uint48 validAfter, uint48 validUntil)",
]);

/**
 * When a grant is good for, in seconds since 1970, as the plugin holds it. A zero start is no wait
 * and a zero end is no end, which is how the plugin reads its own window when it hands it to the
 * chain's checker, and how the wallet leaves it when the person grants without an end date.
 */
export interface GrantWindow {
  readonly from: number;
  readonly until: number;
}

/** What the doors ask about keys a wallet granted. */
export interface Grants {
  /** The window this wallet granted this key, or nothing when it granted it none. */
  granted(wallet: Address, key: Address): Promise<GrantWindow | undefined>;
}

/**
 * How long an answer about a grant is used before the chain is asked again. A grant taken away is
 * refused within this, and a knock with a made-up key costs at most one read in it.
 */
export const GRANTS_FRESH_FOR_MS = 2_000;

/** The plugin, read the way the doors need it, with each answer kept for a moment. */
export function grantsFor(input: { readonly publicClient: PublicClient; readonly plugin?: Address }): Grants {
  const plugin = input.plugin ?? SESSION_KEY_PLUGIN;
  const asked = new Map<string, { readonly at: number; readonly window: Promise<GrantWindow | undefined> }>();
  return {
    granted(wallet, key) {
      const pair = `${wallet.toLowerCase()}:${key.toLowerCase()}`;
      const kept = asked.get(pair);
      if (kept && Date.now() - kept.at < GRANTS_FRESH_FOR_MS) return kept.window;
      // anybody can knock with a key nobody granted, so what is no longer used is let go of here:
      // the map holds what was asked about in the last moment, not every key that ever knocked
      for (const [was, when] of asked) if (Date.now() - when.at >= GRANTS_FRESH_FOR_MS) asked.delete(was);
      const window = readGrant({ publicClient: input.publicClient, plugin }, wallet, key);
      asked.set(pair, { at: Date.now(), window });
      // a read that failed is not kept: the next knock reads again
      window.catch(() => asked.delete(pair));
      return window;
    },
  };
}

/** What the plugin says: nothing when the wallet never granted this key, else the window it granted. */
async function readGrant(
  at: { readonly publicClient: PublicClient; readonly plugin: Address },
  wallet: Address,
  key: Address,
): Promise<GrantWindow | undefined> {
  const contract = { address: at.plugin, abi: sessionKeyPluginAbi } as const;
  const isGranted = await at.publicClient.readContract({ ...contract, functionName: "isSessionKeyOf", args: [wallet, key] });
  if (!isGranted) return undefined;
  const [from, until] = await at.publicClient.readContract({ ...contract, functionName: "getKeyTimeRange", args: [wallet, key] });
  return { from: Number(from), until: Number(until) };
}

/** Which device the person is holding for a step */
export type Where = "phone" | "laptop";

/** Which of the five steps: the same ids, in the same order, as the wallet and the connector use */
export type StepId = "wallet" | "connect" | "grant" | "task" | "watch";

/**
 * The five steps a person takes to let their agent work a seat for them.
 *
 * The wallet, the connector and every page that shows this path say these five, in this order, on
 * these devices. They are separate programs and cannot read each other, so the order is written down
 * in each: if it changes there, it changes here. The order is real rather than presentation. The
 * wallet and the connected agent both come before the grant, because a grant needs money behind it
 * and an agent to grant to, and the grant comes before the agent is told to start.
 */
export const MANDATE_STEPS: readonly { readonly id: StepId; readonly where: Where }[] = [
  { id: "wallet", where: "phone" },
  { id: "connect", where: "laptop" },
  { id: "grant", where: "phone" },
  { id: "task", where: "laptop" },
  { id: "watch", where: "phone" },
];

/**
 * The wallet, which opens in a phone's browser with nothing to install. The preview, because it is
 * the one that runs on Monad: the wallet at /mandate/ is the Arc one and does not know this chain.
 */
export const WALLET_ADDRESS = "https://kuiralabs.github.io/mandate-next/";

/** Teaches an agent POD: the seats, the doors, and what each seat does */
export const SKILL_INSTALL = "npx skills add nel349/pod";

/**
 * The connector, from npm, told which network: how an agent acts for its owner's wallet. Its own
 * default is Arc, and POD is on Monad, so the line says so.
 */
export const CONNECTOR_INSTALL = "claude mcp add arc-mandate -s user -e ARC_MANDATE_NETWORK=monadTestnet -- npx -y @kuiralabs/arc-mandate";
/** Where the connector's source and its notes on other agents are */
export const CONNECTOR_NOTES = "https://github.com/nel349/arc-agent-mandate/blob/main/mcp/README.md";

/** The two things a seat does on the contract: sitting down, and saying a commit should ship. */
const A_SEAT_CALLS = ["takeSeat", "approve"] as const;

/**
 * What a wallet's allowance has to name for its agent to work a seat, said the way the wallet's
 * connector takes it. An agent hands this over untouched and composes nothing, so the one scan a
 * person makes covers the whole seat, and they are never sent back for something that was left out.
 *
 * It is the job contract and those two functions, read from the contract's own interface so the
 * words here cannot drift from what the chain will accept. Nothing else: the verdict on an agent's
 * record is written by this server, not asked for by the wallet.
 */
export interface SeatAllowance {
  readonly app: string;
  readonly calls: readonly { readonly contract: Address; readonly functions: readonly string[] }[];
}

export function seatAllowance(jobs: Address): SeatAllowance {
  // the same two functions on the first contract and on the one that prepares jobs
  const functions = podJobsAbi
    .filter((item): item is Extract<(typeof podJobsAbi)[number], AbiFunction> => item.type === "function" && (A_SEAT_CALLS as readonly string[]).includes(item.name))
    .map((item) => toFunctionSignature(item));
  return { app: "POD", calls: [{ contract: jobs, functions }] };
}
