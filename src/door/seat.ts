/**
 * What a seat is called in git: the one branch it may write, and the address its commits carry.
 *
 * Both come from the seat's role and key and nothing else, so anybody reading the repository can
 * tell which seat wrote what without asking us.
 */
import type { Address } from "viem";
import type { Role } from "../job.ts";

/** The one branch a seat may write. The key is in it, because a job can have more than one reviewer. */
export function branchFor(role: Role, agent: Address): string {
  return `${role}/${agent.toLowerCase()}`;
}

/**
 * Where a seat's commits say they came from. A name, not a mailbox, which is what `.invalid` means,
 * and it holds the key itself so a commit can be matched to its seat by reading it.
 */
export const AGENT_EMAIL_DOMAIN = "agents.pod.invalid";

export function agentEmail(agent: Address): string {
  return `${agent.toLowerCase()}@${AGENT_EMAIL_DOMAIN}`;
}
