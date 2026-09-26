/**
 * Paying and posting, from the poster's own wallet.
 *
 * Five steps, in the only order that is safe: connect, be on the right chain, pay the contract under
 * the seal, sign the posting, and hand the spec and checks to the server, which accepts them only if
 * the signature, the chain and the fingerprints all agree. A failure before the money moves leaves a
 * draft; after it, the payment is on the chain and the page says so rather than pretending otherwise.
 */
import { useRef, useState } from "react";
import { useMutation, type UseMutateFunction } from "@tanstack/react-query";
import { useConfig, type Config } from "wagmi";
import { connect, getBlock, getConnection, signMessage, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { parseEventLogs, type Address } from "viem";
import { firstLine } from "../../../errors.ts";
import { MODES } from "../../../job.ts";
import { podJobsAbi } from "../../../jobs.ts";
import { AnswerSchema, type MarketConfig } from "../../../market.ts";
import { postingMessage } from "../../../messages.ts";
import { ROUTES } from "../../../routes.ts";
import {
  NoWallet, nextPosting, PostingStopped, type Kept, type Payment, type PostingStep, type SealedJob, type StepState,
} from "../state/index.ts";
import { keptPaymentStore } from "./keptPaymentStore.ts";
import { hasWalletInTheBrowser, injectedConnector } from "../wallet/index.ts";
import { readAnswer } from "./readAnswer.ts";

export interface PostJobInput {
  readonly sealed: SealedJob;
  readonly name: string;
}

export interface PostJobState {
  readonly post: UseMutateFunction<{ readonly url: string }, Error, PostJobInput>;
  readonly steps: Partial<Record<PostingStep, StepState>>;
  /** the payment already sent for this job, if there is one; pressing the button then finishes it */
  readonly payment: Payment | undefined;
  /** the paid job turned out to be on the wall already, published from another tab or before a reload */
  readonly published: () => void;
}

/** how many reviewer seats a job opens with. The contract splits the reviewer share among them; one is its own default */
const REVIEWER_SEATS = 1;

/**
 * @param kept a payment this browser kept from before, whose job was never published: pressing the
 *             button finishes that job, as if the page had never been closed
 */
export function usePostJob(market: MarketConfig, kept?: Kept): PostJobState {
  const config = useConfig();
  const [steps, setSteps] = useState<Partial<Record<PostingStep, StepState>>>({});
  const mark = (step: PostingStep, state: StepState): void => setSteps((all) => ({ ...all, [step]: state }));
  // read by the posting itself, which must see a payment the moment it exists, not on the next render
  const payment = useRef<Payment | undefined>(kept?.payment);
  const [shownPayment, setShownPayment] = useState<Payment | undefined>(kept?.payment);
  // kept in the browser too, the moment it exists: a page closed now must still be able to finish it
  const remember = (paid: Payment, name: string): void => {
    payment.current = paid;
    setShownPayment(paid);
    keptPaymentStore.write(market, { payment: paid, name });
  };

  const posting = useMutation({
    mutationFn: async ({ sealed, name }: PostJobInput): Promise<{ readonly url: string }> => {
      if (!(await hasWalletInTheBrowser(config))) throw new NoWallet();
      const next = nextPosting(payment.current, sealed);
      setSteps(next.kind === "finish" ? { connect: "done", chain: "done" } : {});

      let step: PostingStep = "connect";
      const doing = (now: PostingStep): void => { step = now; mark(now, "doing"); };
      try {
        let paid: Payment;
        if (next.kind === "pay") {
          doing("connect");
          const poster = await connected(config);
          mark("connect", "done");

          doing("chain");
          await switchChain(config, { chainId: market.chainId });
          mark("chain", "done");

          doing("pay");
          const now = (await getBlock(config)).timestamp;
          const endsAt = now + BigInt(MODES[next.sealed.spec.mode].windowMinutes * 60);
          const hash = await writeContract(config, {
            address: market.jobs, abi: podJobsAbi, functionName: "post",
            args: [next.sealed.seal, endsAt, REVIEWER_SEATS], value: next.sealed.spec.price, chainId: market.chainId, account: poster,
          });
          // from here the money may be on the chain, whatever happens next, so it is a payment now
          paid = { hash, poster, sealed: next.sealed };
          remember(paid, name);
        } else {
          paid = next.payment;
        }

        let onChainId = paid.onChainId;
        if (onChainId === undefined) {
          doing("pay");
          onChainId = await jobMadeBy(config, market, paid.hash);
          remember({ ...paid, onChainId }, name);
        }
        mark("pay", "done");

        doing("sign");
        const signature = await signMessage(config, {
          account: paid.poster,
          message: postingMessage({ jobId: name, onChainId, jobs: market.jobs, seal: paid.sealed.seal }),
        });
        mark("sign", "done");

        doing("publish");
        const url = await publish({ jobId: name, onChainId, poster: paid.poster, signature, sealed: paid.sealed });
        mark("publish", "done");
        keptPaymentStore.forget(market);
        return { url };
      } catch (error) {
        mark(step, "failed");
        throw new PostingStopped(step, firstLine(error), payment.current !== undefined);
      }
    },
  });

  return { post: posting.mutate, steps, payment: shownPayment, published: () => keptPaymentStore.forget(market) };
}

/** Wait for a payment to land, and find which job it made. Waiting again on the same payment is safe. */
async function jobMadeBy(config: Config, market: MarketConfig, hash: `0x${string}`): Promise<string> {
  const receipt = await waitForTransactionReceipt(config, { hash, chainId: market.chainId });
  if (receipt.status !== "success") throw new Error("the chain refused the payment, so no money moved");
  const [posted] = parseEventLogs({ abi: podJobsAbi, eventName: "Posted", logs: receipt.logs });
  if (!posted) throw new Error("the payment went through but the contract did not say which job it made");
  return posted.args.jobId.toString();
}

/** The poster's address: the wallet's current account, connecting first if it is not connected yet. */
async function connected(config: Config): Promise<Address> {
  const connection = getConnection(config);
  if (connection.status === "connected") return connection.address;
  const [account] = (await connect(config, { connector: injectedConnector(config) })).accounts;
  if (!account) throw new Error("the wallet did not give an address");
  return account;
}

/** Hand the spec and checks to the server, which checks them against the chain and the signature. */
async function publish(input: {
  readonly jobId: string;
  readonly onChainId: string;
  readonly poster: Address;
  readonly signature: `0x${string}`;
  readonly sealed: SealedJob;
}): Promise<string> {
  const { jobId, onChainId, poster, signature, sealed } = input;
  const response = await fetch(ROUTES.postJob, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jobId, onChainId, poster, signature, files: sealed.files,
      spec: { ...sealed.spec, price: sealed.spec.price.toString() },
    }),
  });
  const answer = await readAnswer(response, AnswerSchema);
  if (!response.ok || !answer.url) throw new Error(answer.why ?? `the server said ${response.status}`);
  return answer.url;
}
