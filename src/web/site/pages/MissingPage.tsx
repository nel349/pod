import type { ReactElement } from "react";
import { ROUTES } from "../../../routes.ts";
import { Sheet } from "../../shared/index.ts";
import { PageBill, Poster } from "../components/index.ts";
import { SITE } from "../copy.ts";

/** An address with nothing at it, said as a page in the same look, with the way back. */
export function MissingPage({ why }: { readonly why: string }): ReactElement {
  return (
    <Poster bill={<PageBill words={{ eyebrow: "404", shout: SITE.missing.shout, strap: SITE.missing.strap }} />}>
      <Sheet number={1} id="missing" title={why} stamp={false}>
        <p><a className="primary" href={ROUTES.wall}>{SITE.missing.back}</a></p>
      </Sheet>
    </Poster>
  );
}
