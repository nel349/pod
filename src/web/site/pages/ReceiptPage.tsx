import type { ReactElement } from "react";
import { Sheet } from "../../shared/index.ts";
import { PageBill, Poster, When } from "../components/index.ts";
import { SITE, STAMP } from "../copy.ts";
import type { ReceiptView } from "../views/index.ts";

const FACTS = SITE.receipt.facts;

/** A signed receipt, for a person: what ran, on what, what came back, and the file behind it. */
export function ReceiptPage({ receipt }: { readonly receipt: ReceiptView }): ReactElement {
  const listed = (items: readonly string[]): string => (items.length === 0 ? SITE.receipt.nothing : items.join(", "));
  const bill = (
    <PageBill words={{ eyebrow: SITE.receipt.eyebrow, shout: SITE.receipt.shout, strap: SITE.receipt.strap, stand: SITE.receipt.stand }}>
      <p className="lede"><a href={receipt.jobPage}>{receipt.idea}</a></p>
      <p><a className="primary" href={receipt.jobPage}>{SITE.receipt.back}</a></p>
    </PageBill>
  );
  return (
    <Poster bill={bill}>
      <Sheet number={1} id="ran" title={SITE.receipt.ranTitle} stamp={STAMP[receipt.verdict]}>
        <dl className="facts">
          <dt>{FACTS.verdict}</dt><dd>{receipt.verdict}</dd>
          <dt>{FACTS.commit}</dt><dd><code>{receipt.commit}</code> in <a href={receipt.repository}>{receipt.repository}</a></dd>
          <dt>{FACTS.tree}</dt><dd><code>{receipt.tree}</code></dd>
          <dt>{FACTS.image}</dt><dd><code>{receipt.image}</code></dd>
          <dt>{FACTS.start}</dt><dd><code>{receipt.start}</code></dd>
          <dt>{FACTS.runs}</dt><dd>{receipt.runs}</dd>
          <dt>{FACTS.reached}</dt><dd>{listed(receipt.allowedHosts)}</dd>
          <dt>{FACTS.tried}</dt><dd>{listed(receipt.undeclaredCalls)}</dd>
          <dt>{FACTS.finished}</dt><dd><When iso={receipt.finishedAt} /></dd>
        </dl>
        <ul className="checks">
          {receipt.checks.map((check) => (
            <li key={check.command} className={check.exitCode === 0 ? "passed" : "failed"}>
              <span className="outcome">{check.exitCode === 0 ? SITE.job.outcome.passed : SITE.job.outcome.failed}</span>
              <span className="says">{check.says} <code>{check.command}</code> {SITE.receipt.checkRan(check.seconds)}</span>
              {check.hidden && <span className="hidden-check">{SITE.job.hiddenCheck}</span>}
            </li>
          ))}
        </ul>
      </Sheet>
      <Sheet number={2} id="signed" title={SITE.receipt.signedTitle} stamp={false}>
        <dl className="facts">
          <dt>{FACTS.runner}</dt><dd><code>{receipt.runner}</code></dd>
          <dt>{FACTS.hash}</dt><dd><code>{receipt.hash}</code></dd>
          <dt>{FACTS.signature}</dt><dd><code>{receipt.signature}</code></dd>
        </dl>
        <p className="note"><a href={receipt.file}>{SITE.job.signedFile}</a></p>
      </Sheet>
    </Poster>
  );
}
