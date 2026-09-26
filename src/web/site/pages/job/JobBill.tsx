import type { ReactElement } from "react";
import { InTheBrowser, PageBill, Seal } from "../../components/index.ts";
import { inCoins, SITE, stampOf } from "../../copy.ts";
import { useIsViewer, useSite } from "../../hooks/index.ts";
import type { JobView } from "../../views.ts";

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

/** The job's bill: its idea as the headline, the seal as it stands, and the word stamped across it. */
export function JobBill({ job }: { readonly job: JobView }): ReactElement {
  const { coin } = useSite();
  const pod = job.seats.flatMap((seat) => (seat.agent ? [{ role: seat.role, agent: seat.agent }] : []));
  return (
    <PageBill words={{ eyebrow: SITE.job.eyebrow(job.jobId), headline: job.idea }}>
      <figure className="job-seal">
        <Seal tile={{ verdict: job.verdict, pod }} isLarge />
        <p className="bill-stamp" aria-hidden="true">{stampOf({ verdict: job.verdict, pod })}</p>
        <figcaption className="standing">{job.standing}</figcaption>
      </figure>
      <p className="price"><b>{inCoins(job.price, coin)}</b> {SITE.job.forAPod}</p>
      <InTheBrowser><YoursToo job={job} /></InTheBrowser>
    </PageBill>
  );
}
