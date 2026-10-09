/**
 * Why the contract said no, in the contract's own word for it.
 *
 * A call is asked of the chain before MetaMask is troubled with it, and when the contract would refuse,
 * the refusal carries the name the contract gave it: TooLate, NotTheSeat, WrongDeposit. That name is
 * what tells a seat what to do next, so it is what is said, where the library's first line says only
 * that the call reverted.
 *
 * The refusal is read by its shape, not by its class: a program can hold two copies of the library
 * that raised it, and an error made by one is not an instance of the other's.
 */
import { z } from "zod";

/** the library's name for a contract's own refusal */
const A_REVERT = "ContractFunctionRevertedError";

const RevertSchema = z.object({
  name: z.literal(A_REVERT),
  data: z.object({ errorName: z.string() }).optional(),
  reason: z.string().optional(),
});
const WithACauseSchema = z.object({ cause: z.unknown() });
const WithAShortMessageSchema = z.object({ shortMessage: z.string() });

/** how deep a refusal is looked for among an error's causes: far deeper than the library nests them */
const DEEPEST_CAUSE = 10;

/** The contract's own refusal, wherever it sits among an error's causes. */
function revertIn(error: unknown): z.infer<typeof RevertSchema> | undefined {
  let looked: unknown = error;
  for (let depth = 0; depth < DEEPEST_CAUSE; depth += 1) {
    const revert = RevertSchema.safeParse(looked);
    if (revert.success) return revert.data;
    const deeper = WithACauseSchema.safeParse(looked);
    if (!deeper.success || deeper.data.cause === undefined) return undefined;
    looked = deeper.data.cause;
  }
  return undefined;
}

const oneLine = (words: string): string => (words.split("\n")[0] ?? "").replace(/\.+$/, "");

/** The contract's name for its refusal when it gave one, and otherwise what went wrong in one line. */
export function whyTheContractRefused(error: unknown): string {
  const revert = revertIn(error);
  const named = revert?.data?.errorName ?? revert?.reason;
  if (named) return `the contract says ${named}`;
  const short = WithAShortMessageSchema.safeParse(error);
  if (short.success) return oneLine(short.data.shortMessage);
  return oneLine(error instanceof Error ? error.message : String(error));
}
