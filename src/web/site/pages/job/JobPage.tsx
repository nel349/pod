import type { ReactElement } from "react";
import { Poster } from "../../components/index.ts";
import { SITE } from "../../copy.ts";
import { useFollowedJob } from "../../hooks/index.ts";
import type { JobView } from "../../views/index.ts";
import { AskedSheet } from "./AskedSheet.tsx";
import { ChecksSheet } from "./ChecksSheet.tsx";
import { JobBill } from "./JobBill.tsx";
import { NotesSheet } from "./NotesSheet.tsx";
import { OpenSheet } from "./OpenSheet.tsx";
import { OwnsSheet } from "./OwnsSheet.tsx";
import { PodSheet } from "./PodSheet.tsx";
import { QuestionsSheet } from "./QuestionsSheet.tsx";
import { RepeatSheet } from "./RepeatSheet.tsx";
import { StandsSheet } from "./StandsSheet.tsx";

/** Whether the work is its poster's now: they accepted it, or said nothing while its checks passed. */
const isTheirs = (job: JobView): boolean =>
  job.delivery?.answer === "accepted" || (job.delivery?.answer === "unanswered" && job.delivery.checksPassed);

/**
 * One job, opened, in the order the person who posted it asks about it.
 *
 * Delivered: the door to what was built, what its checks found, then the answer, which is the poster's
 * to give; the record of how it got there comes after, for them and for anybody checking. Once it is
 * theirs, what they now have comes straight after the door. While it is built: where it stands and who
 * is on it. A job settled by its verdict alone, on the contracts before, keeps the order it had.
 */
export function JobPage({ job: drawn }: { readonly job: JobView }): ReactElement {
  const { job, lostTouch } = useFollowedJob(drawn);
  const repeat = job.receipt && <RepeatSheet receipt={job.receipt} isCodePrivate={job.isCodePrivate === true} />;
  if (job.delivery) {
    return (
      <Poster bill={<JobBill job={job} />}>
        <OpenSheet job={job} />
        {isTheirs(job) && <OwnsSheet job={job} />}
        <ChecksSheet job={job} />
        <StandsSheet job={job} lostTouch={lostTouch} />
        <div className="record-starts" id="record">
          <h2>{SITE.job.recordStarts}</h2>
          <p>{SITE.job.recordSays}</p>
        </div>
        <PodSheet job={job} />
        <QuestionsSheet job={job} />
        <NotesSheet job={job} />
        {repeat}
        {!isTheirs(job) && <OwnsSheet job={job} />}
        <AskedSheet job={job} />
      </Poster>
    );
  }
  if (job.verdict === "running") {
    return (
      <Poster bill={<JobBill job={job} />}>
        {/* a question waiting on its poster is the one thing here that needs them, so it comes first */}
        <QuestionsSheet job={job} />
        <StandsSheet job={job} lostTouch={lostTouch} />
        <PodSheet job={job} />
        <ChecksSheet job={job} />
        <AskedSheet job={job} />
        <NotesSheet job={job} />
        <OwnsSheet job={job} />
      </Poster>
    );
  }
  return (
    <Poster bill={<JobBill job={job} />}>
      <AskedSheet job={job} />
      <StandsSheet job={job} lostTouch={lostTouch} />
      <PodSheet job={job} />
      <ChecksSheet job={job} />
      <QuestionsSheet job={job} />
      <NotesSheet job={job} />
      {repeat}
      <OwnsSheet job={job} />
    </Poster>
  );
}
