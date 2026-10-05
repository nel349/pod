/**
 * What went wrong, as one line a person can read.
 *
 * Errors arrive as anything: an Error, a wallet's error with a short message and pages of detail, a
 * string somebody threw. This narrows whatever it is to its first line rather than trusting its
 * shape, so a refusal shown on a page or kept on a record is never a stack trace or "[object Object]".
 *
 * A chain's own words win over a library's guess at them. Monad answers "Signer had insufficient
 * balance" with the code every node uses for whatever it likes, and viem reads that code as its own
 * "Missing or invalid parameters", which is not what happened. Where a node said something, it is
 * said, because a person who is short of money cannot act on a sentence about parameters.
 */
const LONGEST_LINE = 300;

export function firstLine(error: unknown): string {
  const text = typeof error === "object" && error !== null
    ? (nodeSaid(error) ?? hasText(error, "shortMessage") ?? hasText(error, "message") ?? String(error))
    : String(error);
  return (text.split("\n")[0] ?? "").slice(0, LONGEST_LINE);
}

/** What the node itself said, which a wallet's library keeps as the details under its own wording. */
function nodeSaid(error: object): string | undefined {
  const details = hasText(error, "details");
  if (details === undefined) return undefined;
  const short = hasText(error, "shortMessage");
  // viem repeats the node's words as its own for errors it knows; there is nothing to add then
  return short !== undefined && short.includes(details) ? undefined : details;
}

/** The system's code for what went wrong, such as ENOENT, when it gave one. */
export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? hasText(error, "code") : undefined;
}

function hasText(value: object, key: string): string | undefined {
  const found: unknown = Reflect.get(value, key);
  return typeof found === "string" && found.length > 0 ? found : undefined;
}
