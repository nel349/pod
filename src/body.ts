/**
 * A request's body, if it is within what that route should ever be sent. The declared length is
 * checked before anything is read, so a sender cannot make the server hold a large body in memory
 * just to be told it was too large; the actual length is checked too, because the declaration can lie.
 */
export async function bodyWithin(request: Request, most: number): Promise<string | undefined> {
  if (Number(request.headers.get("content-length") ?? "0") > most) return undefined;
  const body = await request.text();
  return body.length > most ? undefined : body;
}
