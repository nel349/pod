import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import { firstLine } from "../../../errors.ts";
import { linksIn, ReferenceLinksSchema, ReferenceReadSchema, type ReferenceRead } from "../../../references/Reference.ts";
import { ROUTES } from "../../../routes.ts";

export interface ReferencesRead {
  /** ask the server whether each link can be read; nothing is asked when there are none, or one is not a link */
  readonly read: (typed: string) => void;
  readonly isReading: boolean;
  /** what reading each link came to, in the order they were typed */
  readonly found: readonly ReferenceRead[] | undefined;
  /** why none of them could be asked after, such as the server not answering */
  readonly why: string | undefined;
}

/** What reading each link comes to, asked of the server, which is what fetches them. Nothing is kept by asking. */
export async function readReferences(links: readonly string[]): Promise<readonly ReferenceRead[]> {
  const response = await fetch(ROUTES.references, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(links) });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(z.object({ why: z.string() }).safeParse(body).data?.why ?? `the server said ${response.status}`);
  return z.array(ReferenceReadSchema).parse(body);
}

/**
 * Whether the links a poster typed can be read, asked of the server before they pay: it is the server
 * that fetches them, so only it can say.
 */
export function useReferencesRead(): ReferencesRead {
  const reading = useMutation({ mutationFn: readReferences });
  return {
    read: (typed) => {
      const links = ReferenceLinksSchema.safeParse(linksIn(typed));
      if (!links.success || links.data.length === 0) reading.reset();
      else reading.mutate(links.data);
    },
    isReading: reading.isPending,
    found: reading.data,
    why: reading.error ? firstLine(reading.error) : undefined,
  };
}
