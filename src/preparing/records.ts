/**
 * What is kept on disk for a job while it prepares, and what travels to and from its poster, read
 * through these schemas like anything else from outside the program: a file can be half written, or
 * written by a version before this one, and a request can say anything.
 */
import { isAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { WriteRequestSchema, type WriteRequest } from "../checkwriting/request.ts";
import { HowItIsAskedSchema, WrittenSchema } from "../checkwriting/written.ts";
import type { WritingMoney } from "../jobsV2.ts";
import { MODE_NAMES } from "../job.ts";
import { SpecOnTheWireSchema } from "../specWire.ts";

/**
 * A job's number on the chain, written one way only: no leading zeros. "07" and "7" are the same job
 * on the chain, and were they both accepted they would be two jobs here, each holding a name.
 */
export const ON_CHAIN_NUMBER = /^(0|[1-9][0-9]*)$/;

/** A salt nobody can guess: sixteen random bytes, as the page makes it */
export const SALT = /^[0-9a-f]{32}$/;

const OnChainNumberSchema = z.string().regex(ON_CHAIN_NUMBER, "a job's number on the chain is a whole number, with no leading zeros");
const AddressSchema = z.string().refine((value): value is Address => isAddress(value), "not an address");
const HexSchema = z.string().refine((value): value is Hex => /^0x[0-9a-fA-F]*$/.test(value), "not hex");
const SaltSchema = z.string().regex(SALT, "a salt is 32 hex characters");

/** What a poster sends after paying, to have the job prepared. */
export const SetUpRequestSchema = z.object({
  onChainId: OnChainNumberSchema,
  name: z.string(),
  mode: z.enum(MODE_NAMES, { error: "say how long the job runs once it opens" }),
  salt: SaltSchema,
  /** the first writing: what the poster wants built, and the lines that would prove it */
  request: WriteRequestSchema,
  poster: AddressSchema,
  signature: HexSchema,
});

/** How a paid job was set up, once, by its poster. The name, the mode and the salt never change after. */
export const SetUpSchema = z.object({
  onChainId: OnChainNumberSchema,
  /** the contract the job is on */
  jobs: AddressSchema,
  name: z.string(),
  poster: AddressSchema,
  mode: z.enum(MODE_NAMES),
  salt: SaltSchema,
  setUpAt: z.string(),
});

/** A writing the poster asked for, waiting its turn or under way. */
export const AskedSchema = z.object({
  request: WriteRequestSchema,
  askedAt: z.string(),
});

/**
 * What the poster approves on the chain: the whole spec the writer built from a set in which every
 * line is proven, its seal, the check files, and the writer's signature over the seal for this job.
 */
export const ApprovalSchema = z.object({
  spec: SpecOnTheWireSchema,
  files: z.record(z.string(), z.string()),
  seal: HexSchema,
  signature: HexSchema,
});

export const OutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("written"),
    checks: z.array(WrittenSchema),
    howItIsAsked: HowItIsAskedSchema.optional(),
    /** every line became a check that passed all three trials */
    ready: z.boolean(),
    approval: ApprovalSchema.optional(),
    /** why a ready set has nothing to approve: sealing or signing it failed on our side */
    whyNoApproval: z.string().optional(),
  }),
  z.object({ kind: z.literal("failed"), why: z.string() }),
]);

/** One writing of a job's checks, finished one way or the other. */
export const FinishedSchema = z.object({
  number: z.number().int().positive(),
  request: WriteRequestSchema,
  askedAt: z.string(),
  finishedAt: z.string(),
  /** whether the writing is paid for: the model answered, and Docker did not fail us */
  isCharged: z.boolean(),
  /** whether its money has been kept or released on the chain; shown to the poster only then */
  isSettled: z.boolean(),
  /** what happened to its money other than as judged, such as the poster releasing it after a day */
  note: z.string().optional(),
  outcome: OutcomeSchema,
});

/** Where a job's writing stands right now, for its poster. */
export const NowSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("waiting"), place: z.number().int().positive() }),
  z.object({ kind: z.enum(["writing", "trying"]) }),
  z.object({ kind: z.literal("idle") }),
]);
export type Now = z.infer<typeof NowSchema>;

export type SetUpRequest = z.infer<typeof SetUpRequestSchema>;
export type SetUp = z.infer<typeof SetUpSchema>;
export type Asked = z.infer<typeof AskedSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type Outcome = z.infer<typeof OutcomeSchema>;
export type Finished = z.infer<typeof FinishedSchema>;

/** A preparing job as its poster reads it. */
export interface PreparingView {
  readonly onChainId: string;
  readonly name: string;
  readonly mode: SetUp["mode"];
  /** the poster's own salt, so their page can seal what it shows and refuse an approval that does not match */
  readonly salt: string;
  readonly now: Now;
  /** the writing waiting or under way, if there is one */
  readonly asked?: WriteRequest;
  /** every writing whose price is settled, first to last */
  readonly writings: readonly Finished[];
  readonly money: WritingMoney & { readonly writingPrice: bigint };
}

/** A preparing job as it travels: its money in wei, as strings, since JSON has no bigint. */
export interface PreparingOnTheWire extends Omit<PreparingView, "money"> {
  readonly money: { readonly balance: string; readonly reserved: string; readonly kept: number; readonly writingPrice: string };
}

export function preparingToTheWire(view: PreparingView): PreparingOnTheWire {
  const { money, ...rest } = view;
  return {
    ...rest,
    money: { balance: `${money.balance}`, reserved: `${money.reserved}`, kept: money.kept, writingPrice: `${money.writingPrice}` },
  };
}

const WeiSchema = z.string().regex(/^[0-9]+$/, "an amount is a whole number of wei");

/** A preparing job as its poster's page reads it from the server: the shape preparingToTheWire makes. */
export const PreparingOnTheWireSchema = z.object({
  onChainId: OnChainNumberSchema,
  name: z.string(),
  mode: z.enum(MODE_NAMES),
  salt: SaltSchema,
  now: NowSchema,
  asked: WriteRequestSchema.optional(),
  writings: z.array(FinishedSchema),
  money: z.object({ balance: WeiSchema, reserved: WeiSchema, kept: z.number().int().nonnegative(), writingPrice: WeiSchema }),
});

/** Read back from the wire: the money as amounts again. */
export function preparingFromTheWire(wire: z.infer<typeof PreparingOnTheWireSchema>): PreparingView {
  const { money, ...rest } = wire;
  return {
    ...rest,
    money: { balance: BigInt(money.balance), reserved: BigInt(money.reserved), kept: money.kept, writingPrice: BigInt(money.writingPrice) },
  };
}
