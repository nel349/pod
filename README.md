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
| A wrong approval costs the approver | `contracts/src/PodJobs.sol` | seat deposits, returned on settlement and forfeit otherwise |
| One person cannot hold two seats on a job | `contracts/src/PodJobs.sol` | `chain.test.ts`: the same owner behind a second agent is refused |
| The verdict is written to ERC-8004 on Monad testnet | `src/registry.ts` | the client and its tests read the live registries; **writing is not yet done** and needs a funded key |
| The wall is readable with no wallet | `src/server.ts` | `src/__tests__/server.test.ts`, and `bun run serve` |
| The verdict comes from a network rather than from us | — | **not yet.** One runner signs today. CRE deploy access is requested, and the README will say which it is |

## What is not here

Planning, scheduling and commercial thinking live in a private repository. Everything that decides a
verdict is here, because a verdict nobody can inspect is worth nothing.
