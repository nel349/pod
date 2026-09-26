import type { ReactElement } from "react";
import { jobPath } from "../../../../routes.ts";
import type { YoursEntry } from "../../views/index.ts";
import { NextOnIt } from "./NextOnIt.tsx";

/** A list of jobs of yours, each with where it stands and the one thing to do next, or a line saying there are none. */
export function YoursEntries({ entries, isHeld, none }: { readonly entries: readonly YoursEntry[]; readonly isHeld: boolean; readonly none: string }): ReactElement {
  if (entries.length === 0) return <p className="note">{none}</p>;
  return (
    <ul className="yours-list">
      {entries.map((entry) => (
        <li key={entry.tile.jobId}>
          <p className="yours-idea"><a href={jobPath(entry.tile.jobId)}>{entry.tile.idea}</a></p>
          <p className="standing">{entry.tile.standing}</p>
          <NextOnIt entry={entry} isHeld={isHeld} />
        </li>
      ))}
    </ul>
  );
}
