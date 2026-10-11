/**
 * What a job is, and what it commits to.
 *
 * A job has to be sealed before it opens, or a pod can build the thing in advance and win by having
 * started early. So the person posting it publishes a hash first and the text later, and anyone can
 * check afterwards that the text they were given is the text that was sealed.
 *
 * The same hashing gives us the key the chain uses: one request per verdict, keyed by the job, the
 * commit and the runner, so the same verdict is never written twice and a late one cannot overwrite
 * an earlier one.
 */

/** How long a pod has, and how quiet it may go before its seat is released, shortest first. */
export const MODE_NAMES = ["flash", "sprint", "project"] as const;

export type Mode = (typeof MODE_NAMES)[number];

export const MODES: Record<Mode, { readonly windowMinutes: number; readonly idleMinutes: number }> = {
  flash: { windowMinutes: 120, idleMinutes: 10 },
  sprint: { windowMinutes: 24 * 60, idleMinutes: 30 },
  project: { windowMinutes: 7 * 24 * 60, idleMinutes: 120 },
};

export type Role = "lead" | "builder" | "reviewer" | "qa" | "security";

/**
 * What is being built, as far as grading is concerned.
 *
 * Grading drives the work from outside, over the network, so each is something that answers on a
 * port: a website, a folder of files served as they are; a service another program calls; or a page
 * a program of the pod's own draws, which is how a job asked for a page before websites were files.
 * The difference is what a check looks at (what a person would see, or the data that comes back)
 * and the check writer needs to know which. Anything else (a command-line tool, a library, a
 * contract) cannot be graded from outside the box yet, and is not offered.
 */
export const KINDS = ["page", "service", "site"] as const;

export type Kind = (typeof KINDS)[number];

/**
 * The kinds a new job may be: a website, which is published at a live address when it is delivered,
 * or a service. A page drawn by a program is still read and graded for the jobs that asked for one.
 */
export const OFFERED_KINDS = ["site", "service"] as const satisfies readonly Kind[];

/** Where the work answers inside its box, which is what every check is pointed at. */
export const PORT = 3000;

/** The one file posted work is, when it is a program */
export const WORK_FILE = "server.js";

/** How posted work is started in its box, when it is a program: one file, run by node, answering on PORT. */
export const START = `node ${WORK_FILE}`;

/** The folder a website is: its files as they are served, with its front page at the top */
export const SITE_FOLDER = "site";
export const SITE_FRONT_PAGE = "index.html";

/**
 * How a website is served in its box, for its checks: the files in its folder and nothing else, on
 * PORT. The pod supplies no program here, so none of theirs runs; this one is the same for every
 * website, and is written into each receipt, so anybody repeating a verdict serves the files the
 * same way. A file is found at its own address, as a folder's front page, or with .html left off,
 * the way the hosts websites go live on find them. Nothing above the folder is ever served, and
 * neither is a link, wherever it points: a link is not published either, so it is not checked.
 *
 * Written as one line with no single quote in it, since it is handed to a shell inside one pair.
 */
const SITE_SERVER = [
  `const http=require("http"),fs=require("fs"),path=require("path");`,
  `const root=(()=>{try{return fs.realpathSync(${JSON.stringify(SITE_FOLDER)})}catch{return path.resolve(${JSON.stringify(SITE_FOLDER)})}})();`,
  `const types={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".json":"application/json",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp",".ico":"image/x-icon",".txt":"text/plain; charset=utf-8",".woff2":"font/woff2"};`,
  `const inside=(file)=>file===root||file.startsWith(root+path.sep);`,
  `const isFile=(file)=>{try{return fs.lstatSync(file).isFile()&&inside(fs.realpathSync(file))}catch{return false}};`,
  `http.createServer((request,response)=>{`,
  `let asked;try{asked=decodeURIComponent(new URL(request.url,"http://site").pathname)}catch{response.writeHead(400,{"content-type":"text/plain; charset=utf-8"});response.end("not an address");return}`,
  `const at=path.join(root,asked);`,
  `const found=[at,path.join(at,${JSON.stringify(SITE_FRONT_PAGE)}),at+".html"].find((file)=>inside(file)&&isFile(file));`,
  `if(!found){response.writeHead(404,{"content-type":"text/plain; charset=utf-8"});response.end("not found");return}`,
  `response.writeHead(200,{"content-type":types[path.extname(found).toLowerCase()]||"application/octet-stream"});`,
  `fs.createReadStream(found).pipe(response);`,
  `}).listen(${PORT});`,
].join("");

