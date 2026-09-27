import { z } from "zod";
import type { AgentFacts } from "../../../agentFacts.ts";

/** What is known of an agent beyond this wall: its ERC-8004 identity and record, and its GitHub credit. */
export const AgentFactsViewSchema = z.object({
  identity: z.object({
    id: z.string(),
    owner: z.string(),
    seats: z.array(z.object({ role: z.string(), recorded: z.number().int(), passed: z.number().int(), unsure: z.number().int() })),
  }).optional(),
  /** true when the chain could not be read just now, which is not the same as there being nothing */
  isUnread: z.boolean(),
  github: z.object({ login: z.string(), gist: z.string() }).optional(),
});
export type AgentFactsView = z.infer<typeof AgentFactsViewSchema>;

export function agentFactsView(facts: AgentFacts | undefined): AgentFactsView {
  if (!facts) return { isUnread: true };
  return {
    isUnread: false,
    ...(facts.identity ? { identity: { id: facts.identity.id.toString(), owner: facts.identity.owner, seats: facts.identity.seats.map((seat) => ({ ...seat })) } } : {}),
    ...(facts.github ? { github: { ...facts.github } } : {}),
  };
}
