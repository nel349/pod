/**
 * One job, opened.
 *
 * The tile is the claim. This is the evidence: what was asked for, who signed what, what ran, and
 * exactly how to run it again yourself. The last part is the one that matters, because the reason to
 * believe a verdict here is not that we signed it, it is that anybody can repeat it.
 */
import type { Tile } from "./gallery.ts";
import type { Receipt } from "./receipt.ts";
import { ROUTES } from "./routes.ts";

export interface Approval {
  readonly role: string;
  readonly agent: string;
  readonly commit: string;
  readonly at: string;
}

export interface JobPage {
  readonly tile: Tile;
  /** the idea as posted, and the hash it was sealed under before it opened */
  readonly seal: string;
  readonly checksSaid: readonly { readonly says: string; readonly hidden: boolean; readonly exitCode: number }[];
  readonly approvals: readonly Approval[];
  readonly receipt?: Receipt;
  /** where the code went, and who holds the token that owns it */
  readonly repository?: string;
  readonly podHolder?: string;
}

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * The command a stranger runs to reach the same verdict.
 *
 * Pinned by digest, no route out, checks from outside the artefact's box: the same run we did,
 * written out so it can be checked rather than trusted.
 */
export function repeatCommand(receipt: Receipt, checksURI: string): string {
  return [
    `# fetch the code at the commit that was graded, then:`,
    `docker run --rm --network none \\`,
    `  --cap-drop ALL --security-opt no-new-privileges --read-only \\`,
    `  -v "$PWD":/repo:ro ${receipt.image} \\`,
    `  sh -c 'cp -r /repo/. /work/ && cd /work && <start the artefact>'`,
    `# the checks are published at ${checksURI}`,
    `# tree fingerprint to compare against: ${receipt.tree}`,
  ].join("\n");
}

export function renderJob(page: JobPage, checksURI: string): string {
  const checks = page.checksSaid.map((c) =>
    `<li class="${c.exitCode === 0 ? "ok" : "no"}">${escape(c.says)}${c.hidden ? ` <span class="hidden-check">hidden from the pod</span>` : ""}</li>`,
  ).join("");

  const approvals = page.approvals.map((a) =>
    `<tr><td>${escape(a.role)}</td><td>${escape(a.agent)}</td><td><code>${escape(a.commit.slice(0, 10))}</code></td><td>${escape(a.at)}</td></tr>`,
  ).join("");

  const repeat = page.receipt
    ? `<h2>Check it yourself</h2>
<p>This is the run we did. Nothing about it is private.</p>
<pre class="repeat">${escape(repeatCommand(page.receipt, checksURI))}</pre>`
    : "";

  const ownership = page.repository
    ? `<h2>Who owns it</h2><p>The code is at <a href="${escape(page.repository)}">${escape(page.repository)}</a>${page.podHolder ? `, and the POD is held by ${escape(page.podHolder)}` : ""}.</p>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(page.tile.idea)}</title>
<link rel="stylesheet" href="${ROUTES.style}"></head>
<body>
<main class="job">
  <h1>${escape(page.tile.idea)}</h1>
  <p class="line">${escape(page.tile.verdict)}${page.tile.commit ? ` · commit <code>${escape(page.tile.commit.slice(0, 10))}</code>` : ""}</p>
  <p class="seal">sealed before it opened as <code>${escape(page.seal.slice(0, 18))}…</code></p>

  <h2>What was checked</h2>
  <ul class="checks">${checks}</ul>
  <p class="fetch"><a href="${escape(checksURI)}">Fetch the checks</a>, including the ones the pod
  could not see, and run them yourself.</p>

  <h2>Who signed what</h2>
  <table class="approvals"><thead><tr><th>seat</th><th>agent</th><th>commit</th><th>when</th></tr></thead>
  <tbody>${approvals}</tbody></table>
  ${page.tile.securityHeldByUs ? `<p class="disclosure">The security seat was held by the platform, not by an independent agent.</p>` : ""}

  ${repeat}
  ${ownership}
</main>
</body></html>`;
}
