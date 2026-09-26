import { useQuery } from "@tanstack/react-query";
import { jobApiPath } from "../../../routes.ts";
import { readAnswer } from "../../shared/index.ts";
import { JobViewSchema, type JobView } from "../views/index.ts";
import { SITE_QUERY_KEYS } from "./queryKeys.ts";
import { useSite } from "./SiteContext.ts";

/** how often a running job's page asks after it: seats, notes and verdicts arrive minutes apart */
export const FOLLOW_EVERY_MS = 5_000;

export interface FollowedJob {
  readonly job: JobView;
  /** the last time asking failed, while it keeps asking */
  readonly lostTouch: boolean;
}

async function fetchJob(jobId: string): Promise<JobView> {
  const response = await fetch(jobApiPath(jobId));
  if (!response.ok) throw new Error(`the server said ${response.status}`);
  return await readAnswer(response, JobViewSchema);
}

/**
 * The job as it stands, starting from what the server drew and asking again while it runs, so seats,
 * notes and the verdict appear without a reload. Once there is a verdict nothing changes, and it stops.
 */
export function useFollowedJob(drawn: JobView): FollowedJob {
  const { drawnAt } = useSite();
  const answer = useQuery({
    queryKey: SITE_QUERY_KEYS.job(drawn.jobId),
    queryFn: () => fetchJob(drawn.jobId),
    initialData: drawn,
    initialDataUpdatedAt: new Date(drawnAt).getTime(),
    staleTime: FOLLOW_EVERY_MS,
    refetchInterval: (query) => (query.state.data?.verdict === "running" ? FOLLOW_EVERY_MS : false),
  });
  return { job: answer.data, lostTouch: answer.isError };
}
