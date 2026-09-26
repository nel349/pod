import type { CSSProperties, ReactElement, ReactNode } from "react";

/** how far a sheet leans, in degrees: the first one way, the second the other, never straight */
const LEANS = [-0.5, 0.4] as const;

/** One numbered sheet taped to the wall, as the posting page's steps are: the claim and refund pages draw theirs with it. */
export function Sheet({ number, id, title, children }: {
  readonly number: number;
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  const lean: CSSProperties = { "--lean": `${LEANS[number % 2]}deg`, "--order": number } as CSSProperties;
  return (
    <section className="sheet" id={id} aria-labelledby={`${id}-title`} style={lean}>
      <span className="tape" aria-hidden="true" />
      <p className="stamp" aria-hidden="true">{String(number).padStart(2, "0")}</p>
      <h2 id={`${id}-title`}>{title}</h2>
      {children}
    </section>
  );
}
