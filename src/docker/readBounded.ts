/**
 * Read what a box printed, keeping only so much of it.
 *
 * A box runs code we did not write, and that code can print without end. Reading it whole let one
 * job's flood hold the worker's memory, and fail its own grading every time it was tried again. So the
 * start and the end are kept, which is where a reason usually is, and the middle is counted and let go.
 * The stream is still read to its end, so the box is never left stuck on a full pipe.
 */
export const MOST_KEPT_BYTES = 64 * 1024;

export async function readBounded(stream: ReadableStream<Uint8Array>, most: number = MOST_KEPT_BYTES): Promise<string> {
  const headRoom = Math.ceil(most / 2);
  const tailRoom = most - headRoom;
  const head: Uint8Array[] = [];
  const tail: Uint8Array[] = [];
  let headBytes = 0;
  let tailBytes = 0;
  let total = 0;

  for await (const chunk of stream) {
    total += chunk.byteLength;
    // copied rather than viewed, so a kept sliver never holds a large chunk in memory
    const intoHead = Math.min(headRoom - headBytes, chunk.byteLength);
    if (intoHead > 0) {
      head.push(chunk.slice(0, intoHead));
      headBytes += intoHead;
    }
    if (intoHead === chunk.byteLength) continue;
    tail.push(chunk.slice(intoHead));
    tailBytes += chunk.byteLength - intoHead;
    while (tailBytes > tailRoom) {
      const first = tail[0];
      if (!first) break;
      const excess = tailBytes - tailRoom;
      if (first.byteLength <= excess) {
        tail.shift();
        tailBytes -= first.byteLength;
      } else {
        tail[0] = first.slice(excess);
        tailBytes -= excess;
      }
    }
  }

  const dropped = total - headBytes - tailBytes;
  if (dropped === 0) return Buffer.concat([...head, ...tail]).toString("utf8");
  return `${Buffer.concat(head).toString("utf8")}\n[${dropped} bytes not kept]\n${Buffer.concat(tail).toString("utf8")}`;
}
