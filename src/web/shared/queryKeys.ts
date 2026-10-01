/**
 * The server and wallet queries every page makes, by key, in one place. TanStack Query caches by key,
 * so two hooks that spelled one key two ways would ask twice and disagree; this is the one spelling.
 */
export const SHARED_QUERY_KEYS = {
  market: () => ["market"] as const,
  walletPresent: () => ["wallet-present"] as const,
  /** what a payment could not deliver to a wallet, kept for it by the contract */
  owed: (jobs: string, wallet: string) => ["owed", jobs.toLowerCase(), wallet.toLowerCase()] as const,
};
