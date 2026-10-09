import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useBalance, useConfig, type Config } from "wagmi";
import { getPublicClient, sendTransaction, waitForTransactionReceipt } from "wagmi/actions";
import type { Address, Hex } from "viem";
import { firstLine } from "../../../errors.ts";
import type { MarketConfig } from "../../../market.ts";
import { allButTheGas, openAgentKey, PLAIN_PAYMENT_GAS, sendWithCare, type OpenAgentKey } from "../../shared/index.ts";

/** how often what the agent's address holds is read again while its key is open, in milliseconds */
const READ_AGAIN_EVERY_MS = 5_000;

/** The two ways money moves between the person's wallet and their agent's address. */
export type AgentKeyMove = "fund" | "back";

export type AgentKeyStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "working"; readonly move: AgentKeyMove }
  | { readonly kind: "done"; readonly move: AgentKeyMove }
  | { readonly kind: "stopped"; readonly move: AgentKeyMove; readonly why: string };

/** The agent's address holds less than sending it anywhere would cost. */
export class TooLittleToBringBack extends Error {
  constructor() {
    super("it holds too little to pay for sending it back");
  }
}

/** Money on its way: to the agent's address, so much of it, or everything back from it. */
type Moving = { readonly move: "fund"; readonly amount: bigint } | { readonly move: "back" };

/** Everything the agent's address holds, less its gas, to the person's wallet, signed with the agent's own key. */
async function sendEverythingBack(config: Config, market: MarketConfig, from: OpenAgentKey, to: Address): Promise<Hex> {
  const reads = getPublicClient(config, { chainId: market.chainId });
  const chain = config.chains.find((one) => one.id === market.chainId);
  if (!reads || !chain) throw new Error("this page cannot read the chain it is sending to");
  const [holds, fees] = await Promise.all([reads.getBalance({ address: from.account.address }), reads.estimateFeesPerGas()]);
  // one fee for both, so the gas costs exactly what was set aside for it and nothing is left behind
  const fee = fees.maxFeePerGas;
  const value = allButTheGas(holds, fee);
  if (value === 0n) throw new TooLittleToBringBack();
  return sendWithCare(from.account, chain, { to, value, gas: PLAIN_PAYMENT_GAS, maxFeePerGas: fee, maxPriorityFeePerGas: fee }, market.sending);
}

export interface AgentKey {
  /** which of the person's agents this is, counted from 1 */
  readonly number: number;
  readonly another: () => void;
  readonly before: () => void;
  /** the key the passkey made, while it is open on the page */
  readonly open: { readonly address: Address; readonly key: Hex } | undefined;
  /** what the agent's address holds, once read */
  readonly holds: bigint | undefined;
  readonly make: () => void;
  readonly forget: () => void;
  readonly fund: (amount: bigint) => void;
  readonly bringBack: () => void;
  readonly status: AgentKeyStatus;
  readonly isMaking: boolean;
  /** why the passkey did not give a key, when it did not */
  readonly problem: string | undefined;
}

/**
 * A key for the person's agent from the passkey their open wallet came from: making it, sending it
 * money from the wallet, and bringing back whatever it holds. The key is on the page only while this
 * is; nothing of it is stored, because the passkey makes it again.
 */
export function useAgentKey(market: MarketConfig, wallet: Address): AgentKey {
  const config = useConfig();
  const [number, setNumber] = useState(1);
  const [open, setOpen] = useState<OpenAgentKey>();
  const [status, setStatus] = useState<AgentKeyStatus>({ kind: "idle" });
  const address = open?.account.address;
  const balance = useBalance({ address, chainId: market.chainId, query: { enabled: address !== undefined, refetchInterval: READ_AGAIN_EVERY_MS } });

  // The key on the page is ended, which zeroes it, the moment another takes its place, when it is
  // forgotten, and when the page is left. It is ended by whoever replaces it rather than by an effect
  // on the state: React runs an effect's clean-up more often than the state changes, and a key zeroed
  // early is a key that signs nothing.
  const onThePage = useRef<OpenAgentKey | undefined>(undefined);
  const hold = (next: OpenAgentKey | undefined): void => {
    onThePage.current?.end();
    onThePage.current = next;
    setOpen(next);
  };
  useEffect(() => () => {
    onThePage.current?.end();
    onThePage.current = undefined;
  }, []);

  const making = useMutation({ mutationFn: () => openAgentKey(number, wallet), onSuccess: hold });

  const moving = useMutation({
    mutationFn: async (asked: Moving): Promise<void> => {
      if (!open) throw new Error("the agent's key is not open");
      const hash = asked.move === "fund"
        ? await sendTransaction(config, { account: wallet, to: open.account.address, value: asked.amount, gas: PLAIN_PAYMENT_GAS, chainId: market.chainId })
        : await sendEverythingBack(config, market, open, wallet);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: market.chainId });
      if (receipt.status !== "success") throw new Error("the chain refused it, so nothing moved");
    },
    onMutate: ({ move }) => setStatus({ kind: "working", move }),
    onSuccess: (_, { move }) => setStatus({ kind: "done", move }),
    onError: (error, { move }) => setStatus({ kind: "stopped", move, why: firstLine(error) }),
    onSettled: () => void balance.refetch(),
  });

  /** Another agent's key is another prompt: the one open is forgotten first. */
  const turnTo = (next: number): void => {
    hold(undefined);
    setStatus({ kind: "idle" });
    making.reset();
    setNumber(next);
  };

  return {
    number,
    another: () => turnTo(number + 1),
    before: () => turnTo(Math.max(1, number - 1)),
    open: open ? { address: open.account.address, key: open.key } : undefined,
    holds: balance.data?.value,
    make: () => making.mutate(),
    forget: () => { hold(undefined); setStatus({ kind: "idle" }); },
    fund: (amount) => moving.mutate({ move: "fund", amount }),
    bringBack: () => moving.mutate({ move: "back" }),
    status,
    isMaking: making.isPending,
    problem: making.error ? firstLine(making.error) : undefined,
  };
}
