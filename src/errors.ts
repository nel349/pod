/**
 * What went wrong, as one line a person can read.
 *
 * Errors arrive as anything: an Error, a wallet's error with a short message and pages of detail, a
 * string somebody threw. This narrows whatever it is to its first line rather than trusting its
 * shape, so a refusal shown on a page or kept on a record is never a stack trace or "[object Object]".
 */
const LONGEST_LINE = 300;

export function firstLine(error: unknown): string {
  const text = typeof error === "object" && error !== null
    ? (hasText(error, "shortMessage") ?? hasText(error, "message") ?? String(error))
    : String(error);
  return (text.split("\n")[0] ?? "").slice(0, LONGEST_LINE);
}

function hasText(value: object, key: string): string | undefined {
  const found: unknown = Reflect.get(value, key);
  return typeof found === "string" && found.length > 0 ? found : undefined;
}
