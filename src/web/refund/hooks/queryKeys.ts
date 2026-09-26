/** Every query the refund page makes, by key, in one place. */
export const REFUND_QUERY_KEYS = {
  refundable: (jobId: string) => ["refundable", jobId] as const,
  onChain: (jobId: string) => ["refund-on-chain", jobId] as const,
};
