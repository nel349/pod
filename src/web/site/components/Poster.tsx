import type { ReactElement, ReactNode } from "react";
import { SITE } from "../copy.ts";

/** A page's layout: the bill on the left, its sheets on the right, and the line at the foot of every page. */
export function Poster({ bill, children }: { readonly bill: ReactNode; readonly children: ReactNode }): ReactElement {
  return (
    <div className="poster">
      {bill}
      <main className="sheets">
        {children}
        <footer className="foot"><p>{SITE.footer}</p></footer>
      </main>
    </div>
  );
}
