import type { ReactElement } from "react";
import { InTheBrowser, PageBill, Seal } from "../../components/index.ts";
import { inCoins, SITE, stampOf } from "../../copy.ts";
import { useIsViewer, useSite } from "../../hooks/index.ts";
import type { JobView } from "../../views/index.ts";

/** What this job is to the reader, when their wallet posted it or holds its title. */
function YoursToo({ job }: { readonly job: JobView }): ReactElement | null {
  const isViewer = useIsViewer();
  const marks = [
    ...(isViewer(job.poster) ? [SITE.job.yourJob] : []),
    ...(isViewer(job.title?.holder) ? [SITE.job.yourTitle] : []),
  ];
  if (marks.length === 0) return null;
  return <ul className="yours-marks">{marks.map((mark) => <li key={mark}>{mark}</li>)}</ul>;
}

/** Where the job stands, said to its poster as "you" once it is delivered and the wallet here is theirs. */
function StandingToTheReader({ job }: { readonly job: JobView }): ReactElement {
  const isViewer = useIsViewer();
  return <>{job.answer && isViewer(job.poster) ? SITE.job.standingYours[job.answer] : job.standing}</>;
}

/** The job's bill: its idea as the headline, the seal as it stands, and the word stamped across it. */
export function JobBill({ job }: { readonly job: JobView }): ReactElement {
  const { coin } = useSite();
  const pod = job.seats.flatMap((seat) => (seat.agent ? [{ role: seat.role, agent: seat.agent }] : []));
  return (
    <PageBill words={{ eyebrow: SITE.job.eyebrow(job.jobId), headline: job.idea }}>
      <figure className="job-seal">
        <Seal tile={{ verdict: job.verdict, pod }} isLarge />
        <p className="bill-stamp" aria-hidden="true">{stampOf({ verdict: job.verdict, pod, answer: job.answer })}</p>
        <figcaption className="standing"><InTheBrowser fallback={job.standing}><StandingToTheReader job={job} /></InTheBrowser></figcaption>
      </figure>
      <p className="price"><b>{inCoins(job.price, coin)}</b> {job.money ? SITE.job.priceSays[job.money.kind] : SITE.job.forAPod}</p>
      <InTheBrowser><YoursToo job={job} /></InTheBrowser>
    </PageBill>
  );
}
