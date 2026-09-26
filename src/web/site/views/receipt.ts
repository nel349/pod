import { z } from "zod";
import { receiptFilePath } from "../../../routes.ts";
import type { SignedReceipt } from "../../../receipt.ts";
import type { JobRecord } from "../../../store.ts";

/** A receipt, for a person: what was run, what it said, and the signed file behind it. */
export const ReceiptViewSchema = z.object({
  jobId: z.string(),
  idea: z.string(),
  /** the job's own page */
  jobPage: z.string(),
  file: z.string(),
  verdict: z.enum(["passed", "failed", "not-reproducible"]),
  commit: z.string(),
  repository: z.string(),
  tree: z.string(),
  image: z.string(),
  start: z.string(),
  runs: z.number().int(),
  checks: z.array(z.object({ says: z.string(), command: z.string(), exitCode: z.number().int(), seconds: z.number(), hidden: z.boolean() })),
  allowedHosts: z.array(z.string()),
  undeclaredCalls: z.array(z.string()),
  runner: z.string(),
  finishedAt: z.string(),
  hash: z.string(),
  signature: z.string(),
});
export type ReceiptView = z.infer<typeof ReceiptViewSchema>;

export function receiptView(record: JobRecord, signed: SignedReceipt, jobPage: string): ReceiptView {
  const { receipt } = signed;
  return {
    jobId: record.jobId, idea: record.tile.idea, jobPage, file: receiptFilePath(record.jobId),
    verdict: receipt.verdict, commit: receipt.commit, repository: receipt.repository, tree: receipt.tree,
    image: receipt.image, start: receipt.start, runs: receipt.runs,
    checks: receipt.checks.map((check) => ({ ...check })),
    allowedHosts: [...receipt.allowedHosts], undeclaredCalls: [...receipt.undeclaredCalls],
    runner: receipt.runner, finishedAt: receipt.finishedAt, hash: signed.hash, signature: signed.signature,
  };
}
