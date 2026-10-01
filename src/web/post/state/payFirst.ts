/**
 * Posting on a contract that prepares jobs: the poster pays first, then the checks are written.
 *
 * What is paid is the job's price and a few writings of its checks, at once. From the moment the
 * wallet hands back a transaction the money may be on the chain, so what the poster asked for is kept
 * in this browser until the server confirms the job is set up (R13): a tab closed in between comes
 * back to "send it to be written", never to paying again.
 *
 * Kept per chain and contract, and read through a schema, because a browser's storage is anybody's
 * to edit: whatever cannot be read is ignored.
 */
import { formatEther, isAddress, isHex, type Address, type Hex } from "viem";
import { z } from "zod";
import { WriteRequestSchema, type WriteRequest } from "../../../checkwriting/request.ts";
import { MODE_NAMES, type Mode } from "../../../job.ts";
import type { MarketConfig } from "../../../market.ts";
import { SALT } from "../../../preparing/records.ts";
import { COPY, windowInWords } from "./copy.ts";
import { PostFormSchema, toWriteRequest, type DraftForm } from "./form.ts";
import { progressIn, type Progress } from "./progress.ts";
import { PAY_FIRST_STEPS, type StepName } from "./steps.ts";

/** What paying covers: the job, and its first writings. */
export interface WhatIsPaid {
  readonly price: bigint;
  readonly writingPrice: bigint;
  readonly included: number;
  readonly total: bigint;
}

export function whatIsPaid(price: bigint, writing: NonNullable<MarketConfig["writing"]>): WhatIsPaid {
  const writingPrice = BigInt(writing.price);
  return { price, writingPrice, included: writing.included, total: price + writingPrice * BigInt(writing.included) };
}

/** The pay sheet's words: what it costs, what happens after, and what the button does. */
export function payFirstWords(paid: WhatIsPaid, coin: string, mode: Mode): { readonly terms: string; readonly button: string } {
  const amount = (wei: bigint): string => `${formatEther(wei)} ${coin}`;
  return {
    terms: COPY.payFirst.plain({
      total: amount(paid.total), price: amount(paid.price), writings: amount(paid.writingPrice * BigInt(paid.included)),
      included: paid.included, window: windowInWords(mode),
    }),
    button: COPY.payFirst.button(amount(paid.total)),
  };
}

/** How far along a poster is before paying: the five wedges; approving, the centre, comes after. */
export function payFirstProgressOf(form: DraftForm, isPaid: boolean): Progress {
  const shape = PostFormSchema.shape;
  const { statements } = toWriteRequest(form);
  const placed = new Set<StepName>();
  if (shape.idea.safeParse(form.idea).success && shape.kind.safeParse(form.kind).success) placed.add("idea");
  if (statements.some((line) => !line.secret)) placed.add("brief");
  if (statements.some((line) => line.secret)) placed.add("exam");
  if (shape.price.safeParse(form.price).success && shape.name.safeParse(form.name).success) placed.add("terms");
  if (isPaid) placed.add("pay");
  return progressIn(PAY_FIRST_STEPS, placed, COPY.payFirst.next);
}

/** The steps paying takes, in order. */
export const PAY_FIRST_POSTING_STEPS = ["connect", "chain", "pay", "sign", "send"] as const;
export type PayFirstStep = (typeof PAY_FIRST_POSTING_STEPS)[number];

/** A job paid for and not yet confirmed set up by the server: everything needed to finish it. */
export interface KeptSetUp {
  readonly hash: Hex;
  readonly poster: Address;
  /** the job's number on the contract, once the chain has said which job the payment made */
  readonly onChainId?: string;
  readonly name: string;
  /** the price as the poster typed it, so the form they come back to shows it */
  readonly price: string;
  readonly mode: Mode;
  readonly salt: string;
  readonly request: WriteRequest;
}

const KeptSetUpSchema = z.object({
  version: z.literal(1),
  hash: z.string().refine((value): value is Hex => isHex(value), "hex"),
  poster: z.string().refine((value): value is Address => isAddress(value), "an address"),
  onChainId: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
  name: z.string(),
  price: z.string(),
  mode: z.enum(MODE_NAMES),
  salt: z.string().regex(SALT),
  request: WriteRequestSchema,
});

/** Where a set-up on this chain and contract is kept. */
export function keptSetUpKey(chainId: number, jobs: Address): string {
  return `pod.setup.${chainId}.${jobs.toLowerCase()}`;
}

export function keepSetUp(kept: KeptSetUp): string {
  return JSON.stringify({ version: 1, ...kept });
}

/** The kept set-up, or nothing if there is none or it cannot be read. */
export function readKeptSetUp(text: string | null): KeptSetUp | undefined {
  if (text === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const kept = KeptSetUpSchema.safeParse(parsed);
  if (!kept.success) return undefined;
  const { version: _version, ...rest } = kept.data;
  return rest;
}

/** The form as it was when the job was paid for, so the page a poster comes back to shows it. */
export function formOfKeptSetUp(kept: KeptSetUp): DraftForm {
  return { ...formOfRequest(kept.request), price: kept.price, mode: kept.mode, name: kept.name };
}

/** The idea and the lines of a request, as the form holds them: a list left empty still shows one empty line. */
export function formOfRequest(request: WriteRequest): Pick<DraftForm, "idea" | "kind" | "brief" | "exam"> {
  const lines = (secret: boolean): { says: string }[] => {
    const said = request.statements.filter((line) => line.secret === secret).map((line) => ({ says: line.says }));
    return said.length > 0 ? said : [{ says: "" }];
  };
  return { idea: request.idea, kind: request.kind, brief: lines(false), exam: lines(true) };
}
