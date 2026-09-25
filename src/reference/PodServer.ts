/**
 * The server, as an outside agent sees it: only its public doors.
 *
 * The market it answers to, the job list, the visible checks, the notes and the git door's address.
 * Everything that comes back is read through a schema, because an agent should trust a server it
 * does not run no further than it can check.
 */
import { z } from "zod";
import { JobListingSchema, NoteSchema, type JobListing } from "../door/index.ts";
import { MarketConfigSchema, type MarketConfig } from "../market.ts";
import { gitPath, notesPath, receiptPath, ROUTES } from "../routes.ts";
import type { Note } from "../store.ts";
import type { JobRef } from "./Identity.ts";
import type { DoorAccess } from "./WorkingCopy.ts";

const NotesSchema = z.object({ notes: z.array(NoteSchema) });
const WhySchema = z.object({ why: z.string() });

export class PodServer {
  constructor(private readonly base: string) {}

  async market(): Promise<MarketConfig> {
    return MarketConfigSchema.parse(await this.json(ROUTES.market));
  }

  async jobs(): Promise<JobListing> {
    return JobListingSchema.parse(await this.json(ROUTES.jobList));
  }

  /** A visible check's program, from the address the job list gave for it. */
  async checkFile(path: string): Promise<string> {
    const answer = await fetch(this.url(path));
    if (!answer.ok) throw new Error(`the server would not hand over ${path}: ${answer.status}`);
    return answer.text();
  }

  /** A job's notes, read as a seat: with the same statement the git door takes. */
  async notes(job: JobRef, agent: string, password: string): Promise<readonly Note[]> {
    const answer = await fetch(this.url(notesPath(job.jobId)), { headers: { authorization: signedInAs(agent, password) } });
    if (!answer.ok) throw new Error(`the notes for ${job.jobId} could not be read: ${await this.why(answer)}`);
    return NotesSchema.parse(await answer.json()).notes;
  }

  async writeNote(job: JobRef, note: object): Promise<void> {
    const answer = await fetch(this.url(notesPath(job.jobId)), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(note),
    });
    if (answer.status !== 201) throw new Error(`the note was not taken: ${await this.why(answer)}`);
  }

  /** Where a job's signed receipt is, which is what a request for its verdict points at. */
  receiptLink(job: JobRef): string {
    return this.url(receiptPath(job.jobId));
  }

  /** Whether the job has a receipt yet: no receipt, no verdict to ask about. */
  async hasReceipt(job: JobRef): Promise<boolean> {
    return (await fetch(this.receiptLink(job))).ok;
  }

  /** The job's git door, and the header that signs in to it as the seat. Never logged: it carries a signature */
  gitDoor(job: JobRef, agent: string, password: string): DoorAccess {
    return { url: this.url(gitPath(job.jobId)), authorization: signedInAs(agent, password) };
  }

  private url(path: string): string {
    return new URL(path, this.base).toString();
  }

  private async json(path: string): Promise<unknown> {
    const answer = await fetch(this.url(path), { headers: { accept: "application/json" } });
    if (!answer.ok) throw new Error(`${path} answered ${answer.status}: ${await this.why(answer)}`);
    return answer.json();
  }

  private async why(answer: Response): Promise<string> {
    const text = await answer.text();
    try {
      return WhySchema.parse(JSON.parse(text)).why;
    } catch {
      return text.trim() || String(answer.status);
    }
  }
}

/** The doors' sign-in: the seat's address as the name, its signed statement as the password. */
function signedInAs(agent: string, password: string): string {
  return `Basic ${btoa(`${agent}:${password}`)}`;
}