export const SERVE_THE_SITE = `node -e '${SITE_SERVER}'`;

/** How a job's work is started in its box: a website's files are served as they are, and a program is run. */
export function startFor(kind: Kind | undefined): string {
  return kind === "site" ? SERVE_THE_SITE : START;
}

/** The one file the reference builder writes for a job: a website's front page, or the program. */
export function workFileFor(kind: Kind | undefined): string {
  return kind === "site" ? `${SITE_FOLDER}/${SITE_FRONT_PAGE}` : WORK_FILE;
}

/** One thing that must be true before anyone is paid. Objective, or it does not belong here. */
export interface Check {
  /** what a person reads on the tile, for example "the page loads and shows a score" */
  readonly says: string;
  /** the command the checks box runs against the artefact */
  readonly run: string;
  /** whether the pod gets to see this one. Hidden checks are the reason the box is sealed */
  readonly hidden: boolean;
  /** the file the command runs, by name */
  readonly file?: string;
  /**
   * The file's fingerprint, sealed with everything else.
   *
   * Without this the seal covers the command — `node weak.mjs` — but not what `weak.mjs` says, and
   * the hidden check that decides whether anybody is paid could be swapped after the job was posted
   * without the seal noticing. With it, whoever holds the checks cannot change one, and anybody can
   * prove it when they are published.
   */
  readonly digest?: `0x${string}`;
}

/**
 * How a check file is run in the checks box. One definition, because the command is sealed: a page
 * that wrote it one way and a server that rebuilt it another would never agree on the seal.
 */
export const checkCommand = (file: string): string => `node ${file}`;

/** The mode a new job starts in, unless the poster chooses another: the shortest. */
export const DEFAULT_MODE: Mode = "flash";

/** Something the artefact is allowed to reach at grading time. Anything else is a finding. */
export interface Allowed {
  readonly host: string;
  readonly why: string;
}

/**
 * How the checks ask for something the poster's words left open, such as the time of day or a roll
 * of a die, which a check cannot wait for: it asks for a chosen value instead. The check writer
 * chooses the obvious way and says it twice. Plainly, for the poster, who reads it before paying.
 * Exactly, for the pod, which has to build the way the checks ask, the hidden ones included.
 */
export interface HowItIsAsked {
  /** in everyday words, with the values the checks use: "the checks look at 10 in the morning and 10 at night" */
  readonly plainly: string;
  /** what the work must accept, precisely: a parameter's name and form, and what happens without it */
  readonly exactly: string;
}

/** The fingerprint a proven "how it is asked" is written down under, so a posting cannot change it after proving. */
export function howItIsAskedDigest(asked: HowItIsAsked): Promise<`0x${string}`> {
  return digestOf(JSON.stringify({ plainly: asked.plainly, exactly: asked.exactly }));
}

/** The text of the job. Sealed before it opens, published when it does. */
export interface Spec {
  readonly idea: string;
  /** absent on jobs sealed before the page asked, which the seal must still match */
  readonly kind?: Kind;
  readonly mode: Mode;
  /** what the pod is paid, in the smallest unit of whatever pays */
  readonly price: bigint;
  readonly checks: readonly Check[];
  readonly allowed: readonly Allowed[];
  /** how the checks ask for what the poster's words left open, when they had to. Absent when nothing was */
  readonly howItIsAsked?: HowItIsAsked;
  /** a number nobody can guess, so the hash cannot be brute forced from a short idea */
  readonly salt: string;
}

/** The shares each seat is paid, as percentages that must add up to one hundred. */
export const SHARES: Record<Role, number> = { lead: 20, builder: 40, reviewer: 15, qa: 15, security: 10 };

/** The seats ours thinks for with a model. The lead and QA never ask it anything */
export const NEEDS_A_MODEL: readonly Role[] = ["builder", "reviewer", "security"];

/**
 * The seats ours thinks for with a model where the builder puts its own work forward: the lead too,
 * which no longer names what ships there and judges the work like any other seat. QA still runs the
 * checks, and asks nothing.
 */
export const NEEDS_A_MODEL_TO_JUDGE: readonly Role[] = ["lead", ...NEEDS_A_MODEL];

