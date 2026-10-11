import type { ReactElement } from "react";
import { explorerTransaction, type MarketConfig } from "../../../../market.ts";
import { ChooseAccount, CHROME, shortAddress, useConnectedAccount } from "../../../shared/index.ts";
import { When } from "../../components/index.ts";
import { inCoins, SITE, timeLeft } from "../../copy.ts";
import { useAnswer, useIsViewer, useNow } from "../../hooks/index.ts";
import type { DeliveryView, JobView } from "../../views/index.ts";

interface Delivered {
  readonly jobId: string;
  readonly price: string;
  readonly poster: string;
  readonly chain: NonNullable<JobView["chain"]>;
  readonly delivery: DeliveryView;
}

/** What a poster can still say, by the clock: a refusal only in their time, a yes for as long as the job waits. */
function Buttons({ job, market }: { readonly job: Delivered; readonly market: MarketConfig }): ReactElement {
  const words = SITE.job.answer;
  const now = useNow();
  const { status, say } = useAnswer({ jobId: job.jobId, onChainId: job.chain.jobId, jobs: job.chain.jobs }, market);
  const isWorking = status.kind === "working";
  const isSent = status.kind === "sent";
  const isInTime = new Date(job.delivery.answerBy) > now;
  const price = BigInt(job.price);
  // what a yes pays: the share of every seat behind the work. The rest of the price was nobody's to earn
  const paid = BigInt(job.delivery.paidOnAcceptance);
  const kept = BigInt(job.delivery.keptOnRefusal);
  const coins = (wei: bigint): string => inCoins(wei.toString(), market.coin);
  const found = job.delivery.checksPassed ? "passed" : "failed";
  return (
    <>
      {/* the two answers side by side and the same size: the page says what each does, and leans on neither */}
      <div className="answer-choices">
        <div className="answer-choice">
          <button type="button" id="accept" className="answer" disabled={isWorking || isSent} onClick={() => say("accept")}>{words.accept(coins(paid))}</button>
          <p className="note">{paid === price ? words.acceptSays : words.acceptSaysPart(coins(price - paid))}</p>
        </div>
        <div className="answer-choice">
          <button type="button" id="refuse" className="answer" disabled={isWorking || isSent || !isInTime} onClick={() => say("refuse")}>{words.refuse}</button>
          <p className="note">{job.delivery.checksPassed ? words.refuseSays.passed(coins(kept), coins(price - kept)) : words.refuseSays.failed(coins(price))}</p>
        </div>
      </div>
      <p className="note">{words.until} <When iso={job.delivery.answerBy} />, {timeLeft(job.delivery.answerBy, now)}. {words.silence[found]}</p>
      <p id="answer-said" className={isSent ? "said-status done" : "said-status"} role="status">
        {status.kind === "working" && words.working[status.step]}
        {status.kind === "stopped" && status.why}
        {status.kind === "sent" && <>{words.done[status.saying]} <a href={explorerTransaction(market.explorer, status.hash)}>{words.transaction}</a>.</>}
      </p>
    </>
  );
}

/**
 * A delivered job, for the wallet connected here: the two buttons when it is the poster's, and who can
 * answer when it is not. Only the poster's own wallet can send either; the contract refuses any other.
 */
export function YourAnswer({ job, market }: { readonly job: Delivered; readonly market: MarketConfig }): ReactElement | null {
  const words = SITE.job.answer;
  const isViewer = useIsViewer();
  const connected = useConnectedAccount();
  if (isViewer(job.poster)) {
    return (
      <section id="your-answer" className="your-answer" aria-labelledby="your-answer-title">
        <h3 id="your-answer-title">{words.title}</h3>
        <p>{words.yours}</p>
        <Buttons job={job} market={market} />
      </section>
    );
  }
  if (!connected) return <p className="note">{words.noWallet}</p>;
  return (
    <div className="not-their-wallet" role="status">
      <p>{words.notYours(shortAddress(connected), shortAddress(job.poster))}</p>
      <p><ChooseAccount label={CHROME.wallet.chooseAnother} /></p>
    </div>
  );
}
