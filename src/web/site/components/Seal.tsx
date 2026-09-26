import type { ReactElement } from "react";
import { sealPieces } from "../../../seal.ts";
import type { TileView } from "../views.ts";

/**
 * The job drawn as the thing that decides it: five wedges, one per seat. Closed when the checks
 * passed, broken when they failed, never settling when the runs disagreed, and with gaps where seats
 * are still open. Decoration for the eye: the words beside it say the same for everybody else.
 */
export function Seal({ tile, isLarge = false }: { readonly tile: Pick<TileView, "verdict" | "pod">; readonly isLarge?: boolean }): ReactElement {
  const pieces = sealPieces({ verdict: tile.verdict, pod: tile.pod }, isLarge ? { inner: 30, outer: 46 } : {});
  return (
    <svg className={`seal ${tile.verdict}${isLarge ? " large" : ""}`} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      {pieces.map((piece, index) => (
        <path key={piece.role} className={`piece ${piece.isTaken ? "held" : "free"} piece-${index}`} d={piece.d} />
      ))}
    </svg>
  );
}
