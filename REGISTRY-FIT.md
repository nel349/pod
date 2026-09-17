# Does the Validation Registry hold what POD needs?

Checked 2026-09-16 against the canonical contract source and ABI
(`erc-8004/erc-8004-contracts`, `ValidationRegistryUpgradeable.sol`), the same implementation behind
the proxy deployed on Monad testnet.

**Answer: yes, and two rules in it change our design. One caveat has to be stated plainly.**

## What the registry offers

| Call | What it takes |
|---|---|
| `validationRequest` | the validator's address, the agent id, a link to the claim, and a hash of it |
| `validationResponse` | that request's hash, a score from 0 to 100, a link to the evidence, a hash of the evidence, and a free-form tag |
| `getSummary` | an agent id, a list of validators, and a tag, returning how many and the average |

That maps onto POD directly: the claim is the job at a commit, the evidence is the re-run output,
and the tag is the role or the kind of check.

## Consequence 1: taking a seat has to include an approval

`validationRequest` is restricted. Only the agent's owner, or an address the owner has approved, can
open one. **A stranger cannot open a validation request against an agent**, which is exactly what our
doubting flow wants to do.

So taking a seat must include the agent's owner approving the platform to act for that agent in the
registry. Then the platform opens requests on its behalf, including the ones a doubter pays for.

That is a small addition to the seat flow and it has to be in the contract from the start.

## Consequence 2: one request per verdict, and the validator is an address

Only the address named in the request can answer it. So each independent runner is its own validator
address, and **several runners agreeing is several requests, each answered by one of them**. The
summary call already takes a list of validators, so "three independent runners said pass" is a thing
the registry can express natively.

That is the honest shape of our decentralisation claim, and it is better than one address speaking
for a network.

## The caveat we must state, not hide

**A verdict can be overwritten.** The same validator can answer the same request again, and the
stored response changes. Only the event log is append-only.

So the registry alone is not an immutable record, and we should never claim it is. What we do instead:

- **One request per verdict**, keyed by a hash of the job, the commit and the runner, and never
  answered twice.
- **The POD carries the verdict** at settlement, and that token is immutable.
- **The gallery reads the events**, which cannot be rewritten, rather than only the current state.

## Smaller notes

- **The score is 0 to 100.** Pass and fail are 100 and 0. "Could not be reproduced" is a different
  outcome and needs its own tag rather than a middle number, or the average stops meaning anything.
- **Request hashes must be unique**, so the hash of job plus commit plus runner is a natural key and
  gives us idempotency for free.
- **Tags are free-form strings** and summaries filter by them, so role-scoped reputation needs no new
  contract. It needs somebody to populate it, which nobody has done.

## What this settles, and what it does not

**Settled:** we write to an existing registry rather than deploying one, the role reputation story
works as specified, and the multi-runner story is representable.

## The network question, resolved

Checked directly against both Monad networks on 2026-09-16:

| Registry | Monad testnet (10143) | Monad mainnet (143) |
|---|---|---|
| Identity | **deployed** at `0x8004A818…`, version 2.0.0, an ERC-721 called AgentIdentity | deployed at `0x8004A169…` |
| Reputation | absent | **deployed** at `0x8004BAa1…` |
| Validation | **deployed** at `0x8004Cb1B…`, version 2.0.0 | absent |

Neither network has all three, and the two networks use different addresses, so these are separate
generations rather than one deployment everywhere.

**The testnet validation registry points at the testnet identity registry.** Asked directly, it
returns `0x8004A818…`, which is deployed there. So the ownership check inside `validationRequest`
resolves, and the whole request-and-verdict flow works on Monad testnet today.

**Decision: build on Monad testnet.** Identity and validation are both there and wired to each other,
which is everything POD needs. The missing reputation registry does not block us, because the
objective record we care about is the validation summary, which is already filtered by tag and
therefore already role-scoped. Subjective feedback is the channel POD deliberately does not rely on.

**What we give up:** nothing that the product depends on. Anyone claiming POD should run on mainnet
has to explain who deploys a validation registry there, and why an unaudited deployment of somebody
else's contract is better than the canonical one that already exists.

## Verified on testnet, by simulation

Three read-only calls against the live contracts on 2026-09-16, no transactions sent:

- **Registering an agent is permissionless.** `register()` takes no arguments, checks nothing, mints
  the caller an id and records the caller as the agent's wallet. Simulated from a throwaway address
  it returns the next id, **1873**, which also tells us how many agents are already registered there.
- **The ownership rule behaves as the source says.** Simulating `validationRequest` as the owner of
  agent 1 succeeds. The same call from a stranger reverts with `Not authorized`.
- **So the seat flow has to carry an approval**, exactly as described above, and the approval is
  ordinary ERC-721 approval on the agent's id.

That is the whole request path proven on the network we are building on, before a line of our own
code exists.

## Still open

- Whether to deploy our own reputation registry on testnet later, purely so the three legs are
  visible in one place. Cosmetic, not blocking.
- Who runs the runners, and what address each writes from. The registry ties a verdict to the
  validator address that answers, so the identities of the runners are a design decision rather than
  an afterthought.
