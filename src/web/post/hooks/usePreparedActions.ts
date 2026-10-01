/**
 * What a poster does to a paid job while it prepares: have the checks written again (paying for one
 * more writing first when none is left), approve them, or take the money back. Each goes through the
 * poster's own wallet; the contract decides, and the page waits for the chain before saying it is done.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfig, type Config } from "wagmi";
import { getConnection, simulateContract, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import type { Hex } from "viem";
import { WriteRequestSchema } from "../../../checkwriting/request.ts";
import { firstLine } from "../../../errors.ts";
import { podJobsV2Abi, type JobV2 } from "../../../jobsV2.ts";
import { AnswerSchema, type MarketConfig } from "../../../market.ts";
import type { PreparingView } from "../../../preparing/records.ts";
import { preparingWritingsPath } from "../../../routes.ts";
import { connected, readAnswer } from "../../shared/index.ts";
import { asSentence, COPY, latestWriting, needsTopUp, sealToApprove, type DraftRequest } from "../state/index.ts";

export type PreparedAction = "write" | "approve" | "takeBack";
type Working = keyof typeof COPY.prepared.working;

export type ActionStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "working"; readonly action: PreparedAction; readonly step: Working }
  | { readonly kind: "stopped"; readonly action: PreparedAction; readonly why: string };

export interface PreparedActions {
  readonly status: ActionStatus;
  readonly writeAgain: (request: DraftRequest) => void;
  readonly approve: () => void;
  readonly takeBack: () => void;
}

export function usePreparedActions(input: {
  readonly market: MarketConfig;
  readonly onChainId: string;
  readonly view: PreparingView | undefined;
  readonly job: JobV2 | undefined;
  readonly authorization: string | undefined;
}): PreparedActions {
  const { market, onChainId, view, job, authorization } = input;
  const config = useConfig();
  const client = useQueryClient();
  const [status, setStatus] = useState<ActionStatus>({ kind: "idle" });
  const id = BigInt(onChainId);

  const run = (action: PreparedAction, work: (step: (now: Working) => void) => Promise<void>): void => {
    if (status.kind === "working") return;
    const step = (now: Working): void => setStatus({ kind: "working", action, step: now });
    step("wallet");
    work(step)
      .then(() => setStatus({ kind: "idle" }))
      .catch((error: unknown) => setStatus({ kind: "stopped", action, why: asSentence(firstLine(error)) }))
      // whatever happened, the chain and the server are read again rather than guessed at
      .finally(() => void client.invalidateQueries());
  };

  return {
    status,
    writeAgain: (request) => run("write", async (step) => {
      const asked = WriteRequestSchema.safeParse(request);
      if (!asked.success) throw new Error(asked.error.issues[0]?.message ?? COPY.problems.noLines);
      if (!view || !authorization) throw new Error(COPY.prepared.signIn.says);
      if (needsTopUp(view.money)) {
        await send(config, market, step, { functionName: "topUp", args: [id], value: view.money.writingPrice });
      }
      const response = await fetch(preparingWritingsPath(onChainId), {
        method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify(asked.data),
      });
      const answer = await readAnswer(response, AnswerSchema);
      if (!response.ok) throw new Error(answer.why ?? `the server said ${response.status}`);
    }),
    approve: () => run("approve", async (step) => {
      const writing = view ? latestWriting(view) : undefined;
      if (!view || !writing || !job) throw new Error(COPY.prepared.none);
      // the seal of what this page shows, which must be the one the writer signed (F10)
      const toApprove = await sealToApprove({ writing, view, price: job.price });
      if (!toApprove.ok) throw new Error(toApprove.why);
      await send(config, market, step, { functionName: "approveChecks", args: [id, toApprove.seal, toApprove.approval.signature] });
    }),
    takeBack: () => run("takeBack", async (step) => {
      await send(config, market, step, { functionName: "takeBack", args: [id] });
    }),
  };
}

type Call =
  | { readonly functionName: "topUp"; readonly args: readonly [bigint]; readonly value: bigint }
  | { readonly functionName: "takeBack"; readonly args: readonly [bigint] }
  | { readonly functionName: "approveChecks"; readonly args: readonly [bigint, Hex, Hex] };

/**
 * One call to the contract from the poster's wallet, asked first without sending so a refusal comes
 * back with the contract's reason, then sent, then waited for.
 */
async function send(config: Config, market: MarketConfig, step: (now: Working) => void, call: Call): Promise<void> {
  const account = await connected(config);
  if (getConnection(config).chainId !== market.chainId) await switchChain(config, { chainId: market.chainId });
  step("send");
  const at = { account, address: market.jobs, abi: podJobsV2Abi, chainId: market.chainId } as const;
  const hash = await sent(config, at, call);
  step("confirm");
  const receipt = await waitForTransactionReceipt(config, { hash, chainId: market.chainId });
  if (receipt.status !== "success") throw new Error("the chain refused it, so nothing changed");
}

/** Each call asked of the contract as itself, so the wallet is handed exactly what was simulated. */
async function sent(
  config: Config,
  at: { readonly account: `0x${string}`; readonly address: `0x${string}`; readonly abi: typeof podJobsV2Abi; readonly chainId: number },
  call: Call,
): Promise<Hex> {
  switch (call.functionName) {
    case "topUp":
      return writeContract(config, (await simulateContract(config, { ...at, functionName: "topUp", args: call.args, value: call.value })).request);
    case "takeBack":
      return writeContract(config, (await simulateContract(config, { ...at, functionName: "takeBack", args: call.args })).request);
    case "approveChecks":
      return writeContract(config, (await simulateContract(config, { ...at, functionName: "approveChecks", args: call.args })).request);
  }
}
