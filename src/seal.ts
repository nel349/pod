/**
 * The seal: a job drawn as the thing that decides it.
 *
 * Five wedges, one per seat, because a pod is five seats that are paid together or not at all. The
 * shape is the mechanism rather than an ornament for it:
 *
 *   still open            only the seats that are taken are drawn; the rest are gaps
 *   checks passed         the ring closes
 *   checks failed         the ring is broken, and you can see which way the pieces went
 *   could not be repeated the wedges never settle, because the runs never agreed
 *
 * It is drawn on the server, so it is the job as it stands rather than a picture of it, and it is
 * geometry rather than a font or an emoji so it holds at any size.
 */
import type { Tile } from "./gallery.ts";

/** The five seats, in the order the ring draws them, which is the order the work happens in. */
export const SEATS = ["lead", "builder", "reviewer", "qa", "security"] as const;

const TURN = Math.PI * 2;

function point(radius: number, angle: number): string {
  return `${(50 + radius * Math.cos(angle)).toFixed(2)} ${(50 + radius * Math.sin(angle)).toFixed(2)}`;
}

/** One wedge of the ring: an annular sector between two angles. */
function wedge(from: number, to: number, inner: number, outer: number): string {
  const large = to - from > Math.PI ? 1 : 0;
  return [
    `M ${point(outer, from)}`,
    `A ${outer} ${outer} 0 ${large} 1 ${point(outer, to)}`,
    `L ${point(inner, to)}`,
    `A ${inner} ${inner} 0 ${large} 0 ${point(inner, from)}`,
    "Z",
  ].join(" ");
}

export interface SealOptions {
  /** how far the pieces sit apart. A closed ring is tight; a broken one is not */
  readonly gap: number;
  readonly inner: number;
  readonly outer: number;
}

/** One piece of the seal: the seat it stands for, whether it is taken, and its outline. */
export interface SealPiece {
  readonly role: (typeof SEATS)[number];
  readonly isTaken: boolean;
  /** the SVG path of the wedge, in a 100 by 100 box */
  readonly d: string;
}

/**
 * The seal for one job, as pieces for a page to draw.
 *
 * A seat nobody has taken is drawn as an outline, so an open job looks unfinished because it is.
 */
export function sealPieces(tile: { readonly verdict: Tile["verdict"]; readonly pod: readonly { readonly role: string }[] }, options: Partial<SealOptions> = {}): readonly SealPiece[] {
  const gap = options.gap ?? (tile.verdict === "failed" ? 0.16 : 0.055);
  const inner = options.inner ?? 26;
  const outer = options.outer ?? 44;

  const held = new Set(tile.pod.map((seat) => seat.role));
  const slice = TURN / SEATS.length;

  return SEATS.map((role, index) => {
    // start at the top, and run clockwise, so the lead's piece is where an eye lands first
    const from = index * slice - TURN / 4 + gap / 2;
    const to = from + slice - gap;
    return { role, isTaken: held.has(role), d: wedge(from, to, inner, outer) };
  });
}
