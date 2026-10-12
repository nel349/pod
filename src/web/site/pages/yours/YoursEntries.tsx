import type { ReactElement } from "react";
import { jobPath } from "../../../../routes.ts";
import { SITE } from "../../copy.ts";
import { useNow } from "../../hooks/index.ts";
import { MS_IN_A_SECOND, type YoursEntry } from "../../views/index.ts";
import { NextOnIt } from "./NextOnIt.tsx";

/** A list of jobs of yours, each with where it stands and the one thing to do next, or a line saying there are none. */
export function YoursEntries({ entries, isHeld, none }: { readonly entries: readonly YoursEntry[]; readonly isHeld: boolean; readonly none: string }): ReactElement {
  if (entries.length === 0) return <p className="note">{none}</p>;
  const now = useNow();
  /** how many questions its pod asked the reader that they can still answer */
  const askedOf = (entry: YoursEntry): number => (isHeld ? 0 : (entry.asked ?? []).filter((answerBy) => answerBy * MS_IN_A_SECOND > now.getTime()).length);
  // a job delivered to the reader, or whose pod has asked them something, waits for them alone: those come first, counted above the list
  const awaitsYou = (entry: YoursEntry): boolean => !isHeld && (entry.money?.kind === "awaiting" || askedOf(entry) > 0);
  const inOrder = [...entries].sort((one, other) => Number(awaitsYou(other)) - Number(awaitsYou(one)));
  const waiting = entries.filter(awaitsYou).length;
  return (
    <>
      {waiting > 0 && <p id="needs-you" className="needs-you">{SITE.yours.needsYou(waiting)}</p>}
      <ul className="yours-list">
        {inOrder.map((entry) => (
          <li key={entry.tile.jobId}>
            <p className="yours-idea"><a href={jobPath(entry.tile.jobId)}>{entry.tile.idea}</a></p>
            <p className="standing">{askedOf(entry) > 0 ? SITE.yours.askedYou(askedOf(entry)) : awaitsYou(entry) ? SITE.yours.awaitingYou : entry.tile.standing}</p>
            {askedOf(entry) > 0 && <p><a className="primary small asked-you" href={`${jobPath(entry.tile.jobId)}#questions`}>{SITE.job.questions.toTheQuestions}</a></p>}
            <NextOnIt entry={entry} isHeld={isHeld} />
          </li>
        ))}
      </ul>
    </>
  );
}
