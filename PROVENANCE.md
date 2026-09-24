# What is carried over, and what is new

The event's rule: existing code is allowed, and what we show on 13 October should have been built
during the six weeks. This file is the answer to a judge asking which is which, and it is meant to be
readable next to the commit history.

## New, built in the window

Everything that makes POD a product:

- **The job format**, the sealed spec, and the hidden checks.
- **The pod**: seats taken first come, first served, one owner to a job, and the deposits.
- **The public doors an outside agent uses**: the job list, the git door that checks a seat's
  signature, and signed notes.
- **The policy that gates payment**: approvals counted, codeowner required, security seat required,
  approvals bound to the merged commit.
- **The sandbox**: the sealed run, the black box grading shape, the network rule, the receipt.
- **The Monad side**: the client of the Validation Registry, and the request and verdict flow.
- **The money**: fixed shares and the split.

Designed in the window and not built, so a reader does not take any of them for a feature: seat
eligibility by specialty or record, a seat reserved for newcomers, the checking budget, doubting a
result and the spotting reward. `POD.md` says the same wherever it describes them.
- **The POD token, the repository handover, and the gallery.**

## Carried over, and what it is

Three things we already had. All three are named here rather than quietly reused.

| Thing | Where it came from | What it does for POD |
|---|---|---|
| Deterministic re-execution | `arc-maze`: `verify()` rebuilds a run from public data and recomputes the result; `digest()` commits to the record; `published()` is the record a stranger sees | The idea and the shape of re-execution. POD re-runs code rather than a maze, so the code itself is not reused, but the pattern and its lessons are |
| Agent identity and reputation on chain | `arc-agent-mandate`: ERC-8004 identity in `mcp/erc8004.ts` and `mcp/identity.ts`, used on Arc | Knowing how the registries behave, which is why the Monad checks took an afternoon rather than a week |
| Passkeys on a phone | `arc-agent-mandate`: native modules we wrote, Swift and Kotlin, because the wallet SDK had no React Native support | The human side of granting and revoking, if the wallet bounty is taken |

## What that means for the entry

**The demo task is a POD job**, not the maze. A pod builds a small thing, the checks re-run it, the
verdict is written, the POD is minted. The maze is not in the submission, and the arena idea is parked.

So the strongest thing on screen is work done in the window, and the carried-over part is experience
rather than code. That is the honest version, and it is also the better story: we are not showing a
game we built in August, we are showing a market that pays agents only when somebody else can check
the work.

## How a judge can verify this

- This repository starts on 16 September 2026 and every commit is dated.
- The Arc repositories are public and their commits are dated before the window, so the line between
  them is visible rather than asserted.
