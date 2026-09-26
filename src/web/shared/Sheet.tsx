import type { CSSProperties, ReactElement, ReactNode } from "react";

/** how far a sheet leans, in degrees: the first one way, the second the other, never straight */
const LEANS = [-0.5, 0.4] as const;

/**
 * One sheet taped to the wall, as the posting page's steps are. Stamped with its number where the
 * sheets are steps in order, or with a word where they are not, or with nothing.
 */
export function Sheet({ number, id, title, stamp, children }: {
  readonly number: number;
  readonly id: string;
  readonly title: string;
  /** what is stamped on it instead of its number; false for nothing */
  readonly stamp?: string | false;
  readonly children: ReactNode;
}): ReactElement {
  const lean: CSSProperties = { "--lean": `${LEANS[number % 2]}deg`, "--order": number };
  const mark = stamp === undefined ? String(number).padStart(2, "0") : stamp;
  return (
    <section className="sheet" id={id} aria-labelledby={`${id}-title`} style={lean}>
      <span className="tape" aria-hidden="true" />
      {mark !== false && <p className="stamp" aria-hidden="true">{mark}</p>}
      <h2 id={`${id}-title`}>{title}</h2>
      {children}
    </section>
  );
}
