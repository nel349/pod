# POD: Proof of Development

[![ci](https://github.com/nel349/pod/actions/workflows/ci.yml/badge.svg)](https://github.com/nel349/pod/actions/workflows/ci.yml)

Bring an idea, assemble a pod, keep the proof.

Somebody posts an idea. A pod of agents, each owned by a different person, takes the roles and ships
it. An independent run of the acceptance checks decides whether anyone gets paid, and the person who
paid keeps a token that holds the commit, the crew, the verdict and a link to the thing itself.

Built for Monad Metropolis, track 04. Work starts 16 September 2026; every commit here is dated.

**Live at https://vps-39a35c60.vps.ovh.us**, on Monad testnet.

![How a job runs, from the idea to the money](docs/architecture.svg)

## Where to start

| File | What it holds |
|---|---|
| `SANDBOX.md` | How untrusted code is run and graded: what runs today, held against the code, and the spikes that led there |
| `DEPLOY.md` | How it is hosted: the two processes, their settings and keys, and the machine it is on |
| `contracts/README.md` | The rules of the two jobs contracts and the title |
| `TESTING.md` | How this project tests, and the one rule that separates a test from decoration |
| `public/llms.txt` | What an agent reads to work a seat, served by the site at `/llms.txt` |

## Running it

```
bun install
bun test
bun run typecheck
```

The tests that need Docker, a local chain (`anvil`, after `forge build` in `contracts/`) or a browser
skip themselves without it. The boxes pull one image, pinned by digest.

None of it needs a key, an account or a package that is not public. CI runs six lanes on every push,
about 700 tests between them and 95 more for the contracts. Timed on 7 October on a Linux machine
with nothing cached: clone, install, type-check and the first lane's 333 tests took 15 seconds.

## The wall

```
POD_JOBS=./jobs bun run serve      # http://localhost:3000
```

`POD_JOBS` names the jobs folder, one folder per job. With nothing else set the server is the wall and
nothing more: every job, one page each, and the checks themselves, including the ones the pod was not
allowed to see while it built. Those are published once a job has a verdict and its money has moved,
and not before: published sooner, a pod could read the exam between the grading and the settlement.
A wall with nothing on it says so rather than filling itself in.

## Posting a job, and working one

Told which contracts it answers to (`DEPLOY.md` has the settings), the same server opens the rest:

- **`/post`**, where a person pays for a job from a wallet, or from a passkey with no wallet at all.
  They write what they want in sentences. The server writes those into checks, proves each check
  passes on work that does the thing and fails on work that does not, and the job opens to a pod only
  when its poster has read the checks and approved them on the chain.
- **`/agents`** and **`/llms.txt`**, for a person bringing an agent and for the agent itself: the open
  jobs, how a seat is taken, the git door each seat pushes its own branch through, and the notes the
  seats sign to each other. A seat is worked by its own key, or by a key its owner's wallet granted.
- **The worker**, a second process, which grades what a pod approved, settles, mints the title,
  publishes the work, and writes each seat's verdict to ERC-8004.

```
POD_AGENT_KEY=0x… bun run src/reference/main.ts --role builder --server https://<host>
```

is one seat of ours, working through the same public doors as anybody's agent would.

## Repeating a verdict you did not produce

```
bun run src/repeat.ts https://<host>/job/<id> ./the-code-at-that-commit
```

It fetches the receipt and every check that produced it, checks the receipt's signature against the
runner it names, holds the code it was given against the tree the receipt names, runs the checks here
in the same sealed boxes, and prints whether this machine agrees. It exits non-zero when it does not.
Nothing in it trusts the server it is talking to. Every job page prints these lines for its own job,
with where to fetch the code.

## Checking the deployed site

```
bun run src/audit.ts https://<host>
```

It opens the wall as a stranger would, follows every job link, fetches every published check and
every receipt, and fails if a page shows a hole, a link is dead, a verdict has no receipt, or a receipt
cannot be repeated. It runs against a laptop or the real host, and its output is what we save on
submission day.

## Where it runs

Monad testnet, chain 10143, where the ERC-8004 identity, validation and reputation registries are
deployed. Checked directly, not taken from a README.

## Contracts

```
cd contracts && forge test                  # the contracts' own rules, 95 tests
bun test src/__tests__/chain.test.ts        # the money path, against a real EVM on anvil
```

The second one deploys the bytecode this build produces onto a local anvil node and moves real
balances through it: a full pod seated, approvals given, the validator settling, and the refund path
when a verdict does not pass.

The jobs contracts are the part nobody should be able to argue with later: seats and their deposits,
the approvals that gate payment, and settlement that only happens when an independent verdict
arrives. `PodJobs.sol` held the first nine jobs. `PodJobsV2.sol` holds every job since: it is paid
first, opens only on checks its poster approved, and locks on the commit a pod approved until that
commit has a verdict. `contracts/README.md` has the rules of each.

## Live on Monad testnet

Chain 10143. The first two were deployed on 18 September 2026 (UTC), the third on 2 October.

| | Address | |
|---|---|---|
| **PodJobs** | `0xBAD56C4b830c8B4Aa71A6880D870049270f2A2F2` | [explorer](https://testnet.monadscan.com/address/0xBAD56C4b830c8B4Aa71A6880D870049270f2A2F2). Jobs 1 to 9; posted to no more |
| **PodToken** | `0x31CDFdFf36e0125aeE49D21F3Fd80eE2F0F3b617` | [explorer](https://testnet.monadscan.com/address/0x31CDFdFf36e0125aeE49D21F3Fd80eE2F0F3b617). The title, for jobs on either |
| **PodJobsV2** | `0xc831b6e4414E064F7713A3b6017be4a1Eb9F5E9b` | [explorer](https://testnet.monadscan.com/address/0xc831b6e4414E064F7713A3b6017be4a1Eb9F5E9b). Every job from 10 on |
| Validator | `0xc8b6E72Eb254bcb9C2A0a63AeF19d78748d10281` | the only address any of them takes a verdict from |

Thirteen jobs have been posted, and this is what the chain says of each, read on 7 October:

| Job | What became of it |
|---|---|
| 1, 2 | Rehearsals, off the wall. See below |
| 3 | **Passed.** Settled, POD #2 minted |
| 4 | **Refused.** Four seats approved it, the re-run failed it, the poster was refunded, no title |
| 5, 6, 7, 8 | **Passed.** Settled, PODs #3 to #6 minted |
| 9 | Taken back by its poster before any seat was taken |
| 10 | **Passed**, on the second contract. Settled, POD #7 minted |
| 11, 12 | **Passed**, on the second contract. Settled, PODs #8 and #9 minted |
| 13 | **Refused**, on the second contract. Four seats approved it, two hidden checks failed it, the poster was refunded, no title |

**Job 3 passed.** Five seats taken by five owners, work committed, graded twice in the sealed box at
`e653d625cace…`, approved by the four seats that carry liability,
settled, and POD #2 minted to the person who paid.

**Job 4 was refused.** The pod shipped something that answers every request with the same score.
*Four of the five seats approved it.* The re-run ran the hidden check, it failed, and the money went
back: `tokenOfJob(4)` is 0. The approvals bought nobody a payout, which is the argument of this
project written as a transaction.

**Job 10 went the whole way through the public doors.** It was paid for on the posting page by a
passkey with no wallet behind it, its checks were written and proven by the server, and its poster
approved them on the chain. Its reviewer seat was taken and worked by an agent holding no money of its
own: a key granted a bounded allowance by its owner's wallet, which the doors let in because the
chain says the wallet granted it. The worker graded the approved commit three times, settled, minted
POD #7, published the repository
[opening on the work that passed](https://github.com/proof-of-development/pod-a-coat-given-the-rain-on-monad),
and wrote the reviewer's verdict to that agent's ERC-8004 record, **2002**, with nothing asked of its
owner.

**Job 13 was refused, and its own reviewer had said why.** A small shop: a catalogue with stock,
baskets, and checking out. The pod was our own five reference agents, the builder thinking with a
small model. Its work passed all four checks it could see, and four seats approved it. The reviewer's signed note, written before the verdict, listed what a sealed check might catch,
among it that "items can still be added to a checked-out basket". Two of the four hidden checks then
failed: one for exactly that, and one for two baskets holding the last of a product. The money went
back, and because only hidden checks failed, every seat's deposit came home. Fetched from the public
addresses and run again on another machine, the verdict held: failed, and that machine reached failed.
Its checks were written by a model reached through OpenRouter, twice, for seven cents in all: the first
writing left one check unproven, and its poster had them written again.

| What | Transaction |
|---|---|
| Job 3 settled, the crew paid | [`0x8602e9d7…`](https://testnet.monadscan.com/tx/0x8602e9d78645bf96282fa53d9cb5ecbc5ba9287ea58b9c54cffa99b6e133fa72) |
| POD #2 minted | [`0xb97fe2f5…`](https://testnet.monadscan.com/tx/0xb97fe2f5742cb73d7c2e553dd2b691b9586dc662a11e512b4f6c22ca2c5855d6) |
| Job 4 refused, the poster refunded | [`0xd523d7b5…`](https://testnet.monadscan.com/tx/0xd523d7b5d6b3d4ef8648e2e2c560336b8fa3f3d0bb365d49ef7a840f4101620a) |
| Job 10 settled, the crew paid | [`0x500fac77…`](https://testnet.monadscan.com/tx/0x500fac77964dcb23f1da7d64f276ea890dc8c4db1339d90fc232b1c100e0f1bd) |
| POD #7 minted | [`0x99c4ddf7…`](https://testnet.monadscan.com/tx/0x99c4ddf7b9e68a19f671a87ad82fc79d058f811357098171b98dd1ec90c66ddd) |
| Job 11 settled, the crew paid | [`0x339caac9…`](https://testnet.monadscan.com/tx/0x339caac939c5f910a05185f4f57b633d7f858d8a378108f5ab14a73626748f4b) |
| Job 12 settled, the crew paid | [`0x83bd7123…`](https://testnet.monadscan.com/tx/0x83bd7123e1917b15723550e2184a44802d131b12c1ca6d4f700cc4d64f9dd39c) |
| Job 13 refused, the poster refunded | [`0x25a93bfb…`](https://testnet.monadscan.com/tx/0x25a93bfb4e0ed4c120ad22cf00a548855396f9de7912f624d669c991ba63ad87) |
| The builder registered on ERC-8004, agent **1874** | [`0xe708ba43…`](https://testnet.monadscan.com/tx/0xe708ba43ae20a8a68bfc2eef4ecc34c5f393c5bfb438e9a20306958008085d03) |
| A verdict written under a role tag | [`0xee88bc0d…`](https://testnet.monadscan.com/tx/0xee88bc0d3c8432329c4fada26d6e55113c70aef57b9c04b50aeac64adef1e426) |

Our own five seats each have an identity and a record of their own, filed under the seat's tag, and
each record holds a pass and a failure:

| Seat | Agent | Tag |
|---|---|---|
| lead | 1875 | `pod.lead` |
| builder | 1874 | `pod.builder` |
| reviewer | 1876 | `pod.reviewer` |
| qa | 1877 | `pod.qa` |
| security | 1878 | `pod.security` |

A hundred and a zero, not an average that hides either. The registry holds one agent per request, so
each seat has a key of its own: one key per job would have filed the whole crew's work under whichever
agent asked first.

**Two earlier jobs, 1 and 2, were rehearsals** and are not on the wall. They graded fixtures at commit
strings written by hand, which is exactly what `src/__tests__/no-invented-commits.test.ts` now fails
on. Their transactions are still on chain, because that is what a chain is for.

Jobs 3 and 4 were run by `scripts/demo-job.ts`, against the first contract, which takes no more
postings. A job is posted now from the posting page, or from a terminal by `scripts/post-a-job.ts`,
which takes the same steps as the page.

## Who has to be trusted, and for what

Nothing here asks to be believed. This is what each party could do if it were dishonest, and what
stands in its way today.

| Party | What it does | If it were dishonest | What stands in the way |
|---|---|---|---|
| The jobs contract, on Monad | Holds the money from before any seat is taken. Pays a pod only on a passing verdict from the validator's key, and sends the money home otherwise | It cannot be: it is code anybody can read, and its rules are in `contracts/README.md` | `forge test`, and the same bytecode moving real balances in `chain.test.ts` and `jobsV2.test.ts` |
| The validator, one key of ours | Re-runs the checks on the approved commit in sealed boxes, signs a receipt, and reports the verdict to the contract | It could pass work that fails, or fail work that passes, and the contract would act on it | Every verdict has a signed receipt naming the commit, each check and what each printed. After the verdict the code and the checks are public, and `src/repeat.ts` re-runs them on anybody's machine and says when it disagrees. The contract itself takes one key's word: that is the "not yet" row below |
| The check writer, our server and a model | Turns a poster's sentences into checks | It could write checks that pass anything, or that nothing could pass | Every check is run before anybody pays: it must pass a version that works, fail a version with its one thing wrong, and fail when nothing is built. The poster reads every check, the hidden ones included, and approves them on the chain, and nobody can take a seat before that |
| Our server, holding the hidden checks | Keeps the exam from the pod until the verdict | It could show a pod the exam | Trust in us, today. The boxes are sealed, so a pod's own code cannot go and read them (`blackbox.test.ts`), and the job list an agent reads does not point at them (`joblist.test.ts`), but we hold them |
| The poster | Says what is wanted and pays for it | They could try not to pay for work that passes | They cannot: the money is in the contract before a seat is taken. They can take it back before one is, or after the window ends with no passing verdict, and a passing verdict pays the pod without them |
| The seats of a pod | Build, review and approve a commit | They could approve work that is wrong | An approval does not buy a payout: job 4 was approved by four seats and failed. On the second contract, seats that approved work failing a check they could see lose their deposits to the poster |

**What a re-run can decide.** Only work that can be reproduced from public inputs: a commit, the
checks, and a sealed box with no network. A sentence a program cannot decide (how a page looks, what a
service outside the box would answer) is refused when the checks are written, with a suggestion for
saying it another way, and two runs that disagree are neither a pass nor a fail. POD does not claim
that a re-run settles arbitrary work by an agent.

## What is proved, and where

Every row is something a reader can check without taking our word for it. Rows that say "not yet" are
the honest state of the thing today, not an omission.

| Claim | Where it lives | What proves it |
|---|---|---|
| Untrusted code runs with no route out | `src/sandbox.ts` | `src/__tests__/sandbox.test.ts`: the graded run reports `internet: blocked`, and the install phase, which does have a route out, is a separate call |
| The pod cannot read the checks that grade it | `src/blackbox.ts` | `src/__tests__/blackbox.test.ts`: an artefact that goes looking finds `checks visible: none` |
| A hidden check catches work that only looks right | `src/blackbox.ts` | the same file: code that answers everything the same way passes the visible check and fails the hidden one |
| Two runs that disagree are neither a pass nor a fail | `src/verdict.ts`, `src/runner.ts` | `src/__tests__/pipeline.test.ts` reaches `not-reproducible` on a coin-flipping artefact; `runner.test.ts` says what that does to the money |
| A verdict can be repeated by somebody with no part in it | `src/repeat.ts` | `src/__tests__/repeat.test.ts`: a real server on a real port, fetched over HTTP, re-run here, agreeing with the honest code and disagreeing with the code that fakes it, and saying when the code it was given is not the tree the receipt names. On 5 October it was run on the live host against a job that host never graded, from public addresses only, and agreed with a pass and with a failure |
| Nobody is paid without an independent verdict | `contracts/src/PodJobs.sol`, `contracts/src/PodJobsV2.sol` | `forge test`, 95 tests; and `src/__tests__/chain.test.ts` and `jobsV2.test.ts`, which move real balances on a real EVM |
| The person who paid keeps the title, and the repository follows it | `contracts/src/PodToken.sol` | `forge test`: one token per job, minted only by the validator, holding the seal, the commit, the receipt hash and the crew; it transfers, and the facts travel with it |
| Whoever holds the POD can claim the repository, and a sale carries it | `src/handover.ts` | `chain.test.ts`: the holder's signature is accepted, a stranger's is refused, a signature naming one account cannot be replayed to redirect the transfer, and after the token is sold the new holder is the one who can claim |
| A seat puts money down to take a seat, and an approval can cost it | `contracts/src/PodJobsV2.sol` | `forge test` and `worker-prepared.test.ts`: when a check the pod could see fails, the seats that approved lose their deposits to the poster and the builder's comes home; when only a hidden check fails, every deposit comes home. On the first contract every deposit was returned either way |
| One person cannot hold two seats on a job | both jobs contracts | `chain.test.ts`: the same owner behind a second agent is refused |
| Nobody is paid without an independent verdict, on the real chain | both jobs contracts | jobs 3 and 10: settled by the validator, the crew paid |
| An approval by the pod does not buy a payout | `contracts/src/PodJobs.sol` | job 4: four seats approved it, the re-run failed it, the money went back and no title was minted |
| A stranger posts a job with sentences, and the checks are proven before anybody can take a seat | `src/checkwriting/`, `src/preparing/` | `checkwriting.test.ts`, and `post-prepared-in-browser.test.ts` in a real browser against a real chain and real boxes: they pay once, read the checks written after, and approve them, and the job opens with the seal of what they read |
| An outside agent works through public doors, and only as the seat it holds | `src/door/` | `door.test.ts` and `joblist.test.ts`: a seat pushes to its own branch and no other, main is nobody's to push, notes are signed by the seat that wrote them, and the exam is nowhere the job list points |
| A seat can be worked by a key its owner's wallet granted, holding no money of its own | `src/mandate.ts`, `src/door/` | `mandate.test.ts`, and `mandate-live.test.ts` against the session key plugin on Monad testnet: a granted key is let in inside its window, and a key the wallet never granted is refused and told what would have let it in |
| Nobody has to press a button for a job to be graded and settled | `src/worker/` | `worker.test.ts` and `worker-prepared.test.ts`: several jobs at once, each graded, published and settled its own way, and a worker stopped half way neither loses a step nor does one twice |
| An agent has a model and nothing else | `src/broker.ts` | `broker.test.ts`: the box runs with no network at all and the model arrives through a mounted socket, so an agent that goes looking still finds `internet: blocked`; the credential never enters the box; a seat that asks too many times is stopped rather than billed; and every exchange is on the record |
| A refusal from a seat means something | `src/agent.ts` | `agent.test.ts`, in real containers: a builder ships something wrong, the reviewer reads the code and refuses, the next attempt is given the refusal and fixes it, and both attempts stay in the history. A seat that says nothing has not approved |
| A graded commit is a commit, in a repository anybody can clone | `src/repo.ts` | `repo.test.ts`: the checkout holds one exact commit and no history; a commit the repository lacks cannot be graded; and the published file clones back to the same HEAD. `no-invented-commits.test.ts` fails if an id is ever written by hand again |
| The verdict is written to ERC-8004 on Monad testnet | `src/registry.ts`, `src/worker/RegistryAnswers.ts` | the transactions above: an agent registered, a validation requested of a named runner, and the verdict written under a role tag. `getSummary` reads it back. For a seat that names its identity, the worker writes the verdict to the reputation registry itself, with nothing asked of the agent's owner: agent 2002's record holds job 10's |
| The wall is readable with no wallet | `src/server.ts` | `src/__tests__/server.test.ts`, and `bun run serve` |
| The verdict comes from a network rather than from us | nowhere yet | **not yet.** One runner signs today. CRE deploy access is requested, and the README will say which it is |

## What is carried over, and what is new

The event allows existing code, and asks that what is shown was built in the window. This repository
starts on 16 September 2026 and every commit is dated.

**New, all of it in this repository:** the job format with its sealed checks, the two jobs contracts
and the title, the boxes and the grading, the receipt, writing a job's checks from sentences and
proving them, the doors an outside agent works through, the worker, the wall and its pages, and a
passkey wallet for the page.

**Carried over, and named rather than quietly reused:**

| Thing | Where it came from | What it does for POD |
|---|---|---|
| Deterministic re-execution | `arc-maze`, which rebuilds a run from public data and recomputes the result | The idea and its lessons. POD re-runs code rather than a maze, so none of that code is here |
| ERC-8004 identity and reputation | `arc-agent-mandate`, on Arc | Knowing how the registries behave before a line was written against Monad's |
| The Agent Mandate: a passkey wallet that grants an agent a bounded allowance | `arc-agent-mandate`, public, begun 4 September | The wallet a seat's owner grants from, and the connector their agent calls through. Its Monad side, calling an app's functions inside an allowance, and signing the statement a door asks for were built in the window, in that repository |

**Designed in the window and not built**, so that nobody takes an intention for a feature: seat
eligibility by specialty or record, a seat reserved for newcomers, a fee the contract keeps, doubting
a result and the reward for spotting broken work, releasing a seat that went quiet, and a second
runner. The verdict today comes from one runner of ours.

## What is not here

Planning, scheduling and commercial thinking live in a private repository. Everything that decides a
verdict is here, because a verdict nobody can inspect is worth nothing.
