/**
 * Notes: how the seats of a pod say things to each other, the review comments of this world.
 *
 * Each note is signed by itself, with the seat key, over a sentence that names the job, the seat,
 * what it is about and when. So a reviewer's reason for refusing, or a lead's for what it merged, is
 * evidence anybody can check later without asking us. It is not a chat system: there are no threads,
 * no edits and no deletions, only what each seat said, in the order it arrived.
 *
 *   write   a seat on the job, while the job's window is open, a few times a minute
 *   read    the pod while the job runs, with the same signed statement the git door takes; anybody
 *           once the job has a verdict, when it is published with the rest of the job
 */
import { isAddress, isHex, recoverMessageAddress, type Address } from "viem";
import { z } from "zod";
import { bodyWithin } from "../body.ts";
import { noteMessage } from "../messages.ts";
import { ROUTES } from "../routes.ts";
import { SEATS } from "../seal.ts";
import { checksArePublished, type JobStore, type Note } from "../store.ts";
import { PerMinute, type Answer, type Doorkeeper } from "./Doorkeeper.ts";

/** A note is a paragraph or a few, not a document */
export const LONGEST_NOTE = 4000;
/** A request carrying a note, with room for the note, its signature and its field names */
const MOST_A_NOTE_MAY_WEIGH = LONGEST_NOTE * 4 + 2000;
export const NOTES_A_SEAT_MAY_WRITE_A_MINUTE = 20;
/** How far a note's time may be from ours. A clock a little off is normal; a note from yesterday is not */
export const NOTE_CLOCK_SLACK_SECONDS = 5 * 60;

const COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** A note as it arrives, from anybody. Nothing in it is trusted until the signature and the chain agree */
export const NoteSchema = z.object({
  agent: z.string().refine((agent): agent is Address => isAddress(agent), "the agent is the address of the key that holds the seat"),
  role: z.enum(SEATS),
  about: z.string().regex(COMMIT, "a note is about a commit, named by its full id, or about the job, with no commit at all").optional(),
  says: z.string().trim().min(1, "a note says something").max(LONGEST_NOTE, `a note is at most ${LONGEST_NOTE} characters`),
  at: z.number().int().positive(),
  signature: z.string().refine((signature): signature is `0x${string}` => isHex(signature), "the signature is hex"),
}).strict();

export class NoteBoard {
  private readonly written = new PerMinute(NOTES_A_SEAT_MAY_WRITE_A_MINUTE);

  constructor(private readonly options: { readonly keeper: Doorkeeper; readonly store: JobStore }) {}

  async handle(request: Request): Promise<Response> {
    const { keeper } = this.options;
    const job = await keeper.job(new URL(request.url).pathname.slice(ROUTES.notes.length));
    if (!job.ok) return refusal(job);

    if (request.method === "GET") {
      if (!checksArePublished(job.value.record)) {
        const admitted = await keeper.admit(request, job.value);
        if (!admitted.ok) return refusal(admitted);
      }
      return Response.json({ notes: await this.options.store.notes(job.value.jobId) }, { headers: { "cache-control": "no-store" } });
    }
    if (request.method !== "POST") return Response.json({ why: "notes are read with GET and written with POST" }, { status: 405 });

    const body = await bodyWithin(request, MOST_A_NOTE_MAY_WEIGH);
    if (body === undefined) return Response.json({ why: `a note is at most ${LONGEST_NOTE} characters` }, { status: 413 });
    let asked: unknown;
    try {
      asked = JSON.parse(body);
    } catch {
      return Response.json({ why: "that is not a note" }, { status: 400 });
    }
    const parsed = NoteSchema.safeParse(asked);
    if (!parsed.success) return Response.json({ why: parsed.error.issues[0]?.message ?? "that is not a note" }, { status: 400 });
    const note: Note = parsed.data;
    const { jobId, onChainId } = job.value;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(note.at - now) > NOTE_CLOCK_SLACK_SECONDS) {
      return Response.json({ why: `that note says it was written at ${new Date(note.at * 1000).toISOString()}, which is not now` }, { status: 400 });
    }
    let signer: Address;
    try {
      signer = await recoverMessageAddress({
        message: noteMessage({ jobId, onChainId: String(onChainId), jobs: keeper.jobs, role: note.role, about: note.about, says: note.says, at: note.at }),
        signature: note.signature,
      });
    } catch {
      return Response.json({ why: "that signature could not be read" }, { status: 401 });
    }
    if (signer.toLowerCase() !== note.agent.toLowerCase()) {
      return Response.json({ why: "that signature is not from the agent the note names, over this note" }, { status: 401 });
    }
    const notSeated = await keeper.notSeated(note.agent, parsed.data.role, onChainId);
    if (notSeated) return Response.json({ why: notSeated }, { status: 403 });
    const closed = await keeper.closed(onChainId);
    if (closed) return Response.json({ why: closed }, { status: 403 });
    if (!this.written.allow(`${jobId}:${note.agent.toLowerCase()}`)) {
      return Response.json({ why: `a seat may write ${NOTES_A_SEAT_MAY_WRITE_A_MINUTE} notes a minute. Wait a moment and write again` }, { status: 429 });
    }

    await this.options.store.addNote(jobId, note);
    return Response.json({ note }, { status: 201 });
  }
}

/** The doorkeeper's refusal, as an API answer: a request with no name at all is asked for one. */
function refusal(answer: Extract<Answer<unknown>, { ok: false }>): Response {
  return Response.json({ why: answer.why }, {
    status: answer.status,
    headers: answer.challenge ? { "www-authenticate": 'Basic realm="pod"' } : {},
  });
}
