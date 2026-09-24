import type { CSSProperties, ReactElement } from "react";
import { COPY, SEAL_CENTRE, SEAL_RADIUS, SHARDS, STEPS, type Progress, type Shard, type StepName } from "../state/index.ts";

interface ShardSealProps {
  readonly progress: Progress;
  /** the step the page is working on right now, whose shards tremble while it waits */
  readonly working?: StepName;
  /** changes each time the checks come back proven, which makes the seal flash once */
  readonly flash?: number;
}

/** the drawing's box: the seal's own 200 × 200, with room around it for loose shards */
const VIEW_BOX = "-60 -60 320 320";

const styleOf = (shard: Shard): CSSProperties => ({
  "--depth": shard.depth,
  "--sx": `${shard.scatter.x}px`,
  "--sy": `${shard.scatter.y}px`,
  "--turn": `${shard.scatter.turn}deg`,
  "--scale": shard.scatter.scale,
  "--delay": `${shard.delay}ms`,
  "--duration": `${shard.duration}ms`,
});

/**
 * The job, assembling. Shards lie scattered until their step is finished, then fly into place. It
 * draws and nothing else: which shards are placed comes in as props, and the drift with the pointer
 * is the stylesheet reading --mx and --my, which the page sets once for the whole document.
 */
export function ShardSeal({ progress, working, flash = 0 }: ShardSealProps): ReactElement {
  return (
    <svg
      className={progress.isComplete ? "shard-seal complete" : "shard-seal"}
      viewBox={VIEW_BOX}
      role="img"
      aria-label={COPY.sealLabel(progress.placed.size, STEPS.length)}
    >
      {SHARDS.map((shard) => {
        const isPlaced = progress.placed.has(shard.piece);
        const trembling = working === shard.piece ? " trembling" : "";
        return (
          <g className="drift" style={styleOf(shard)} key={shard.id}>
            <polygon
              className={`shard ${isPlaced ? "placed" : "loose"} tone-${shard.loose} piece-${shard.piece}${trembling}`}
              points={shard.points}
            />
          </g>
        );
      })}
      {/* a new key replays the flash: once, each time a set of checks comes back proven */}
      {flash > 0 && <circle className="flash" key={flash} cx={SEAL_CENTRE} cy={SEAL_CENTRE} r={SEAL_RADIUS} />}
    </svg>
  );
}
