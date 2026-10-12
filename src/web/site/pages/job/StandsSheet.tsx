import type { ReactElement } from "react";
import { Sheet } from "../../../shared/index.ts";
import { InTheBrowser, When } from "../../components/index.ts";
import { inCoins, posterRecordWords, SITE, timeLeft, whatHappensNext, whereTheDeliveryStands, whereTheReviewStands, whoStandsBehindIt } from "../../copy.ts";
import { useIsViewer, useNow, useSite } from "../../hooks/index.ts";
import { MS_IN_A_SECOND, moneyAt, type DeliveryView, type JobView, type MoneyView } from "../../views/index.ts";
import { freeSeatsOf, SendAnAgent, type FreeSeat } from "./SendAnAgent.tsx";
import { WhoseMoney } from "./WhoseMoney.tsx";
import { YourAnswer } from "./YourAnswer.tsx";

/** A line only the poster reads: that money held is theirs to take back if the window closes first. */
function IfYours({ poster }: { readonly poster: string | undefined }): ReactElement | null {
  const isViewer = useIsViewer();
  return isViewer(poster) ? <> {SITE.job.money.heldYours}</> : null;
}

/** While a delivered job waits for its poster: until when, and what their silence would do. Said to everybody. */
function Awaited({ delivery }: { readonly delivery: DeliveryView }): ReactElement {
  const now = useNow();
  const words = SITE.job.answer;
  return (
    <p className="money">
      {SITE.job.money.awaiting} {words.theirs} <When iso={delivery.answerBy} />, {timeLeft(delivery.answerBy, now)}.{" "}
      {words.theirSilence[delivery.checksPassed ? "passed" : "failed"]}
    </p>
  );
}

/** The same, left out for the poster themselves: the panel with their two buttons says it to them once. */
function AwaitedUnlessYours({ delivery, poster }: { readonly delivery: DeliveryView; readonly poster: string | undefined }): ReactElement | null {
  const isViewer = useIsViewer();
  return isViewer(poster) ? null : <Awaited delivery={delivery} />;
}

/** Where a delivery stands, said to its poster as "you" when the wallet here is theirs. */
function ToWhoeverReads({ delivery, poster }: { readonly delivery: DeliveryView; readonly poster: string | undefined }): ReactElement {
  const isViewer = useIsViewer();
  return <>{whereTheDeliveryStands(delivery, isViewer(poster))}</>;
}

/** While a job is open or being built, said to its own poster only: that nothing is asked of them. */
function NothingToDoYet({ poster, isSeated }: { readonly poster: string | undefined; readonly isSeated: boolean }): ReactElement | null {
  const isViewer = useIsViewer();
  if (!isViewer(poster)) return null;
  return <p id="nothing-to-do" className="for-you">{isSeated ? SITE.job.nothingToDo.building : SITE.job.nothingToDo.open}</p>;
}

/** While its pod has a question waiting, said to its own poster only: where the one thing asked of them is. */
function AskedOfYou({ poster }: { readonly poster: string | undefined }): ReactElement | null {
  const isViewer = useIsViewer();
  if (!isViewer(poster)) return null;
  return <p id="asked-of-you" className="for-you">{SITE.job.questions.askedOfYou} <a href="#questions">{SITE.job.questions.toTheQuestions}</a>.</p>;
}

/**
 * The line that sends an agent to this job, for everybody but its poster: where they have the last word
 * the contract gives them no seat on their own job, so the page does not offer them one.
 */
function SendAnAgentUnlessYours({ jobId, free, poster }: { readonly jobId: string; readonly free: readonly FreeSeat[]; readonly poster: string | undefined }): ReactElement {
  const isViewer = useIsViewer();
  if (isViewer(poster)) return <p id="no-seat-for-you" className="note">{SITE.job.noSeatOnYourOwn}</p>;
  return <SendAnAgent jobId={jobId} free={free} />;
}

/** A poster's record, said to them as "you" when the wallet here is theirs. */
function RecordToTheReader({ record, poster }: { readonly record: NonNullable<JobView["posterRecord"]>; readonly poster: string | undefined }): ReactElement {
  const isViewer = useIsViewer();
  return <>{posterRecordWords(record, isViewer(poster))}</>;
}

function NothingToDo({ poster }: { readonly poster: string | undefined }): ReactElement {
  const isViewer = useIsViewer();
  return <>{isViewer(poster) ? SITE.job.next.underReview.nothingToDoYours : SITE.job.next.underReview.nothingToDo}</>;
}

/** Work under review: when it was put forward, when it goes to its checks at the latest, and what follows. */
function UnderReview({ review, poster }: { readonly review: NonNullable<JobView["review"]>; readonly poster: string | undefined }): ReactElement {
  const now = useNow();
  const words = SITE.job.next.underReview;
  const isWaitedFor = review.notYet.length > 0 && new Date(review.reviewBy) > now;
  return (
    <div id="review" className="review">
      {review.putForwardAt && <p className="note">{words.putForward} <When iso={review.putForwardAt} /></p>}
      {isWaitedFor && <p>{words.goesToItsChecks} <When iso={review.reviewBy} />, {timeLeft(review.reviewBy, now)}. {words.orANewVersion}</p>}
      <p><InTheBrowser fallback={words.nothingToDo}><NothingToDo poster={poster} /></InTheBrowser></p>
    </div>
  );
}

