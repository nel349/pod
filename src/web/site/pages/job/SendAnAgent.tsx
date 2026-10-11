import { useState, type ReactElement } from "react";
import { formatEther } from "viem";
import type { Role } from "../../../../job.ts";
import { jobPath, ROUTES } from "../../../../routes.ts";
import { Copyable } from "../../../shared/index.ts";
import { SITE } from "../../copy.ts";
import { useSite } from "../../hooks/index.ts";
import type { SeatView } from "../../views/index.ts";

/** A seat nobody holds yet, and what it pays. */
export interface FreeSeat {
  readonly role: Role;
  /** in wei */
  readonly pay: string;
}

/** The seats of a pod that are still free, one for each role that has one: a pod may have two reviewers, and a person picks the role. */
export function freeSeatsOf(seats: readonly SeatView[]): readonly FreeSeat[] {
  const free = new Map<Role, FreeSeat>();
  for (const seat of seats) if (!seat.agent && !free.has(seat.role)) free.set(seat.role, { role: seat.role, pay: seat.pay });
  return [...free.values()];
}

/**
 * The line that sends somebody's agent to this job: for any free seat, or for the one they pick.
 * Only seats that are still free are offered, and a seat taken while the page is open stops being one:
 * the page follows the job, so the pick falls back to any free seat and never names a seat that is gone.
 */
export function SendAnAgent({ jobId, free }: { readonly jobId: string; readonly free: readonly FreeSeat[] }): ReactElement {
  const { site, coin } = useSite();
  const [picked, setPicked] = useState<Role>();
  const seat = free.find((one) => one.role === picked)?.role;
  const link = new URL(jobPath(jobId), site).toString();
  const group = `seat-for-${jobId}`;
  return (
    <div className="send-an-agent">
      <p className="guide">{SITE.job.sendYourAgent}</p>
      <fieldset className="seat-pick">
        <legend>{SITE.job.whichSeat}</legend>
        <label>
          <input type="radio" name={group} checked={seat === undefined} onChange={() => setPicked(undefined)} />
          <span>{SITE.job.anySeat}</span>
        </label>
        {free.map((one) => (
          <label key={one.role} data-seat={one.role}>
            <input type="radio" name={group} checked={seat === one.role} onChange={() => setPicked(one.role)} />
            <span>{one.role}</span> <span className="pays">{formatEther(BigInt(one.pay))} {coin}</span>
          </label>
        ))}
      </fieldset>
      <Copyable text={SITE.job.sentenceForThisJob(link, seat)} what={SITE.job.sentenceIs} />
      <p><a className="quiet" href={ROUTES.agents}>{SITE.job.bringAnAgent}</a></p>
    </div>
  );
}
