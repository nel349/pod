/**
 * One job, opened.
 *
 * The tile is the claim. This is the evidence: what was asked for, who signed what, what ran, and
 * exactly how to run it again yourself. The last part is the one that matters, because the reason to
 * believe a verdict here is not that we signed it, it is that anybody can repeat it.
 */
import type { Brief, CheckSaid, OnChain } from "./store.ts";
import { verdictWords as verdictWordsFor } from "./gallery.ts";
import type { Tile } from "./gallery.ts";
import type { Receipt } from "./receipt.ts";
import { cardPath, claimPath, ROUTES } from "./routes.ts";
import { renderSeal } from "./seal.ts";

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
  readonly checksSaid: readonly CheckSaid[];
  readonly approvals: readonly Approval[];
  readonly receipt?: Receipt;
  /** while the job is open, what a pod is being asked for */
  readonly brief?: Brief;
  readonly chain?: OnChain;
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
    ...(receipt.repository
      ? [`git clone ${receipt.repository} work && cd work && git checkout ${receipt.commit}`]
      : [`# fetch the code at commit ${receipt.commit}, then:`]),
    `docker run --rm --network none \\`,
    `  --cap-drop ALL --security-opt no-new-privileges --read-only \\`,
    `  -v "$PWD":/repo:ro ${receipt.image} \\`,
    `  sh -c 'cp -r /repo/. /work/ && cd /work && ${receipt.start}'`,
    `# the checks are published at ${checksURI}`,
    `# tree fingerprint to compare against: ${receipt.tree}`,
  ].join("\n");
}

export function renderJob(page: JobPage, checksURI: string): string {
  const outcome = (exitCode?: number): string =>
    exitCode === undefined ? "todo" : exitCode === 0 ? "ok" : "no";

  const checks = page.checksSaid.map((c) =>
    `<li class="${outcome(c.exitCode)}">${escape(c.says)}${c.hidden ? ` <span class="hidden-check">hidden from the pod</span>` : ""}</li>`,
  ).join("");

  const checksHeading = page.tile.verdict === "running" ? "What will be checked" : "What was checked";

  const approvals = page.approvals.map((a) =>
    `<tr><td>${escape(a.role)}</td><td>${escape(a.agent)}</td><td><code>${escape(a.commit.slice(0, 10))}</code></td><td>${escape(a.at)}</td></tr>`,
  ).join("");

  const repeat = page.receipt
    ? `<h2>Check it yourself</h2>
<p>This is the run we did. Nothing about it is private.</p>
<pre class="repeat">${escape(repeatCommand(page.receipt, checksURI))}</pre>`
    : "";

  const brief = page.brief && page.tile.verdict === "running" ? renderBrief(page.brief) : "";

  // The third outcome is the one a reader will not have a word for, so the page says it in full.
  const disagreed = page.tile.verdict === "not-reproducible"
    ? `<h2>The runs disagreed</h2>
<p>The same code, the same checks, run more than once, did not give the same answer both times. That
is not a finding about the work, so nothing was settled: the pod was not paid and the money was not
taken back. It returns to the person who posted the job when the job's window closes.</p>`
    : "";

  const chain = page.chain ? renderChain(page.chain) : "";

  const where = page.repository
    ? `<h2>The work itself</h2>
<p class="work"><a href="${escape(page.repository)}">${escape(page.repository.replace("https://github.com/", ""))}</a>
 holds every attempt, including the ones that failed, at the commit that was graded.</p>`
    : "";

  /**
   * What the title does, rather than where the code is — which the section above already said.
   *
   * The transfer is an invitation on GitHub's side, so this says "claim" and not "is yours", and it
   * says who holds it now rather than who paid, because a sale carries the repository.
   */
  const ownership = page.chain?.tokenId
    ? `<h2>Who owns it</h2>
<p class="owns">POD #${escape(page.chain.tokenId)} is the title to this repository. Whoever holds it
can claim the repository by signing for it with the wallet that owns the token. A sale carries both.
${page.podHolder ? `It is held by <code>${escape(page.podHolder)}</code>.` : ""}</p>
${page.repository ? `<p class="owns"><a href="${escape(claimPath(page.tile.jobId))}">Claim the repository</a>, if you hold the title.</p>` : ""}`
    : page.tile.verdict === "passed"
      ? `<h2>Who owns it</h2><p class="owns">No title was minted for this job, so nobody can claim the repository yet.</p>`
      : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(page.tile.idea)}</title>
