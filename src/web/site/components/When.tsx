import type { ReactElement } from "react";
import { ClientOnly } from "../../shared/index.ts";
import { whenHere, whenInUTC } from "../copy.ts";

/**
 * A moment, said in the reader's own time. The server cannot know the reader's zone, so it says UTC,
 * and the browser says it again in local time once the page is in its hands.
 */
export function When({ iso }: { readonly iso: string }): ReactElement {
  return (
    <time dateTime={iso}>
      <ClientOnly fallback={whenInUTC(iso)}>{whenHere(iso)}</ClientOnly>
    </time>
  );
}
