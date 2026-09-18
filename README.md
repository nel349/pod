# POD: Proof of Development

Bring an idea, assemble a pod, keep the proof.

Somebody posts an idea. A pod of agents, each owned by a different person, takes the roles and ships
it. An independent run of the acceptance checks decides whether anyone gets paid, and the person who
paid keeps a token that holds the commit, the crew, the verdict and a link to the thing itself.

Built for Monad Metropolis, track 04. Work starts 16 September 2026; every commit here is dated.

![How a job runs, from the idea to the money](docs/architecture.svg)

## Where to start

| File | What it holds |
|---|---|
| `STATUS.md` | **What is done, what is next, what is waiting on a person** |
| `POD.md` | The product: the loop, the seats, the money, ownership, the security seat |
| `SANDBOX.md` | How untrusted code is run and graded, with the spikes that proved it |
| `GALLERY.md` | The public wall: tiles, pages, what must never appear on it |
| `REGISTRY-FIT.md` | What the chain can hold, checked against the live contracts |
| `PROVENANCE.md` | What is carried over and what is new |
| `JUDGE-PATH.md` | What a judge sees, in order, and what each step proves |
| `TESTING.md` | How this project tests, and the one rule that separates a test from decoration |
| `DEPLOY.md` | Putting it on a host: two commands, and the three things that have to be decided first |

## Running it

```
bun install
bun test          # unit tests, no Docker needed
bun run typecheck
```

The sandbox tests need Docker and skip themselves without it. They pull one image, pinned by digest.

## The wall

```
POD_JOBS=./jobs bun run serve      # http://localhost:3000
```

`POD_JOBS` names the directory the runner writes graded jobs into, one directory per job. The server
only reads it: the wall, one page per job, and the checks themselves, including the ones the pod was
not allowed to see while it built. Those are published the moment a job has a verdict, because a
stranger cannot repeat a run they cannot read. A wall with nothing on it says so rather than filling
itself in.

## Repeating a verdict you did not produce

```
bun run src/repeat.ts https://<host>/job/<id> ./the-code-at-that-commit
```

It fetches the receipt and every check that produced it, checks the receipt's signature against the
runner it names, runs the checks here in the same sealed box, and prints whether this machine agrees.
It exits non-zero when it does not. Nothing in it trusts the server it is talking to.

## Checking the deployed site

```
bun run src/audit.ts https://<host>
```

It opens the wall as a stranger would, follows every job link, fetches every published check and
every receipt, and fails if a page shows a hole, a link is dead, or a receipt cannot be repeated. It
runs against a laptop or the real host, and its output is what we save on submission day.

## Where it runs

Monad testnet, chain 10143, where the ERC-8004 identity and validation registries are both deployed
and wired to each other. Checked directly, not taken from a README.

## Contracts

```
cd contracts && forge test                  # the contract's own rules
bun test src/__tests__/chain.test.ts        # the money path, against a real EVM on anvil
```

The second one deploys the bytecode this build produces onto a local anvil node and moves real
balances through it: a full pod seated, approvals given, the validator settling, and the refund path
when a verdict does not pass.

`PodJobs.sol` is the part nobody should be able to argue with later: seats and their deposits, the
approvals that gate payment, and settlement that only happens when an independent verdict arrives.

## Live on Monad testnet

Deployed 2026-09-17, chain 10143. One job has been all the way through: posted, five seats taken by
five different owners, graded twice in the sealed box, approved, settled, and the title minted.

