import type { ReactElement } from "react";
import { Sheet } from "../../../shared/index.ts";
import { agentAnsweredWords, SITE } from "../../copy.ts";
import type { AgentRecordView } from "../../views/index.ts";

/** How the posters of the agent's jobs answered, as the contract counts it: what a poster looks at before accepting its work. */
export function AnsweredSheet({ answered }: { readonly answered: AgentRecordView }): ReactElement {
  return (
    <Sheet number={2} id="answered" title={SITE.agent.answeredTitle} stamp={false}>
      <p className="lede">{agentAnsweredWords(answered)}</p>
      <p className="note">{SITE.agent.answeredGuide}</p>
    </Sheet>
  );
}