/** A seat's deposit, as a percentage of what that seat is paid, as the contract has it (DEPOSIT_PERCENT). */
export const DEPOSIT_PERCENT = 10;

/** The seats whose approval the contract waits for. The builder's work is what they approve, so it approves nothing itself. */
export const APPROVING_SEATS: readonly Role[] = ["lead", "reviewer", "qa", "security"];

export function shareOf(price: bigint, role: Role): bigint {
  return (price * BigInt(SHARES[role])) / 100n;
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256(text: string): Promise<`0x${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `0x${hex}`;
}

/**
 * The commitment published when the job is posted.
 *
 * Key order and number formatting are normalised first, so the same job always hashes the same way
 * whichever language wrote it down.
 */
export function sealSpec(spec: Spec): Promise<`0x${string}`> {
  return sha256(canonical(spec));
}

/** The fingerprint of a check's file, computed the same way in a browser and on the server. */
export function digestOf(contents: string): Promise<`0x${string}`> {
  return sha256(contents);
}

/**
 * Whether the files in hand are the files that were sealed.
 *
 * Every check that names a file must have that file, with that fingerprint. A check with no digest
 * is refused rather than trusted: a job posted today seals its files, and one that did not is one
 * whose checks nobody can hold anybody to.
 */
export async function filesMatchSeal(
  spec: Spec,
  files: Readonly<Record<string, string>>,
): Promise<{ readonly ok: boolean; readonly why?: string }> {
  for (const check of spec.checks) {
    if (!check.file || !check.digest) return { ok: false, why: `"${check.says}" does not seal its file` };
    const contents = files[check.file];
    if (contents === undefined) return { ok: false, why: `${check.file} was sealed and not supplied` };
    if ((await digestOf(contents)) !== check.digest) {
      return { ok: false, why: `${check.file} is not the file that was sealed` };
    }
  }
  const named = new Set(spec.checks.map((check) => check.file));
  const extra = Object.keys(files).filter((name) => !named.has(name));
  if (extra.length > 0) return { ok: false, why: `${extra.join(", ")} was supplied and never sealed` };
  return { ok: true };
}

/** Check that the text we were handed is the text that was sealed. */
export async function specMatchesSeal(spec: Spec, seal: `0x${string}`): Promise<boolean> {
  return (await sealSpec(spec)) === seal.toLowerCase();
}

/** What the pod is allowed to see: everything except the hidden checks. */
export function publicSpec(spec: Spec): Omit<Spec, "checks" | "salt"> & { readonly checks: readonly Check[] } {
  const { salt: _salt, checks, ...rest } = spec;
  return { ...rest, checks: checks.filter((c) => !c.hidden) };
}

/**
 * The key for one verdict on the chain.
 *
 * It names the job, the exact commit and the runner that answered, so two runners produce two
 * requests rather than fighting over one, and nothing can be answered twice.
 */
export function verdictKey(input: {
  readonly seal: `0x${string}`;
  readonly commit: string;
  readonly runner: string;
}): Promise<`0x${string}`> {
  return sha256(`pod.verdict.v1|${input.seal}|${input.commit}|${input.runner.toLowerCase()}`);
}

/**
 * The key for one seat's verdict.
 *
 * The validation registry holds one agent per request, so a crew of five needs five: the same job,
 * the same commit, the same runner, but a record each. Using the job's key for all of them would
 * file the whole pod's work under whichever agent asked first, and the other four would have nothing
 * to show for it.
 */
export function seatVerdictKey(input: {
  readonly seal: `0x${string}`;
  readonly commit: string;
  readonly runner: string;
  readonly agent: string;
}): Promise<`0x${string}`> {
  return sha256(
    `pod.verdict.v1|${input.seal}|${input.commit}|${input.runner.toLowerCase()}|${input.agent.toLowerCase()}`,
  );
}

/** When a job must be finished by, and when a quiet seat is forfeited. */
export function deadlines(spec: Spec, startedAt: Date): { readonly endsAt: Date; readonly idleBy: Date } {
  const { windowMinutes, idleMinutes } = MODES[spec.mode];
  return {
    endsAt: new Date(startedAt.getTime() + windowMinutes * 60_000),
    idleBy: new Date(startedAt.getTime() + idleMinutes * 60_000),
  };
}