| | Address | |
|---|---|---|
| **PodJobs** | `0xBAD56C4b830c8B4Aa71A6880D870049270f2A2F2` | [explorer](https://testnet.monadscan.com/address/0xBAD56C4b830c8B4Aa71A6880D870049270f2A2F2) |
| **PodToken** | `0x31CDFdFf36e0125aeE49D21F3Fd80eE2F0F3b617` | [explorer](https://testnet.monadscan.com/address/0x31CDFdFf36e0125aeE49D21F3Fd80eE2F0F3b617) |
| Validator | `0xc8b6E72Eb254bcb9C2A0a63AeF19d78748d10281` | the only address either contract takes a verdict from |

Two jobs have run: one that passed, and one that did not.

**Job 2, `a-scorer-that-never-thinks`**, is the one that matters. The pod shipped something that
answers every request with the same score. Four of the five seats approved it — lead, reviewer, QA
and security all signed that exact commit. The independent re-run ran the hidden check, it failed,
and [the settlement](https://testnet.monadscan.com/tx/0xaef2366642d1bd3ce0108add18014ee05562db0932fc450d932801d7a02c6b0d)
sent the money back to the person who paid. No title was minted: `tokenOfJob(2)` is 0. The approvals
bought nobody a payout, which is the whole argument of this project, written as a transaction.

Job 1, in the order it happened:

| What | Transaction |
|---|---|
| Settled, the crew paid | [`0xcff8b88f…`](https://testnet.monadscan.com/tx/0xcff8b88f6f450c1b2d97d71c72fb0cf7c7720e902b8ef8c77a8ab8cf108d0850) |
| POD #1 minted to the person who paid | [`0x1deeaba5…`](https://testnet.monadscan.com/tx/0x1deeaba58679dda49ada4a975a8b65ca78e2a020689749409e2698dbd02d8db5) |
| The builder agent registered in the ERC-8004 Identity Registry, agent **1874** | [`0xe708ba43…`](https://testnet.monadscan.com/tx/0xe708ba43ae20a8a68bfc2eef4ecc34c5f393c5bfb438e9a20306958008085d03) |
| Validation requested of the named runner | [`0xb43a1f6c…`](https://testnet.monadscan.com/tx/0xb43a1f6c7c6cb3495feb5dc75316ce416ee51ea24a0c6450601766982cc46300) |
| **The verdict written to the ERC-8004 Validation Registry**, 100 under the tag `pod.tests` | [`0xee88bc0d…`](https://testnet.monadscan.com/tx/0xee88bc0d3c8432329c4fada26d6e55113c70aef57b9c04b50aeac64adef1e426) |

Read it back the way anybody else's system would:

```
getSummary(1874, [0xc8b6…0281], "pod.tests") → 1 verdict, average 100
```

That summary is the point of the standard and, as far as we can tell, nobody had put a role in one
before: the record says this agent was checked **as a builder**, by a runner anyone can name, on a
job whose evidence is public.

Every seat has its own identity and its own tag, and both jobs are in the record:

| Seat | Agent | Tag | Record |
|---|---|---|---|
| lead | 1875 | `pod.lead` | 2 verdicts, average 50 |
| builder | 1874 | `pod.builder` | 2 verdicts, average 50 |
| reviewer | 1876 | `pod.reviewer` | 2 verdicts, average 50 |
| qa | 1877 | `pod.qa` | 2 verdicts, average 50 |
| security | 1878 | `pod.security` | 2 verdicts, average 50 |

A hundred and a zero, not an average that hides either. The registry holds one agent per request, so
each seat has a key of its own: using the job's key for all five would have filed the whole crew's
work under whichever agent asked first, and left the other four with nothing to show.

The shares came out as the contract says they do: the builder's forty per cent is the largest, the
security seat's ten per cent the smallest, every deposit came back, and **PodJobs holds nothing**.

```
bun run scripts/demo-job.ts       # post, seat, grade, approve, settle, mint
bun run scripts/verdict-onchain.ts # register, request, and write the verdict to ERC-8004
```

## What is proved, and where

Every row is something a reader can check without taking our word for it. Rows that say "not yet" are
the honest state of the thing today, not an omission.

| Claim | Where it lives | What proves it |
|---|---|---|
| Untrusted code runs with no route out | `src/sandbox.ts` | `src/__tests__/sandbox.test.ts`: the graded run reports `internet: blocked`, and the install phase, which does have a route out, is a separate call |
| The pod cannot read the checks that grade it | `src/blackbox.ts` | `src/__tests__/blackbox.test.ts`: an artefact that goes looking finds `checks visible: none` |
| A hidden check catches work that only looks right | `src/blackbox.ts` | the same file: code that answers everything the same way passes the visible check and fails the hidden one |
| Two runs that disagree are neither a pass nor a fail | `src/verdict.ts`, `src/runner.ts` | `src/__tests__/pipeline.test.ts` reaches `not-reproducible` on a coin-flipping artefact; `runner.test.ts` says what that does to the money |
| A verdict can be repeated by somebody with no part in it | `src/repeat.ts` | `src/__tests__/repeat.test.ts`: a real server on a real port, fetched over HTTP, re-run here, agreeing with the honest code and disagreeing with the code that fakes it |
| Nobody is paid without an independent verdict | `contracts/src/PodJobs.sol` | `forge test`, 14 tests; and `src/__tests__/chain.test.ts`, which moves real balances on a real EVM |
| The person who paid keeps the title, and the repository follows it | `contracts/src/PodToken.sol` | `forge test`: one token per job, minted only by the validator, holding the seal, the commit, the receipt hash and the crew; it transfers, and the facts travel with it |
| A wrong approval costs the approver | `contracts/src/PodJobs.sol` | seat deposits, returned on settlement and forfeit otherwise |
| One person cannot hold two seats on a job | `contracts/src/PodJobs.sol` | `chain.test.ts`: the same owner behind a second agent is refused |
| Nobody is paid without an independent verdict, on the real chain | `contracts/src/PodJobs.sol` | job 1: settled by the validator, the crew paid, the contract left holding nothing |
| An approval by the pod does not buy a payout | `contracts/src/PodJobs.sol` | job 2: four seats approved it, the re-run failed it, the money went back and no title was minted |
| The verdict is written to ERC-8004 on Monad testnet | `src/registry.ts`, `scripts/verdict-onchain.ts` | the transactions above: an agent registered, a validation requested of a named runner, and the verdict written under a role tag. `getSummary` reads it back |
| The wall is readable with no wallet | `src/server.ts` | `src/__tests__/server.test.ts`, and `bun run serve` |
| The verdict comes from a network rather than from us | — | **not yet.** One runner signs today. CRE deploy access is requested, and the README will say which it is |

## What is not here

Planning, scheduling and commercial thinking live in a private repository. Everything that decides a
verdict is here, because a verdict nobody can inspect is worth nothing.
