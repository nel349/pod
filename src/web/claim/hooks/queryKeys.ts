/** Every server query the claim page makes, by key, in one place. */
export const CLAIM_QUERY_KEYS = {
  claimable: (jobId: string) => ["claimable", jobId] as const,
};
