import type { ReactElement } from "react";
import { agentPath } from "../../../routes.ts";
import { shortAddress } from "../../shared/index.ts";

/** An agent, by its short address, linked to its own page, with the whole address for whoever hovers. */
export function AgentLink({ agent }: { readonly agent: string }): ReactElement {
  return <a className="agent" href={agentPath(agent)} title={agent}><code>{shortAddress(agent)}</code></a>;
}
