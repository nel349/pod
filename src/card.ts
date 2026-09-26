/**
 * The picture that travels when somebody shares a job.
 *
 * It carries the same four facts as the tile and nothing more: the idea, what the checks said, the
 * size of the crew, and what it cost. Nothing on it is a number we invented, and a failed job gets
 * a card as readily as a passing one, because a wall that only shares its wins is an advertisement.
 *
 * It is drawn rather than photographed: an SVG the server renders per job, so it is always the job
 * as it stands rather than a picture taken once and left to rot.
 */
import type { Tile } from "./gallery.ts";
import { standingWords } from "./gallery.ts";
import { inCoins, lengthOf, SITE, stampOf } from "./web/site/copy.ts";
import { MONAD_TESTNET } from "./registry.ts";

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * The ink each verdict is stamped in: the same as the pages' --paid-ink and its neighbours in
 * public/wall.css, which an image cannot read, so they are written here as well.
 */
const INKS: Record<Tile["verdict"], string> = {
  passed: "#117a43",
  failed: "#ff2e88",
  "not-reproducible": "#9a6a00",
  running: "#2448d6",
};

/** The poster's colours and faces, for an image that cannot load the stylesheet or the fonts. */
const POSTER = { yellow: "#ffe500", ink: "#0b0b0b", pink: "#ff2e88", shout: "'Big Shoulders Display', Impact, 'Arial Narrow', sans-serif", type: "'Special Elite', 'Courier New', monospace" } as const;

/** Break a line into at most three, at word boundaries, the way a headline is set. */
export function headline(idea: string, perLine = 30, lines = 3): readonly string[] {
  const words = idea.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= perLine) line = `${line} ${word}`;
    else { out.push(line); line = word; }
    if (out.length === lines) break;
  }
  if (out.length < lines && line) out.push(line);
  if (out.length === lines && words.join(" ").length > out.join(" ").length) {
    out[lines - 1] = `${out[lines - 1]!.slice(0, perLine - 1)}…`;
  }
  return out;
}

export function renderCard(tile: Tile): string {
  const lines = headline(tile.idea.toUpperCase(), 26);
  const ink = INKS[tile.verdict];
  const crew = `${tile.pod.length} ${tile.pod.length === 1 ? "seat" : "seats"}`;
  const facts = [tile.seconds ? lengthOf(tile.seconds) : "", inCoins(tile.price.toString(), MONAD_TESTNET.coin), crew].filter(Boolean).join("  ·  ");
  const standing = standingWords(tile);

  const title = lines.map((line, i) =>
    `<text x="64" y="${224 + i * 76}" font-family="${POSTER.shout}" font-size="72" font-weight="900" fill="${POSTER.ink}">${escape(line)}</text>`,
  ).join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <title>${escape(tile.idea)}: ${escape(standing)}</title>
  <rect width="1200" height="630" fill="${POSTER.yellow}"/>
  <rect x="0" y="0" width="1200" height="64" fill="${POSTER.ink}"/>
  <text x="64" y="44" font-family="${POSTER.shout}" font-size="36" font-weight="900" fill="${POSTER.yellow}">POD</text>
  <text x="150" y="42" font-family="${POSTER.type}" font-size="20" fill="${POSTER.yellow}">Proof of Development</text>
  ${title}
  <g transform="rotate(-6 1000 470)"><rect x="840" y="428" width="320" height="84" fill="none" stroke="${ink}" stroke-width="6"/>
  <text x="1000" y="492" text-anchor="middle" font-family="${POSTER.shout}" font-size="60" font-weight="900" fill="${ink}">${escape(stampOf(tile).toUpperCase())}</text></g>
  <text x="64" y="500" font-family="${POSTER.type}" font-size="30" font-weight="700" fill="${POSTER.ink}">${escape(standing)}</text>
  <text x="64" y="546" font-family="${POSTER.type}" font-size="24" fill="${POSTER.ink}">${escape(facts)}</text>
  <text x="64" y="590" font-family="${POSTER.type}" font-size="22" fill="${POSTER.ink}">${escape(tile.verdict === "running" ? SITE.share.running : SITE.share.decided)}</text>
</svg>`;
}
