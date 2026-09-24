/**
 * Git's own server for its HTTP protocol, behind our door.
 *
 * `git http-backend` is the program every git host that is not a product runs: it speaks the whole
 * protocol, clone, fetch and push, and it runs the repository's hooks, which is where the rules for
 * what a push may change are kept. It is a CGI program, so this hands it a request as environment
 * variables and standard input, and turns what it prints into a response.
 *
 * It gets a clean environment. Hooks run inside it, and the server's own environment holds the keys
 * that sign verdicts: nothing in it is anything a push needs.
 */

export interface BackendCall {
  readonly request: Request;
  /** the folder holding every job's repository */
  readonly projectRoot: string;
  /** `/<job>.git/<what git asked for>` */
  readonly pathInfo: string;
  /** who the door let in. Git will not take a push from anybody it was not told the name of */
  readonly remoteUser: string;
  /** what the hooks need to know, and the settings the repository runs under for this request */
  readonly env: Readonly<Record<string, string>>;
}

/** how much of what the backend printed to its error stream goes into a failure */
const LONGEST_COMPLAINT = 600;

export async function gitHttpBackend(call: BackendCall): Promise<Response> {
  const { request } = call;
  const url = new URL(request.url);
  const header = (name: string): Record<string, string> => {
    const value = request.headers.get(name);
    return value === null ? {} : { [`HTTP_${name.toUpperCase().replaceAll("-", "_")}`]: value };
  };
  const length = request.headers.get("content-length");

  const child = Bun.spawn(["git", "http-backend"], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      // no machine's git settings, only the ones given here
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_PROJECT_ROOT: call.projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: call.pathInfo,
      REQUEST_METHOD: request.method,
      QUERY_STRING: url.search.slice(1),
      REMOTE_USER: call.remoteUser,
      REMOTE_ADDR: "127.0.0.1",
      CONTENT_TYPE: request.headers.get("content-type") ?? "",
      ...(length === null ? {} : { CONTENT_LENGTH: length }),
      ...header("content-encoding"),
      ...header("git-protocol"),
      ...call.env,
    },
    stdin: request.body ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // read from the start so a talkative backend never blocks on a full pipe; only a failure waits for it
  const complaint = new Response(child.stderr).text();

  const reader = child.stdout.getReader();
  let held: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  let split = -1;
  while (split === -1) {
    const { done, value } = await reader.read();
    if (done) {
      const said = (await complaint).slice(0, LONGEST_COMPLAINT);
      return new Response(`git could not answer that: ${said || `it stopped with code ${await child.exited}`}\n`, { status: 500 });
    }
    held = joined(held, value);
    split = endOfHeaders(held);
  }

  const { status, headers } = cgiHeaders(new TextDecoder().decode(held.subarray(0, split)));
  const rest = held.subarray(split + separatorLength(held, split));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (rest.length > 0) controller.enqueue(rest);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() {
      child.kill();
    },
  });
  return new Response(body, { status, headers });
}

function joined(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const both = new Uint8Array(a.length + b.length);
  both.set(a);
  both.set(b, a.length);
  return both;
}

const CR = 13;
const LF = 10;

/** Where the header block ends: the first blank line, which CGI allows to be written either way. */
function endOfHeaders(bytes: Uint8Array): number {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === LF && bytes[i + 1] === LF) return i;
    if (bytes[i] === CR && bytes[i + 1] === LF && bytes[i + 2] === CR && bytes[i + 3] === LF) return i;
  }
  return -1;
}

function separatorLength(bytes: Uint8Array, at: number): number {
  return bytes[at] === CR ? 4 : 2;
}

/** A CGI header block: a `Status:` line if the program set one, and the headers to pass on. */
function cgiHeaders(block: string): { readonly status: number; readonly headers: Headers } {
  const headers = new Headers();
  let status = 200;
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 500;
    else headers.append(name, value);
  }
  return { status, headers };
}
