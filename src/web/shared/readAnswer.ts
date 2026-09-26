import type { z } from "zod";

/**
 * What the server said, read through a schema, or an error a person can read.
 *
 * A proxy in front of the server can answer with an HTML error page, and a reply can be the wrong
 * shape. Neither should reach the poster as "JSON Parse error: Unexpected token '<'" or a page of
 * schema detail: either way the honest sentence is that the server's answer could not be read, and
 * with which status.
 */
export async function readAnswer<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`the server said ${response.status}, and not in a form this page can read`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error(`the server said ${response.status}, and not in the shape this page expects`);
  return parsed.data;
}
