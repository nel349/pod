/**
 * The seal, cut into shards.
 *
 * A ring of five wedges (one per seat, as on the wall) and a centre, each cut into triangles. Every
 * shard knows where it belongs and where it lies while its piece is not yet in place, and both are
 * fixed by a seed, so the page draws the same scatter on every load.
 */
import { STEPS, type StepName } from "./steps.ts";

export type Tone = "ink" | "pink" | "paper";

export interface Shard {
  /** stable across renders and loads, so React can tell one shard from another */
  readonly id: number;
  /** the step whose finishing puts this shard in place */
  readonly piece: StepName;
  /** the triangle, where it belongs, in a 200 × 200 box */
  readonly points: string;
  /** where it lies while scattered, relative to where it belongs */
  readonly scatter: { readonly x: number; readonly y: number; readonly turn: number; readonly scale: number };
  /** how far it moves with the pointer: shards further out drift more, so the seal has depth */
  readonly depth: number;
  /** its colour while scattered, before it takes its piece's colour */
  readonly loose: Tone;
  /** a small stagger, so a piece lands shard by shard rather than as a block */
  readonly delay: number;
  readonly duration: number;
}

type Point = readonly [number, number];

// ---- the seal's shape, in the 200 × 200 box ----
const CENTRE = 100;
const OUTER = 94;
/** where the seal sits and how far it reaches, for anything drawn over it */
export const SEAL_CENTRE = CENTRE;
export const SEAL_RADIUS = OUTER + 4;
const INNER = 44;
const WEDGES = 5;
/** the gap between wedges, in degrees: five seats, visibly separate */
const GAP = 4;
/** each wedge is cut this many times around, and this many times outward */
const SLICES = 4;
const BANDS = 2;
const CENTRE_SLICES = 10;
/** the centre is a little smaller than the hole, so it reads as its own piece */
const HUB = INNER - GAP * 1.5;

// ---- how the shards lie while loose ----
/** where loose shards may lie: the drawing's square, a little inside its edges */
const SCATTER_FROM = -40;
const SCATTER_TO = 240;
const MOST_TURN_DEGREES = 200;
const SMALLEST_LOOSE = 0.35;
const LOOSE_SCALE_RANGE = 0.6;
/** a loose shard's colour, drawn from this: ink twice as often as the others */
const LOOSE_TONES: readonly Tone[] = ["ink", "pink", "paper", "ink"];

// ---- how they move ----
const LEAST_DEPTH = 0.4;
const DEPTH_WITH_RADIUS = 1.6;
const DEPTH_JITTER = 0.4;
const MOST_DELAY_MS = 360;
const SHORTEST_FLIGHT_MS = 700;
const FLIGHT_RANGE_MS = 700;

/** the seed the page uses, so everybody sees the same scatter */
export const SEAL_SEED = 8004;

/** A small seeded generator (mulberry32): the same seed, the same scatter, everywhere. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const at = (radius: number, degrees: number): Point => {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return [CENTRE + radius * Math.cos(radians), CENTRE + radius * Math.sin(radians)];
};

const centroid = (corners: readonly Point[]): Point => [
  corners.reduce((sum, [x]) => sum + x, 0) / corners.length,
  corners.reduce((sum, [, y]) => sum + y, 0) / corners.length,
];

export function cutTheSeal(seed = SEAL_SEED): readonly Shard[] {
  const random = seeded(seed);
  const between = (from: number, range: number): number => from + random() * range;
  const shards: Shard[] = [];

  const add = (piece: StepName, corners: readonly Point[], radius: number): void => {
    // a loose shard lies somewhere inside the seal's own square, never out over the words beside it
    const [cx, cy] = centroid(corners);
    shards.push({
      id: shards.length,
      piece,
      points: corners.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" "),
      scatter: {
        x: between(SCATTER_FROM, SCATTER_TO - SCATTER_FROM) - cx,
        y: between(SCATTER_FROM, SCATTER_TO - SCATTER_FROM) - cy,
        turn: between(-MOST_TURN_DEGREES, 2 * MOST_TURN_DEGREES),
        scale: between(SMALLEST_LOOSE, LOOSE_SCALE_RANGE),
      },
      depth: LEAST_DEPTH + (radius / OUTER) * DEPTH_WITH_RADIUS + random() * DEPTH_JITTER,
      loose: LOOSE_TONES[Math.floor(random() * LOOSE_TONES.length)] ?? "ink",
      delay: Math.round(random() * MOST_DELAY_MS),
      duration: Math.round(between(SHORTEST_FLIGHT_MS, FLIGHT_RANGE_MS)),
    });
  };

  // five wedges, one per seat, which are the first five steps of posting
  const span = 360 / WEDGES;
  STEPS.slice(0, WEDGES).forEach((piece, wedge) => {
    const from = wedge * span + GAP / 2;
    const step = (span - GAP) / SLICES;
    for (let cell = 0; cell < SLICES * BANDS; cell++) {
      const slice = Math.floor(cell / BANDS);
      const band = cell % BANDS;
      const r1 = INNER + ((OUTER - INNER) * band) / BANDS;
      const r2 = INNER + ((OUTER - INNER) * (band + 1)) / BANDS;
      const a1 = from + slice * step;
      const a2 = a1 + step;
      add(piece, [at(r1, a1), at(r2, a1), at(r2, a2)], r2);
      add(piece, [at(r1, a1), at(r2, a2), at(r1, a2)], r1);
    }
  });

  // the centre, which only paying puts in place
  for (let slice = 0; slice < CENTRE_SLICES; slice++) {
    const a1 = (slice * 360) / CENTRE_SLICES;
    const a2 = ((slice + 1) * 360) / CENTRE_SLICES;
    add("pay", [[CENTRE, CENTRE], at(HUB, a1), at(HUB, a2)], HUB / 2);
  }
  return shards;
}

/** The page's seal: cut once, since the seed fixes it, and shared by every copy drawn. */
export const SHARDS: readonly Shard[] = cutTheSeal();
