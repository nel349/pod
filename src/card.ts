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
import { verdictWords } from "./gallery.ts";
import { MONAD_TESTNET } from "./registry.ts";

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const COLOURS: Record<Tile["verdict"], string> = {
  passed: "#1d6f45",
  failed: "#9a3412",
  "not-reproducible": "#6b5b16",
  running: "#2f4fd4",
};

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

const took = (seconds?: number): string => {
  if (seconds === undefined) return "";
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} minutes` : `${(minutes / 60).toFixed(1)} hours`;
};

export function renderCard(tile: Tile): string {
  const lines = headline(tile.idea);
  const colour = COLOURS[tile.verdict];
  const price = `${(Number(tile.price) / 1e18).toFixed(2)} ${MONAD_TESTNET.coin}`;
  const crew = `${tile.pod.length} ${tile.pod.length === 1 ? "seat" : "seats"}`;
  const time = took(tile.seconds);

  const title = lines.map((line, i) =>
    `<text x="64" y="${232 + i * 62}" font-size="52" font-weight="700" fill="#17181c">${escape(line)}</text>`,
  ).join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif">
  <title>${escape(tile.idea)}: ${escape(verdictWords(tile.verdict))}</title>
  <rect width="1200" height="630" fill="#f6f5f2"/>
  <rect x="0" y="0" width="1200" height="10" fill="${colour}"/>
  <text x="64" y="112" font-size="22" letter-spacing="3" fill="#5d6068">PROOF OF DEVELOPMENT</text>
  ${title}
  <text x="64" y="486" font-size="30" font-weight="600" fill="${colour}">${escape(verdictWords(tile.verdict))}</text>
  <text x="64" y="532" font-size="24" fill="#5d6068">${escape([time, price, crew].filter(Boolean).join("  ·  "))}</text>
  <text x="64" y="578" font-size="20" fill="#5d6068">Nobody was paid until somebody else ran the checks again.</text>
</svg>`;
}
