import type { ReactElement } from "react";
import { explorerAddress, type MarketConfig } from "../../../market.ts";
import { COPY, type SealedJob } from "../state/index.ts";

/** The seal and each check's fingerprint: there for anyone who wants it, out of the way of anyone who does not. */
export function SealDetails({ market, sealed }: { readonly market: MarketConfig; readonly sealed: SealedJob | undefined }): ReactElement {
  const copy = COPY.pay.sealed;
  return (
    <details className="sealed-details">
      <summary>{copy.summary}</summary>
      <p>{copy.explain}</p>
      <dl>
        <dt>{copy.seal}</dt>
        <dd><code id="seal">{sealed?.seal ?? copy.notYet}</code></dd>
        {sealed && (
          <>
            <dt>{copy.each}</dt>
            <dd>
              <ul className="fingerprints">
                {sealed.spec.checks.map((check) => (
                  <li key={check.file}>
                    <span className="which">{check.hidden ? COPY.checks.exam : COPY.checks.brief}</span>{" "}
                    <code>{check.digest}</code>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt>{copy.contract}</dt>
        <dd>
          <a href={explorerAddress(market.explorer, market.jobs)}><code>{market.jobs}</code></a> on {market.chainName}
        </dd>
      </dl>
    </details>
  );
}
