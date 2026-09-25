/**
 * A request's body, if it is within what that route should ever be sent. The declared length is
 * checked before anything is read, and the body is then counted as it arrives, in bytes, and dropped
 * the moment it passes the limit: a sender that declares nothing, or lies, cannot make the server hold
 * more than the route allows just to be told it was too large.
 */
export async function bodyWithin(request: Request, most: number): Promise<string | undefined> {
  if (Number(request.headers.get("content-length") ?? "0") > most) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > most) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(whole);
}

/**
 * The answer to a body that was too large. The connection is closed with it: the sender may still be
 * sending the rest, and a connection used again would read that as the start of the next request.
 */
export function tooLarge(why: string): Response {
  return Response.json({ why }, { status: 413, headers: { connection: "close" } });
}
