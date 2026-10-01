/**
 * Paying first, on a contract that prepares jobs, from the poster's own wallet.
 *
 * Five steps, in the only safe order: connect, be on the right chain, pay the job's price and its
 * first writings, sign that the job is theirs, and send the lines to be written. Everything that could
 * stop it and can be known in advance (the form, the request, the name) is found out before any money
 * moves. From the moment the wallet hands back a transaction, what was asked is kept in this browser
 * until the server confirms the job (R13), and pressing again finishes that job, never pays again.
 */
import { useRef, useState, type BaseSyntheticEvent } from "react";
import type { UseFormReturn } from "react-hook-form";
import { useConfig, type Config } from "wagmi";
import { signMessage, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { parseEventLogs } from "viem";
import { WriteRequestSchema } from "../../../checkwriting/request.ts";
import { firstLine } from "../../../errors.ts";
import { MODES } from "../../../job.ts";
import { podJobsV2Abi } from "../../../jobsV2.ts";
import { AnswerSchema, type MarketConfig } from "../../../market.ts";
import { setUpMessage } from "../../../messages.ts";
import { preparingPagePath, ROUTES } from "../../../routes.ts";
import { connected, hasWalletInTheBrowser, NoWallet, readAnswer } from "../../shared/index.ts";
import {
  asSentence, canPress, COPY, priceInWei, toWriteRequest, whatIsPaid,
  type KeptSetUp, type PayFirstStep, type PayStatus, type PostForm, type StepState,
} from "../state/index.ts";
import { isNameTaken } from "./isNameTaken.ts";
import { keptSetUpStore } from "./keptSetUpStore.ts";

/** how many reviewer seats a job opens with, as on the first contract */
const REVIEWER_SEATS = 1;

/** A posting that stopped, where, and whether money had left the wallet by then. */
class PayingStopped extends Error {
  constructor(readonly step: PayFirstStep, message: string, readonly hasPaid: boolean) {
    super(message);
  }
}

export interface PayFirstState {
  readonly status: PayStatus;
  readonly steps: Partial<Record<PayFirstStep, StepState>>;
  /** the payment already sent and not yet set up, if there is one; pressing the button then finishes it */
  readonly kept: KeptSetUp | undefined;
  /** the form's submit handler */
  readonly submit: (event?: BaseSyntheticEvent) => Promise<void>;
}

/**
 * @param salt the salt this page chose, which seals the job's checks once they are written
 * @param restored a payment this browser kept from before, never set up: pressing the button finishes it
 */
export function usePayFirst(market: MarketConfig, form: UseFormReturn<PostForm>, salt: string, restored?: KeptSetUp): PayFirstState {
  const config = useConfig();
  const [status, setStatus] = useState<PayStatus>({ kind: "idle" });
  const [steps, setSteps] = useState<Partial<Record<PayFirstStep, StepState>>>({});
  // read by the paying itself, which must see a payment the moment it exists, not on the next render
  const kept = useRef<KeptSetUp | undefined>(restored);
  const [shownKept, setShownKept] = useState<KeptSetUp | undefined>(restored);
  // set before the first wait, so a second press cannot start a second payment
  const inFlight = useRef(false);

  const remember = (next: KeptSetUp): void => {
    kept.current = next;
    setShownKept(next);
    keptSetUpStore.write(market, next);
  };
  const mark = (step: PayFirstStep, state: StepState): void => setSteps((all) => ({ ...all, [step]: state }));

  async function payAndSend(valid: PostForm): Promise<string> {
    if (!(await hasWalletInTheBrowser(config))) throw new NoWallet();
    let step: PayFirstStep = "connect";
    const doing = (now: PayFirstStep): void => { step = now; mark(now, "doing"); };
    try {
      let setUp = kept.current;
      if (!setUp) {
        const request = WriteRequestSchema.parse(toWriteRequest(valid));
        const price = priceInWei(valid.price);
        if (price === undefined || !market.writing) throw new Error(COPY.problems.price);
        doing("connect");
        const poster = await connected(config);
        mark("connect", "done");
        doing("chain");
        await switchChain(config, { chainId: market.chainId });
        mark("chain", "done");
        doing("pay");
        const hash = await writeContract(config, {
          address: market.jobs, abi: podJobsV2Abi, functionName: "post",
          args: [BigInt(MODES[valid.mode].windowMinutes * 60), REVIEWER_SEATS],
          value: whatIsPaid(price, market.writing).total, chainId: market.chainId, account: poster,
        });
        // from here the money may be on the chain, whatever happens next
        setUp = { hash, poster, name: valid.name, price: valid.price, mode: valid.mode, salt, request };
        remember(setUp);
      } else {
        setSteps({ connect: "done", chain: "done" });
      }
      // the name is the poster's to change until the job is set up
      if (setUp.name !== valid.name) {
        setUp = { ...setUp, name: valid.name };
        remember(setUp);
      }
      let onChainId = setUp.onChainId;
      if (onChainId === undefined) {
        doing("pay");
        onChainId = await jobMadeBy(config, market, setUp.hash);
        setUp = { ...setUp, onChainId };
        remember(setUp);
      }
      mark("pay", "done");

      doing("sign");
      const signature = await signMessage(config, {
        account: setUp.poster,
        message: setUpMessage({ jobs: market.jobs, onChainId, name: setUp.name, mode: setUp.mode, salt: setUp.salt }),
      });
      mark("sign", "done");

      doing("send");
      await sendToBeWritten({ ...setUp, onChainId, signature });
      mark("send", "done");
      keptSetUpStore.forget(market);
      return preparingPagePath(onChainId);
    } catch (error) {
      mark(step, "failed");
      throw new PayingStopped(step, firstLine(error), kept.current !== undefined);
    }
  }

  const submit = form.handleSubmit(
    async (valid) => {
      if (inFlight.current || !canPress(status)) return;
      inFlight.current = true;
      const stop = (problem: string): void => {
        setStatus({ kind: "idle", problem: asSentence(problem) });
        inFlight.current = false;
      };
      // the writer must be able to take the lines, or the money would pay for a refusal
      const request = WriteRequestSchema.safeParse(toWriteRequest(valid));
      if (!kept.current && !request.success) return stop(request.error.issues[0]?.message ?? COPY.problems.noLines);
      try {
        // a paid job's own name is held by it already if setting it up got as far as the server, which
        // answers a second set-up the same as the first: only a name for a new payment is asked about
        if (!kept.current && (await isNameTaken(valid.name))) return stop(COPY.problems.nameTaken(valid.name));
      } catch (error) {
        return stop(COPY.problems.nameUnknown(firstLine(error)));
      }
      setStatus({ kind: "posting" });
      try {
        const url = await payAndSend(valid);
        setStatus({ kind: "posted", url });
        window.location.assign(url);
      } catch (error) {
        setStatus(stoppedBy(error));
      } finally {
        inFlight.current = false;
      }
    },
    (errors) => {
      const first = Object.values(errors).flatMap((error) => (error?.message ? [error.message] : []))[0];
      setStatus({ kind: "idle", problem: first === undefined ? undefined : asSentence(first) });
    },
  );

  return { status, steps, kept: shownKept, submit };
}

/** Wait for a payment to land, and find which job it made. Waiting again on the same payment is safe. */
async function jobMadeBy(config: Config, market: MarketConfig, hash: `0x${string}`): Promise<string> {
  const receipt = await waitForTransactionReceipt(config, { hash, chainId: market.chainId });
  if (receipt.status !== "success") throw new Error("the chain refused the payment, so no money moved");
  const [created] = parseEventLogs({ abi: podJobsV2Abi, eventName: "Created", logs: receipt.logs });
  if (!created) throw new Error("the payment went through but the contract did not say which job it made");
  return created.args.jobId.toString();
}

/** Hand the lines to the server, which sets the job up only if the chain and the signature agree. */
async function sendToBeWritten(input: KeptSetUp & { readonly onChainId: string; readonly signature: `0x${string}` }): Promise<void> {
  const { onChainId, name, mode, salt, request, poster, signature } = input;
  const response = await fetch(ROUTES.preparing, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ onChainId, name, mode, salt, request, poster, signature }),
  });
  const answer = await readAnswer(response, AnswerSchema);
  if (!response.ok) throw new Error(answer.why ?? `the server said ${response.status}`);
}

/** What the page says when paying stopped: nothing sent, or paid, safe, and how to finish. */
function stoppedBy(error: unknown): PayStatus {
  if (error instanceof NoWallet) return { kind: "idle", problem: COPY.pay.noWallet };
  const hasPaid = error instanceof PayingStopped && error.hasPaid;
  const said = error instanceof Error ? error.message : String(error);
  return {
    kind: "stopped",
    hasPaid,
    why: `${asSentence(said)} ${hasPaid ? COPY.payFirst.failedAfterPaying : COPY.payFirst.failedBeforePaying}`,
  };
}