<meta property="og:title" content="${escape(page.tile.idea)}">
<meta property="og:description" content="${escape(verdictWordsFor(page.tile.verdict))}. Nobody was paid until somebody else ran the checks again.">
<meta property="og:image" content="${escape(cardPath(page.tile.jobId))}">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="${ROUTES.style}"></head>
<body>
<main class="job">
  <div class="hero">${renderSeal(page.tile, { inner: 30, outer: 46 })}
    <div>
      <h1>${escape(page.tile.idea)}</h1>
  <p class="line">${escape(page.tile.verdict)}${page.tile.commit ? ` · commit <code>${escape(page.tile.commit.slice(0, 10))}</code>` : ""}</p>
      <p class="sealed-as">sealed before it opened as <code>${escape(page.seal.slice(0, 18))}…</code></p>
    </div>
  </div>

  <h2>${checksHeading}</h2>
  <ul class="checks">${checks}</ul>
  ${page.tile.verdict === "running"
    ? `<p class="fetch sealed">The checks are sealed until there is a verdict. The pod cannot see them either.</p>`
    : `<p class="fetch"><a href="${escape(checksURI)}">Fetch the checks</a>, including the ones the pod
  could not see, and run them yourself.</p>`}

  <h2>Who signed what</h2>
  <div class="sideways"><table class="approvals"><thead><tr><th>seat</th><th>agent</th><th>commit</th><th>when</th></tr></thead>
  <tbody>${approvals}</tbody></table></div>
  ${page.tile.securityHeldByUs ? `<p class="disclosure">The security seat was held by the platform, not by an independent agent.</p>` : ""}

  ${where}
  ${chain}
  ${brief}
  ${disagreed}
  ${repeat}
  ${ownership}
</main>
</body></html>`;
}

/**
 * An open job, as a pod and a passer-by both read it.
 *
 * It says how many checks are sealed rather than pretending there are none: knowing that two of the
 * four are hidden is exactly what stops a pod writing to the tests, and it is no secret.
 */
function renderBrief(brief: Brief): string {
  const seats = brief.seats.map((seat) =>
    `<li class="${seat.taken ? "taken" : "open"}">${escape(seat.role)}${seat.taken ? "" : " · open"}</li>`,
  ).join("");

  return `<h2>What is being asked for</h2>
<p class="asked">${escape(brief.asked)}</p>
<p class="sealed-count">${brief.sealedChecks === 0
    ? "Every check on this job is published above."
    : `${brief.sealedChecks} ${brief.sealedChecks === 1 ? "check is" : "checks are"} sealed until there is a verdict. The pod cannot read ${brief.sealedChecks === 1 ? "it" : "them"} either.`}</p>
<h2>Seats</h2>
<ul class="seats">${seats}</ul>
<p class="ends">Open until ${escape(brief.endsAt)}.</p>`;
}

/**
 * Where to read the same thing on the chain.
 *
 * The page is ours and the chain is not, which is the point: everything here can be checked without
 * us. Each row is a transaction a stranger can open.
 */
function renderChain(chain: OnChain): string {
  const explorer = "https://testnet.monadscan.com";
  const row = (what: string, hash?: string): string =>
    hash ? `<tr><td>${escape(what)}</td><td><a href="${explorer}/tx/${escape(hash)}"><code>${escape(hash.slice(0, 12))}…</code></a></td></tr>` : "";

  return `<h2>On the chain</h2>
<p class="onchain">Job ${escape(chain.jobId)} in
<a href="${explorer}/address/${escape(chain.jobs)}"><code>${escape(chain.jobs.slice(0, 10))}…</code></a>
on Monad testnet${chain.tokenId ? `, and POD #${escape(chain.tokenId)}` : ""}.</p>
<div class="sideways"><table class="approvals"><tbody>
${row("settled", chain.settled)}
${row("the title minted", chain.minted)}
</tbody></table></div>`;
}
