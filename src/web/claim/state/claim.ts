/**
 * What the claim page knows and says, with no browser and no server: the shape of what the server
 * answers, the job the address names, and every sentence the page shows.
 */
import { isAddress, type Address } from "viem";
import { z } from "zod";
import { ROUTES } from "../../../routes.ts";
import { shortAddress } from "../../shared/copy.ts";

const AddressSchema = z.string().refine((value): value is Address => isAddress(value), "an address");

export const InvitationSchema = z.object({ account: z.string(), by: AddressSchema, at: z.string() });

/** What there is to claim, as the server says it */
export const ClaimableSchema = z.object({
  jobId: z.string(),
  idea: z.string(),
  tokenId: z.string(),
  holder: AddressSchema,
  repository: z.url(),
  invited: InvitationSchema.optional(),
});

export const ClaimedSchema = z.object({ invited: InvitationSchema });
export const WhySchema = z.object({ why: z.string() });

export type Claimable = z.infer<typeof ClaimableSchema>;
export type Invitation = z.infer<typeof InvitationSchema>;

/** The job the page's own address names: /claim/<job> */
export function jobIdFrom(pathname: string): string {
  return decodeURIComponent(pathname.slice(ROUTES.claim.length).split("/")[0] ?? "");
}

/** Where a claim is: nothing sent yet, each step as it happens, or where it ended */
export type ClaimStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "working"; readonly step: ClaimStep }
  | { readonly kind: "sent"; readonly invited: Invitation }
  /** the step it stopped at, and why */
  | { readonly kind: "stopped"; readonly step: ClaimStep; readonly why: string };

export type ClaimStep = "wallet" | "sign" | "github";

/** The steps of a claim, in the order they happen */
export const CLAIM_STEPS: readonly ClaimStep[] = ["wallet", "sign", "github"];

export type StepState = "done" | "doing" | "failed" | "waiting";

/** How far each step has got: every step before the current one is done, and the current one is doing it or stopped there. */
export function stepStates(status: ClaimStatus): Record<ClaimStep, StepState> {
  const at = status.kind === "working" || status.kind === "stopped" ? CLAIM_STEPS.indexOf(status.step)
    : status.kind === "sent" ? CLAIM_STEPS.length : -1;
  const now: StepState = status.kind === "stopped" ? "failed" : "doing";
  return {
    wallet: stateAt(0, at, now), sign: stateAt(1, at, now), github: stateAt(2, at, now),
  };
}

function stateAt(index: number, at: number, now: StepState): StepState {
  if (index < at) return "done";
  return index === at ? now : "waiting";
}

/** A repository's short name as GitHub shows it: owner/name */
export const shortRepository = (url: string): string => new URL(url).pathname.replace(/^\//, "");

export const COPY = {
  masthead: {
    eyebrow: "the title",
    shout: ["Claim", "the code"],
    strap: "whoever holds the POD owns the repository",
    stand: "Sign with the wallet that holds the title, name a GitHub account, and the repository is handed to it. Nobody signs in here: the chain says who holds it.",
  },
  loading: "Reading the title from the chain…",
  noWallet: "This browser has no wallet in it. Open this page where the wallet that holds the title lives.",
  what: {
    title: "What you are claiming",
    pod: (tokenId: string) => `POD #${tokenId}`,
    holder: "Held now by",
    repository: "The repository",
    sold: "A sale carries it: whoever holds the title when the claim is signed is who may claim.",
  },
  where: {
    title: "Where it goes",
    guide: "The GitHub account the repository is handed to. It can be yours or anybody's.",
    label: "GitHub account",
    placeholder: "octocat",
    button: "Sign and claim",
    busy: "Claiming…",
    notHolder: (connected: string, holder: string) =>
      `The wallet connected here is ${shortAddress(connected)}, and the title is held by ${shortAddress(holder)}. Its signature will be refused: connect the holder's wallet.`,
    steps: { wallet: "Connect the wallet", sign: "Sign the claim", github: "Ask GitHub to hand it over" } satisfies Record<ClaimStep, string>,
    stepStates: { done: "done", doing: "under way", failed: "stopped here", waiting: "not yet" } satisfies Record<StepState, string>,
  },
  sent: (invited: Invitation, repository: string) =>
    `GitHub is handing ${shortRepository(repository)} to ${invited.account}. If ${invited.account} does not already own where it lives, GitHub emails an invitation, which has to be accepted within a day. Until it is, the repository stays where it is.`,
  before: (invited: Invitation) => `An invitation was sent to ${invited.account} on ${invited.at.slice(0, 10)}. Claim again if it lapsed.`,
} as const;
