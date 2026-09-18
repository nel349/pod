/**
 * Checking the live site the way a stranger would, before we ask anyone to look at it.
 *
 * This is not a test of the code. It is a test of the deployment: the pages a judge will open, the
 * links they will click, and the files they would have to fetch to check a verdict themselves. It
 * runs against a URL, so the same script covers the laptop and the real host.
 *
 * Every assertion is something that would embarrass us if it were false on the day.
 */
import { cardPath, checksPath, jobPath, receiptPath, ROUTES } from "./routes.ts";

export interface Finding {
  readonly what: string;
  readonly where: string;
  readonly detail: string;
}

export interface AuditOutcome {
  readonly checked: number;
  readonly findings: readonly Finding[];
  readonly jobs: readonly string[];
  readonly seconds: number;
}

/** Text that means a page rendered something it did not have. */
const HOLES = ["undefined", "NaN", "[object Object]", "null</", "&lt;no "];

export async function audit(base: string, get: typeof globalThis.fetch = globalThis.fetch): Promise<AuditOutcome> {
  const started = Date.now();
  const findings: Finding[] = [];
  let checked = 0;

  const site = base.replace(/\/$/, "");
  const look = async (path: string, what: string): Promise<Response | undefined> => {
    checked++;
    try {
      const response = await get(`${site}${path}`);
      if (!response.ok) findings.push({ what, where: path, detail: `came back ${response.status}` });
      return response;
    } catch (error) {
      findings.push({ what, where: path, detail: (error as Error).message });
      return undefined;
    }
  };

  const wall = await look(ROUTES.wall, "the wall loads");
  const html = (await wall?.text()) ?? "";
  if (wall?.ok) {
    const type = wall.headers.get("content-type") ?? "";
    if (!type.includes("text/html")) {
      findings.push({ what: "the wall is a page", where: ROUTES.wall, detail: `content-type was ${type}` });
    }
    for (const hole of HOLES) {
      if (html.includes(hole)) {
        findings.push({ what: "the wall has no holes in it", where: ROUTES.wall, detail: `the page contains "${hole}"` });
      }
    }
  }

  const style = await look(ROUTES.style, "the stylesheet the pages ask for exists");
  if (style?.ok && !(style.headers.get("content-type") ?? "").includes("text/css")) {
    findings.push({ what: "the stylesheet is css", where: ROUTES.style, detail: "it was served as something else" });
  }

  const jobs = jobsOn(html);
  if (jobs.length === 0 && !html.includes("Nothing has been built yet")) {
    findings.push({ what: "the wall shows jobs, or says it has none", where: ROUTES.wall, detail: "neither a tile nor the empty message" });
  }

  for (const jobId of jobs) {
    const page = await look(jobPath(jobId), `job ${jobId} opens`);
    const body = (await page?.text()) ?? "";
    for (const hole of HOLES) {
      if (body.includes(hole)) {
        findings.push({ what: `job ${jobId} has no holes in it`, where: jobPath(jobId), detail: `the page contains "${hole}"` });
      }
    }

    const card = await look(cardPath(jobId), `the card for ${jobId} exists`);
    if (card?.ok && !(card.headers.get("content-type") ?? "").includes("svg")) {
      findings.push({ what: `the card for ${jobId} is an image`, where: cardPath(jobId), detail: "it was served as something else" });
    }

    const index = await look(checksPath(jobId), `the checks for ${jobId} can be fetched`);
    const listed = ((await index?.text()) ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    if (index?.ok && listed.length === 0) {
      findings.push({ what: `the checks for ${jobId} are published`, where: checksPath(jobId), detail: "the list was empty" });
    }
    for (const path of listed) await look(path, `${path} can be fetched`);

    const receipt = await look(receiptPath(jobId), `the receipt for ${jobId} is readable`);
    if (receipt?.ok) {
      const signed = (await receipt.json()) as { readonly receipt?: { readonly start?: string } };
      if (!signed.receipt?.start) {
        findings.push({
          what: `the receipt for ${jobId} says how to repeat the run`,
          where: receiptPath(jobId),
          detail: "it has no start command, so nobody can repeat it",
        });
      }
      if (!body.includes("Check it yourself")) {
        findings.push({
          what: `job ${jobId} shows the command to repeat it`,
          where: jobPath(jobId),
          detail: "there is a receipt, but the page does not offer the run",
        });
      }
    }
  }

  return { checked, findings, jobs, seconds: (Date.now() - started) / 1000 };
}

/** The job ids the wall links to, in the order it links to them. */
export function jobsOn(html: string): readonly string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/href="([^"]*)"/g)) {
    const href = match[1]!;
    if (href.startsWith(ROUTES.job)) found.add(href.slice(ROUTES.job.length));
  }
  return [...found];
}

export function saidPlainly(outcome: AuditOutcome): string {
  if (outcome.findings.length === 0) {
    return `${outcome.checked} things checked, ${outcome.jobs.length} jobs, nothing wrong. ${outcome.seconds.toFixed(1)}s`;
  }
  return [
    `${outcome.findings.length} of ${outcome.checked} checks failed:`,
    ...outcome.findings.map((f) => `  ${f.where}: ${f.what} — ${f.detail}`),
  ].join("\n");
}

if (import.meta.main) {
  const base = process.argv[2];
  if (!base) {
    console.error("usage: bun run src/audit.ts <url of the site>");
    process.exit(2);
  }
  const outcome = await audit(base);
  console.log(saidPlainly(outcome));
  process.exit(outcome.findings.length === 0 ? 0 : 1);
}
