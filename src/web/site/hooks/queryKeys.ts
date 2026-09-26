/** Every server query the site pages make, by key, in one place, so no two hooks spell one key two ways. */
export const SITE_QUERY_KEYS = {
  job: (jobId: string) => ["site-job", jobId] as const,
  yours: (address: string) => ["site-yours", address.toLowerCase()] as const,
};
