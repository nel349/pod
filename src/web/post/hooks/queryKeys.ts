/**
 * Every server query only the posting page makes, by key, in one place. TanStack Query caches by key, so
 * two hooks that spelled one key two ways would fetch twice and disagree; this is the one spelling.
 */
export const QUERY_KEYS = {
  checkWriting: (url: string | undefined) => ["check-writing", url] as const,
  sealed: (parts: readonly unknown[]) => ["sealed", ...parts] as const,
};
