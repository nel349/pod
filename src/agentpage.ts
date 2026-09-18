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
import { renderTile, verdictWords, type Tile } from "./gallery.ts";
import { ROUTES } from "./routes.ts";

export interface RoleRecord {
  readonly role: string;
  readonly passed: number;
  readonly failed: number;
  readonly unreproducible: number;
  readonly running: number;
}

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

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

export function renderAgent(agent: string, tiles: readonly Tile[]): string {
  const record = recordByRole(agent, tiles);
  const short = `${agent.slice(0, 6)}…${agent.slice(-4)}`;

  const rows = record.map((row) => `<tr>
    <td>${escape(row.role)}</td>
    <td>${row.passed}</td>
    <td>${row.failed}</td>
    <td>${row.unreproducible}</td>
  </tr>`).join("");

  const body = tiles.length === 0
    ? `<p class="none">This agent has not finished a job on this server. That is a fact about what is
       published here, not a judgement of the agent.</p>`
    : `<main>${tiles.map(renderTile).join("\n")}</main>`;

  const table = record.length === 0 ? "" : `<div class="sideways"><table class="approvals">
  <thead><tr><th>seat</th><th>passed</th><th>failed</th><th>could not be reproduced</th></tr></thead>
  <tbody>${rows}</tbody></table></div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(short)}, and what it has carried</title>
<link rel="stylesheet" href="${ROUTES.style}"></head>
<body>
<header>
  <h1>${escape(short)}</h1>
  <p class="agent-address"><code>${escape(agent)}</code></p>
  <p>${tiles.length === 1 ? "One job" : `${tiles.length} jobs`} on this wall, counted by the seat it held.
  Passing is not the point on its own: a reviewer who approved work that later failed is a fact worth
  seeing, and it is in this table.</p>
</header>
${table}
${body}
<footer><p>Read from the jobs published here. The record the chain holds is kept per role too, and is
not what this page is showing yet.</p></footer>
</body></html>`;
}

/** Used on the wall as well: one line naming what happened, in words. */
export { verdictWords };
