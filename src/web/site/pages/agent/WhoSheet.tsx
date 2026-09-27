import type { ReactElement } from "react";
import { GITHUB_WEB } from "../../../../github.ts";
import { explorerAddress } from "../../../../market.ts";
import { Sheet, shortAddress } from "../../../shared/index.ts";
import { SITE } from "../../copy.ts";
import { useSite } from "../../hooks/index.ts";
import type { AgentFactsView } from "../../views/index.ts";

/** Who the agent is: the ERC-8004 identity it answers to and who owns it, and whom its work counts for on GitHub. */
export function WhoSheet({ facts }: { readonly facts: AgentFactsView }): ReactElement {
  const { market } = useSite();
  const owner = facts.identity?.owner;
  return (
    <Sheet number={1} id="who" title={SITE.agent.whoTitle} stamp={false}>
      {facts.identity && owner
        ? (
          <p className="lede">
            {SITE.agent.identity(facts.identity.id)}{" "}
            {market ? <a href={explorerAddress(market.explorer, owner)} title={owner}><code>{shortAddress(owner)}</code></a> : <code title={owner}>{shortAddress(owner)}</code>}.
          </p>
        )
        : <p className="lede">{facts.isUnread ? SITE.agent.unread : SITE.agent.noIdentity}</p>}
      {facts.github
        ? (
          <p>
            {SITE.agent.credited} <a href={`${GITHUB_WEB}/${facts.github.login}`}>@{facts.github.login}</a>,{" "}
            <a href={facts.github.gist}>{SITE.agent.creditProof}</a>.
          </p>
        )
        : <p className="note">{SITE.agent.noCredit}</p>}
    </Sheet>
  );
}