function Money({ money, poster, hasLastWord }: { readonly money: MoneyView; readonly poster: string | undefined; readonly hasLastWord: boolean }): ReactElement | null {
  const now = useNow();
  const { coin } = useSite();
  const standing = moneyAt(money, now);
  switch (standing.kind) {
    case "held":
      return (
        <p className="money">
          {SITE.job.money.heldUntil} <When iso={standing.endsAt} />, {timeLeft(standing.endsAt, now)}.{" "}
          {standing.isOpenToTakeBack
            ? (hasLastWord ? SITE.job.money.beforeASeatForAnAnswer : SITE.job.money.beforeASeat)
            : hasLastWord ? SITE.job.money.onlyTheAnswer : SITE.job.money.onlyTheVerdict}
          <InTheBrowser><IfYours poster={poster} /></InTheBrowser>
          {" "}<a href={standing.takeBack}>{SITE.job.money.whereToTakeBack}</a>.
        </p>
      );
    case "returnable":
      return (
        <>
          <p className="money">{SITE.job.money.returnable}</p>
          <p><a className="primary" href={standing.takeBack}>{SITE.job.money.takeBack}</a></p>
        </>
      );
    // said by the delivery itself, which knows until when and what silence does
    case "awaiting": return null;
    case "paid": return <p className="money">{SITE.job.money.paid}</p>;
    case "refunded": return <p className="money">{SITE.job.money.refunded}</p>;
    case "shared": return <p className="money">{SITE.job.money.shared(inCoins(standing.keptByThePod, coin))}</p>;
  }
}

/** Where the job stands, what happens next, and where the money is, kept current while it runs. */
export function StandsSheet({ job, lostTouch }: { readonly job: JobView; readonly lostTouch: boolean }): ReactElement {
  const { market } = useSite();
  const isRunning = job.verdict === "running";
  const seatsTaken = job.seats.filter((seat) => seat.agent).length;
  const free = freeSeatsOf(job.seats);
  const { delivery, chain, poster } = job;
  const isAwaited = delivery?.answer === "awaited";
  // a review that has run out waits for nobody: the work is graded with whoever stands behind it
  const now = useNow();
  const isReviewOver = job.review !== undefined && new Date(job.review.reviewBy) <= now;
  // a question its pod asked still waits on its poster: then there is something for them to do, and the page must not say otherwise
  const isAsked = (job.questions ?? []).some((question) => !question.answer && question.answerBy * MS_IN_A_SECOND > now.getTime());
  return (
    <Sheet number={2} id="stands" title={SITE.job.standsTitle} stamp={false}>
      {delivery
        ? <p className="lede"><InTheBrowser fallback={whereTheDeliveryStands(delivery)}><ToWhoeverReads delivery={delivery} poster={poster} /></InTheBrowser></p>
        : <p className="lede">{job.review ? whereTheReviewStands(job.review, isReviewOver) : whatHappensNext(job.verdict, seatsTaken, job.title !== undefined, job.hasLastWord === true)}</p>}
      {job.review && <UnderReview review={job.review} poster={poster} />}
      {isRunning && !job.review && !isAsked && <InTheBrowser><NothingToDoYet poster={poster} isSeated={seatsTaken > 0} /></InTheBrowser>}
      {isRunning && isAsked && <InTheBrowser><AskedOfYou poster={poster} /></InTheBrowser>}
      {delivery && <p id="behind-it">{whoStandsBehindIt(delivery)}</p>}
      {delivery && isAwaited && <InTheBrowser fallback={<Awaited delivery={delivery} />}><AwaitedUnlessYours delivery={delivery} poster={poster} /></InTheBrowser>}
      {delivery && isAwaited && chain && poster && market && (
        <InTheBrowser><YourAnswer job={{ jobId: job.jobId, price: job.price, poster, chain, delivery }} market={market} /></InTheBrowser>
      )}
      {isRunning && free.length > 0 && (job.hasLastWord
        ? <InTheBrowser fallback={<SendAnAgent jobId={job.jobId} free={free} />}><SendAnAgentUnlessYours jobId={job.jobId} free={free} poster={poster} /></InTheBrowser>
        : <SendAnAgent jobId={job.jobId} free={free} />)}
      {job.waitingBecause && <p className="note">{SITE.job.waitingBecause(job.waitingBecause)}</p>}
      {job.retired && <p className="note">{SITE.job.retired(job.retired)}</p>}
      {/* an answered delivery has said where the money went in its first sentence: it is not said again under it */}
      {job.money && !(delivery && (job.money.kind === "paid" || job.money.kind === "refunded")) && (
        <Money money={job.money} poster={job.poster} hasLastWord={job.hasLastWord === true} />
      )}
      {job.poster && (job.money?.kind === "held" || job.money?.kind === "returnable") && <WhoseMoney poster={job.poster} />}
      {job.posterRecord && (
        <p id="poster-record" className="note">
          <InTheBrowser fallback={posterRecordWords(job.posterRecord)}><RecordToTheReader record={job.posterRecord} poster={poster} /></InTheBrowser>
        </p>
      )}
      {(isRunning || isAwaited) && <p className="note live" role="status">{lostTouch ? SITE.job.lostTouch : SITE.job.follows}</p>}
    </Sheet>
  );
}
