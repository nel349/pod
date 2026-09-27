/**
 * What is kept on disk for a job while it prepares, read back through these schemas like anything
 * else from outside the program: a file can be half written, or written by a version before this one.
 */
import { isAddress, type Address } from "viem";
import { z } from "zod";
import { WriteRequestSchema } from "../checkwriting/request.ts";
import { HowItIsAskedSchema, WrittenSchema } from "../checkwriting/written.ts";
import { MODE_NAMES } from "../job.ts";
import { SpecOnTheWireSchema } from "../specWire.ts";

const AddressSchema = z.string().refine((value): value is Address => isAddress(value), "not an address");
const HexSchema = z.string().refine((value): value is `0x${string}` => /^0x[0-9a-fA-F]*$/.test(value), "not hex");
const NumberOnChainSchema = z.string().regex(/^[0-9]+$/, "a job's number on the chain is a whole number");

/** A salt nobody can guess: sixteen random bytes, as the page makes it */
export const SALT = /^[0-9a-f]{32}$/;

/** How a paid job was set up, once, by its poster. The name, the mode and the salt never change after. */
export const SetUpSchema = z.object({
  onChainId: NumberOnChainSchema,
  /** the contract the job is on */
  jobs: AddressSchema,
  name: z.string(),
  poster: AddressSchema,
  mode: z.enum(MODE_NAMES),
  salt: z.string().regex(SALT, "a salt is 32 hex characters"),
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
    /** every line became a check that passed all three trials, so it can be approved */
    ready: z.boolean(),
    approval: ApprovalSchema.optional(),
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
  outcome: OutcomeSchema,
});

export type SetUp = z.infer<typeof SetUpSchema>;
export type Asked = z.infer<typeof AskedSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type Outcome = z.infer<typeof OutcomeSchema>;
export type Finished = z.infer<typeof FinishedSchema>;
