import { useState, type ReactElement } from "react";
import { LONGEST_ANSWER } from "../../../../triage.ts";
import { Sheet } from "../../../shared/index.ts";
import { AgentLink, InTheBrowser, When } from "../../components/index.ts";
import { SITE, timeLeft } from "../../copy.ts";
import { useAnswerQuestion, useIsViewer, useNow } from "../../hooks/index.ts";
import { MS_IN_A_SECOND, type JobView } from "../../views/index.ts";

type Question = NonNullable<JobView["questions"]>[number];
type OnChain = NonNullable<JobView["chain"]>;

const isoOf = (seconds: number): string => new Date(seconds * MS_IN_A_SECOND).toISOString();

/** The box a job's poster answers one question in, with their own wallet. Anybody else is told whose it is to answer. */
function AnswerBox({ jobId, chain, poster, question }: { readonly jobId: string; readonly chain: OnChain; readonly poster: string; readonly question: Question }): ReactElement {
  const words = SITE.job.questions;
  const isViewer = useIsViewer();
  const [says, setSays] = useState("");
  const { status, answer } = useAnswerQuestion({ jobId, onChainId: chain.jobId, jobs: chain.jobs }, question.id);
  if (!isViewer(poster)) return <p className="note">{words.whoAnswers}</p>;
  const isBusy = status.kind === "working" || status.kind === "sent";
  return (
    <form className="question-answer" onSubmit={(event) => { event.preventDefault(); answer(says.trim()); }}>
      <label htmlFor={`answer-${question.id}`}>{words.yourAnswer}</label>
      <textarea id={`answer-${question.id}`} value={says} maxLength={LONGEST_ANSWER} rows={3} disabled={isBusy} onChange={(event) => setSays(event.target.value)} />
      <button type="submit" className="answer-question" disabled={isBusy || says.trim() === ""}>{words.send}</button>
      <p className="note">{words.sendSays}</p>
      <p className="said-status" role="status">
        {status.kind === "working" && words.working}
        {status.kind === "sent" && words.sent}
        {status.kind === "stopped" && status.why}
      </p>
    </form>
  );
}

/** One question, as it stands now: answered, still waiting on its poster, or gone on with what its seat assumed. */
function Asked({ job, question }: { readonly job: JobView; readonly question: Question }): ReactElement {
  const words = SITE.job.questions;
  const now = useNow();
  const isWaiting = !question.answer && new Date(isoOf(question.answerBy)) > now;
  return (
    <li id={`question-${question.id.slice(0, 10)}`} className={isWaiting ? "question waiting" : "question"}>
      <p className="note-who">
        <span className="role">{question.role}</span> <AgentLink agent={question.agent} /> <When iso={isoOf(question.askedAt)} />
      </p>
      <p className="question-asks">{question.asks}</p>
      {question.answer && <p className="question-answered"><b>{words.answered}</b> {question.answer.says}</p>}
      {!question.answer && <p className="question-assumes"><b>{isWaiting ? words.willAssume : words.assumed}</b> {question.assumes}</p>}
      {isWaiting && <p className="note">{words.answerBy} <When iso={isoOf(question.answerBy)} />, {timeLeft(isoOf(question.answerBy), now)}.</p>}
      {isWaiting && job.chain && job.poster && (
        <InTheBrowser fallback={<p className="note">{words.whoAnswers}</p>}>
          <AnswerBox jobId={job.jobId} chain={job.chain} poster={job.poster} question={question} />
        </InTheBrowser>
      )}
    </li>
  );
}

/**
 * What a pod asked whoever posted a week's job, and what they answered. Shown on every job long
 * enough to have questions while it is built, so its poster knows to look, and after for the record.
 */
export function QuestionsSheet({ job }: { readonly job: JobView }): ReactElement | null {
  const words = SITE.job.questions;
  const questions = job.questions ?? [];
  if (!job.asksItsPoster || (questions.length === 0 && job.verdict !== "running")) return null;
  return (
    <Sheet number={6} id="questions" title={words.title} stamp={false}>
      <p>{words.says}</p>
      {questions.length === 0 && <p className="note">{words.none}</p>}
      {questions.length > 0 && <ol className="questions">{questions.map((question) => <Asked key={question.id} job={job} question={question} />)}</ol>}
    </Sheet>
  );
}
