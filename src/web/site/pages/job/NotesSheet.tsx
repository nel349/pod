import type { ReactElement } from "react";
import { Sheet } from "../../../shared/index.ts";
import { AgentLink, When } from "../../components/index.ts";
import { SITE } from "../../copy.ts";
import { MS_IN_A_SECOND, type JobView } from "../../views/index.ts";

/** What the pod said to each other, in the order it was said: the story of the job, refusals included. */
export function NotesSheet({ job }: { readonly job: JobView }): ReactElement | null {
  const isRunning = job.verdict === "running";
  if (isRunning && job.seats.every((seat) => !seat.agent)) return null;
  return (
    <Sheet number={5} id="notes" title={SITE.job.notesTitle} stamp={false}>
      {isRunning && <p className="note">{SITE.job.notesLater}</p>}
      {!isRunning && job.notes.length === 0 && <p className="note">{SITE.job.noNotes}</p>}
      {job.notes.length > 0 && (
        <ol className="notes">
          {job.notes.map((note) => (
            <li key={note.signature}>
              <p className="note-who">
                <span className="role">{note.role}</span> <AgentLink agent={note.agent} />{" "}
                <When iso={new Date(note.at * MS_IN_A_SECOND).toISOString()} />
                {note.about && <> · <code>{note.about.slice(0, 7)}</code></>}
              </p>
              <p className="note-says">{note.says}</p>
            </li>
          ))}
        </ol>
      )}
    </Sheet>
  );
}
