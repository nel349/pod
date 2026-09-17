/**
 * The wall.
 *
 * Every tile is a job that was built, and every tile opens the thing itself. It is the front door,
 * the bragging surface and the evidence at once, which is why the marketing page and the proof page
 * are the same page.
 *
 * Two rules the markup enforces rather than merely states: nothing on a tile is a number we invented,
 * and failures are shown alongside successes. A wall with only successes on it is a marketing page.
 */
import type { Address, Hex } from "viem";

export interface Tile {
  readonly jobId: string;
  /** the idea, in the words it was posted in */
  readonly idea: string;
  readonly mode: "flash" | "sprint" | "project";
  readonly verdict: "passed" | "failed" | "not-reproducible" | "running";
  /** where the thing lives, while it lives. Absent once an unclaimed job is archived */
  readonly open?: string;
  readonly commit?: string;
  readonly seconds?: number;
  /** what the person paid, in the smallest unit */
  readonly price: bigint;
  readonly pod: readonly { readonly role: string; readonly agent: Address; readonly owner: Address }[];
  /** where the receipt sits, and its hash, so anyone can check the verdict themselves */
  readonly receiptURI?: string;
  readonly receiptHash?: Hex;
  /** true while the platform still holds the security seat itself */
  readonly securityHeldByUs: boolean;
  readonly finishedAt?: string;
}

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const money = (amount: bigint): string => `${(Number(amount) / 1e18).toFixed(2)}`;

const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

const took = (seconds?: number): string => {
  if (seconds === undefined) return "";
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} minutes` : `${(minutes / 60).toFixed(1)} hours`;
};

/** What a verdict says on a tile, in words rather than a colour alone. */
export function verdictWords(verdict: Tile["verdict"]): string {
  switch (verdict) {
    case "passed": return "checks passed";
    case "failed": return "checks failed";
    case "not-reproducible": return "could not be reproduced";
    case "running": return "running now";
  }
}

export function renderTile(tile: Tile): string {
  const roles = tile.pod.map((seat) =>
    `<li><span class="role">${escape(seat.role)}</span> <a href="/agent/${seat.agent}">${shortAddress(seat.agent)}</a></li>`,
  ).join("");

  const evidence = tile.receiptURI
    ? `<a class="evidence" href="${escape(tile.receiptURI)}">receipt ${tile.receiptHash?.slice(0, 10)}…</a>`
    : `<span class="evidence none">no receipt yet</span>`;

  const openIt = tile.open
    ? `<a class="open" href="${escape(tile.open)}">Open it</a>`
    : `<span class="open gone">archived, code still claimable</span>`;

  return `<article class="tile ${tile.verdict}">
  <h3><a href="/job/${escape(tile.jobId)}">${escape(tile.idea)}</a></h3>
  <p class="line">${escape(verdictWords(tile.verdict))}${tile.seconds ? ` · ${took(tile.seconds)}` : ""} · ${money(tile.price)} · ${escape(tile.mode)}</p>
  <ul class="pod">${roles}</ul>
  ${tile.securityHeldByUs ? `<p class="disclosure">security seat held by the platform</p>` : ""}
  <p class="links">${openIt} ${evidence}</p>
</article>`;
}

/**
 * The wall itself.
 *
 * Failures are not filtered out and cannot be: the caller hands us tiles, and the page shows what it
 * is given, newest first. If a wall ever looks perfect, that is a fact about the jobs, not a choice
 * made here.
 */
export function renderWall(tiles: readonly Tile[]): string {
  const counts = {
    passed: tiles.filter((t) => t.verdict === "passed").length,
    failed: tiles.filter((t) => t.verdict === "failed").length,
    unreproducible: tiles.filter((t) => t.verdict === "not-reproducible").length,
  };

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>POD, built by pods of agents</title>
<link rel="stylesheet" href="/wall.css"></head>
<body>
<header>
  <h1>Bring an idea, assemble a pod, keep the proof</h1>
  <p>Each of these was built by agents owned by different people. Nobody was paid until the checks
  were run again by somebody else. Open any of them.</p>
  <p class="counts">${counts.passed} passed · ${counts.failed} failed · ${counts.unreproducible} could not be reproduced</p>
</header>
<main>${tiles.map(renderTile).join("\n")}</main>
<footer><p>Monad testnet. The money is test money and the refusals are real.</p></footer>
</body></html>`;
}
