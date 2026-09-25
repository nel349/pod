/**
 * GitHub credit for the people behind agents: which GitHub account an agent's work counts for.
 *
 * Two halves make a link, and neither is ours. The agent's key signs a sentence naming the account;
 * the account publishes that sentence, with the signature, in a public gist of its own. GitHub says
 * who owns the gist, the signature says which key agreed, and anybody can check both again later
 * without asking us: no GitHub login here, and no token.
 *
 * Credit is what people recognise, not what the product relies on. Who did the work, and what it was
 * paid, stays on the chain.
 */
import { getAddress, isAddress, isAddressEqual, isHex, recoverMessageAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { GITHUB_API } from "./github.ts";
import { creditMessage } from "./messages.ts";

/** GitHub's own addresses for exactly this: commits made in its name that show no real email */
const NOREPLY_DOMAIN = "users.noreply.github.com";

/** The line after the sentence in the gist */
export const SIGNED = "Signed: ";

export interface CreditLink {
  readonly agent: Address;
  readonly login: string;
  readonly githubId: number;
  /** the gist that says so, where anybody can read it */
  readonly gist: string;
  readonly signature: Hex;
}

export const CreditLinkSchema = z.object({
  agent: z.string().refine((agent): agent is Address => isAddress(agent), "an address"),
  login: z.string().min(1),
  githubId: z.number().int().positive(),
  gist: z.url(),
  signature: z.string().refine((signature): signature is Hex => isHex(signature), "hex"),
});

/**
 * The address a commit uses to count for the account: GitHub gives every account one, and counts a
 * commit that uses it towards that account, without anybody's real email appearing anywhere.
 */
export function creditEmail(link: Pick<CreditLink, "login" | "githubId">): string {
  return `${link.githubId}+${link.login}@${NOREPLY_DOMAIN}`.toLowerCase();
}

/** A gist as GitHub's API describes it: only the parts the check reads */
const GistSchema = z.object({
  html_url: z.url(),
  public: z.boolean(),
  owner: z.object({ login: z.string(), id: z.number().int() }).nullable().optional(),
  files: z.record(z.string(), z.object({ content: z.string().optional(), truncated: z.boolean().optional() })),
});

const GIST_ID = /^[0-9a-f]{20,40}$/;

/** The gist a person pointed at, by its id or by its address on gist.github.com. */
export function gistIdFrom(pointedAt: string): string | undefined {
  const trimmed = pointedAt.trim();
  if (GIST_ID.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname !== "gist.github.com") return undefined;
  const last = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  return GIST_ID.test(last) ? last : undefined;
}

/** A gist, read from GitHub. Nothing about it is trusted until `linkIn` has checked it. */
export async function readGist(id: string): Promise<unknown> {
  const answer = await fetch(`${GITHUB_API}/gists/${id}`, {
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  if (answer.status === 404) throw new Error("GitHub has no public gist by that name");
  if (!answer.ok) throw new Error(`GitHub would not show that gist just now (${answer.status}). Try again in a while`);
  return answer.json();
}

const STATEMENT = /^Credit the work of the agent (0x[0-9a-fA-F]{40}) on POD to the GitHub account "([^"\n]+)", number (\d+)\.$/;

export type Checked = { readonly ok: true; readonly link: CreditLink } | { readonly ok: false; readonly why: string };

/**
 * The link a gist makes, if it makes one: a public gist, holding the sentence and its signature, that
 * names the account which owns the gist and is signed by the agent it names.
 */
export async function linkIn(gist: unknown): Promise<Checked> {
  const parsed = GistSchema.safeParse(gist);
  if (!parsed.success) return { ok: false, why: "that is not a gist GitHub describes" };
  const { html_url: url, owner, files } = parsed.data;
  if (!parsed.data.public) return { ok: false, why: "the gist is secret. A link is public, so anybody can check it: make the gist public" };
  if (!owner) return { ok: false, why: "the gist has no owner on GitHub, so it links nobody" };

  for (const file of Object.values(files)) {
    if (file.content === undefined || file.truncated) continue;
    const lines = file.content.split(/\r?\n/).map((line) => line.trim());
    for (let at = 0; at < lines.length - 1; at++) {
      const said = STATEMENT.exec(lines[at] ?? "");
      const signed = lines[at + 1] ?? "";
      if (!said || !signed.startsWith(SIGNED)) continue;
      const [, agentText = "", login = "", number = ""] = said;
      const signature = signed.slice(SIGNED.length).trim();
      if (!isAddress(agentText) || !isHex(signature)) return { ok: false, why: "the sentence or its signature is not written the way it was signed" };
      const githubId = Number(number);
      if (login.toLowerCase() !== owner.login.toLowerCase() || githubId !== owner.id) {
        return { ok: false, why: `the sentence names the GitHub account ${login} (${number}), and the gist belongs to ${owner.login} (${owner.id})` };
      }
      let signer: Address;
      try {
        signer = await recoverMessageAddress({ message: creditMessage({ agent: agentText, login, githubId }), signature });
      } catch {
        return { ok: false, why: "that signature could not be read" };
      }
      if (!isAddressEqual(signer, agentText)) {
        return { ok: false, why: "the signature is not from the agent the sentence names, over this sentence" };
      }
      return { ok: true, link: { agent: getAddress(agentText), login: owner.login, githubId: owner.id, gist: url, signature } };
    }
  }
  return { ok: false, why: `the gist holds no sentence to link an agent, followed by a line starting "${SIGNED}"` };
}
