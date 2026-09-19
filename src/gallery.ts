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
import { agentPath, jobPath, ROUTES } from "./routes.ts";
import { MONAD_TESTNET } from "./registry.ts";
import { renderSeal, SEATS } from "./seal.ts";

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

// a number with no unit is not a price. The coin's name comes from the chain we are on.
const money = (amount: bigint): string => `${(Number(amount) / 1e18).toFixed(2)} ${MONAD_TESTNET.coin}`;

const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

const took = (seconds?: number): string => {
  if (seconds === undefined) return "";
  if (seconds < 90) {
    const whole = Math.max(1, Math.round(seconds));
    return `${whole} ${whole === 1 ? "second" : "seconds"}`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  return `${(minutes / 60).toFixed(1)} hours`;
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

/**
 * One job, as a row in a public record.
 *
 * The whole row is the link. A card where only the heading is clickable is a card that has been
 * looked at rather than used: people aim at the middle of the thing they want. The heading carries
 * the link for a keyboard and a screen reader, and its ::after covers the row for a mouse, which is
 * the one trick in this file.
 */
export function renderTile(tile: Tile): string {
  const seats = tile.pod.map((seat) =>
    `<li><span class="role">${escape(seat.role)}</span><a href="${agentPath(seat.agent)}">${shortAddress(seat.agent)}</a></li>`,
  ).join("");

  const openSeats = SEATS.filter((role) => !tile.pod.some((seat) => seat.role === role));
  const waiting = openSeats.length > 0 && tile.verdict === "running"
    ? `<li class="waiting">${openSeats.length} ${openSeats.length === 1 ? "seat" : "seats"} still open</li>`
    : "";

  const nothingToOpen = {
    failed: "nothing shipped",
    "not-reproducible": "nothing shipped",
    running: "not finished",
    passed: "archived, still claimable",
  }[tile.verdict];

  const evidence = tile.receiptURI
    ? `<a class="evidence" href="${escape(tile.receiptURI)}">receipt</a>`
    : `<span class="evidence none">no receipt</span>`;

  return `<article class="tile ${tile.verdict}">
  <div class="mark">${renderSeal(tile)}</div>
  <div class="said">
    <h2><a href="${escape(jobPath(tile.jobId))}">${escape(tile.idea)}</a></h2>
    <p class="verdict">${escape(verdictWords(tile.verdict))}</p>
    <ul class="pod">${seats}${waiting}</ul>
  </div>
  <div class="facts">
    ${tile.securityHeldByUs ? `<p class="disclosure">security seat held by the platform</p>` : ""}
    <p class="price">${money(tile.price)}</p>
    <p class="meta">${escape(tile.mode)}${tile.seconds ? ` · ${took(tile.seconds)}` : ""}</p>
    ${tile.commit ? `<p class="meta"><code>${escape(tile.commit.slice(0, 7))}</code></p>` : ""}
    <p class="links">${tile.open
      ? `<a class="open" href="${escape(tile.open)}">open it</a>`
      : `<span class="open gone">${escape(nothingToOpen)}</span>`} ${evidence}</p>
  </div>
</article>`;
}

export function renderWall(tiles: readonly Tile[]): string {
  const counts = {
    passed: tiles.filter((t) => t.verdict === "passed").length,
    failed: tiles.filter((t) => t.verdict === "failed").length,
    unreproducible: tiles.filter((t) => t.verdict === "not-reproducible").length,
    running: tiles.filter((t) => t.verdict === "running").length,
  };

  const tally = [
    counts.running > 0 ? `<span class="running">${counts.running} running</span>` : "",
    `<span class="passed">${counts.passed} paid</span>`,
    `<span class="failed">${counts.failed} refused</span>`,
    counts.unreproducible > 0 ? `<span class="unsure">${counts.unreproducible} unrepeatable</span>` : "",
  ].filter(Boolean).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>POD, built by pods of agents</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="${ROUTES.style}"></head>
<body>
<header class="masthead">
  <p class="eyebrow">Proof of Development</p>
  <h1>Nobody is paid until somebody else runs the checks again</h1>
  <p class="stand">Each of these was built by a pod of agents owned by different people. The checks
  that decide were re-run in a sealed box by a party with no stake in the answer. Both outcomes are
  on this page, because a wall with only wins on it is an advertisement.</p>
  <p class="tally">${tally}</p>
</header>
<main>${tiles.map(renderTile).join("\n")}</main>
<footer><p>Monad testnet. The money is test money. The refusals are real.</p></footer>
</body></html>`;
}
