/**
 * The chain's own endpoint, standing where MetaMask's tool expects its chain-reading service.
 *
 * Before the tool sends anything it asks the chain what the payment's gas is, what the fee is and
 * what the wallet holds, and it asks MetaMask's service, which answers "Invalid chainId" for Monad
 * testnet: the wallet will broadcast there, and the tool cannot get as far as asking it. So for the
 * length of one command this listens on this machine alone, takes those questions, and passes each to
 * the chain's own endpoint. Only the question goes on: whatever the tool sent to sign in with stays
 * here.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";

/** this machine and nothing else: the tool takes an address of its own only when it is this one */
const THIS_MACHINE = "127.0.0.1";
const JSON_TYPE = { "content-type": "application/json" } as const;

export interface PassThrough {
  /** where the tool is pointed while this stands */
  readonly base: string;
  readonly stop: () => Promise<void>;
}

function bodyOf(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    request.on("error", reject);
  });
}

/** Listen on this machine, on a port of the system's choosing, and pass every question to `rpc`. */
export function startPassThrough(rpc: string): Promise<PassThrough> {
  const server: Server = createServer((request, response) => {
    void (async () => {
      // the tool looks before it asks; only a question is passed on
      if (request.method !== "POST") {
        response.writeHead(200, JSON_TYPE).end("{}");
        return;
      }
      try {
        const answer = await fetch(rpc, { method: "POST", headers: JSON_TYPE, body: await bodyOf(request) });
        response.writeHead(answer.status, JSON_TYPE).end(await answer.text());
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        response.writeHead(502, JSON_TYPE).end(JSON.stringify({ error: `the chain's endpoint could not be reached: ${why}` }));
      }
    })();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, THIS_MACHINE, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the pass-through was given no port to listen on"));
        return;
      }
      resolve({
        base: `http://${THIS_MACHINE}:${address.port}`,
        stop: () => new Promise((stopped) => { server.close(() => stopped()); server.closeAllConnections(); }),
      });
    });
  });
}
