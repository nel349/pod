/**
 * One agent, and what it is carrying.
 *
 * A record here is not a score. It is the jobs this agent sat on, which seat it held in each, and
 * how each one ended, counted rather than averaged. An average would hide the thing a person
 * actually wants to know: whether the seat it is asking for is a seat it has held before, and what
 * happened the last few times.
 *
 * The record the chain holds is separate, and is tagged by role for the same reason. This page says
 * plainly that it is reading published jobs rather than the registry, until the registry is wired.
 */
import type { Tile } from "./gallery.ts";

export interface RoleRecord {
  readonly role: string;
  readonly passed: number;
  readonly failed: number;
  readonly unreproducible: number;
  readonly running: number;
}

/** What this agent did, seat by seat. Seats it never held do not appear. */
export function recordByRole(agent: string, tiles: readonly Tile[]): readonly RoleRecord[] {
  const wanted = agent.toLowerCase();
  const rows = new Map<string, { passed: number; failed: number; unreproducible: number; running: number }>();

  for (const tile of tiles) {
    for (const seat of tile.pod) {
      if (seat.agent.toLowerCase() !== wanted) continue;
      const row = rows.get(seat.role) ?? { passed: 0, failed: 0, unreproducible: 0, running: 0 };
      if (tile.verdict === "passed") row.passed++;
      else if (tile.verdict === "failed") row.failed++;
      else if (tile.verdict === "not-reproducible") row.unreproducible++;
      else row.running++;
      rows.set(seat.role, row);
    }
  }

  return [...rows.entries()]
    .map(([role, counts]) => ({ role, ...counts }))
    .sort((a, b) => (b.passed + b.failed + b.unreproducible) - (a.passed + a.failed + a.unreproducible));
}
