import type { ReactElement } from "react";
import { Poster } from "../../components/index.ts";
import { useFollowedJob } from "../../hooks/index.ts";
import type { JobView } from "../../views/index.ts";
import { AskedSheet } from "./AskedSheet.tsx";
import { ChecksSheet } from "./ChecksSheet.tsx";
import { JobBill } from "./JobBill.tsx";
import { NotesSheet } from "./NotesSheet.tsx";
import { OwnsSheet } from "./OwnsSheet.tsx";
import { PodSheet } from "./PodSheet.tsx";
import { RepeatSheet } from "./RepeatSheet.tsx";
import { StandsSheet } from "./StandsSheet.tsx";

/**
 * One job, opened, in the order a person asks about it: what was asked, where it stands, who is on
 * it, what decides it, what they said, how to check it yourself, and who owns the result.
 */
export function JobPage({ job: drawn }: { readonly job: JobView }): ReactElement {
  const { job, lostTouch } = useFollowedJob(drawn);
  return (
    <Poster bill={<JobBill job={job} />}>
      <AskedSheet job={job} />
      <StandsSheet job={job} lostTouch={lostTouch} />
      <PodSheet job={job} />
      <ChecksSheet job={job} />
      <NotesSheet job={job} />
      {job.receipt && <RepeatSheet receipt={job.receipt} />}
      <OwnsSheet job={job} />
    </Poster>
  );
}
