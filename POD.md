# POD: Proof of Development

**Bring an idea, assemble a pod, keep the proof.**

Somebody with an idea and twenty dollars posts a job. A pod of agents, each owned by a different
person, claims the roles and ships it. An independent network re-runs the acceptance criteria before
anyone is paid, and the result is written on chain. The person who paid keeps a POD: a collectible
that holds the commit, the crew, the verdict and a link to the thing itself.

**This is not a contractor.** It is an arcade for ideas: funny jobs, crazy ideas, experiments. Saying
that plainly is the positioning, not a disclaimer.

## Why this framing

- **The serious market is empty.** One live agent bounty market has 33,000 registered agents and
  three open tasks. Fun does not need a procurement budget.
- **Maintainers have turned hostile to agent pull requests**, and one bounty platform closed over it.
  We never touch anyone else's repo. Every job is a fresh repo the pod creates.
- **Expectations stay honest.** Nobody is let down by a scrappy result when the pitch was an arcade.

## The loop

1. **Post.** An idea, a price, a window, and what done means. The spec is sealed until kickoff.
2. **Assemble.** Agents take the roles: lead and codeowner, builder, reviewers, QA, and security.
   Every seat costs the same percentage to hold, and reviewer seats are assigned rather than chosen.
3. **Ship.** The pod works in a fresh repo through pull requests. Approvals are signed by each
   agent's on-chain identity, over the exact commit.
4. **Prove.** An independent re-run executes the acceptance criteria, including tests the pod never
   saw, in a clean sandbox, twice. The verdict goes to the ERC-8004 Validation Registry.
5. **Pay.** The money splits by role, but only if the policy holds: the re-run passed, approvals met
   the threshold, the codeowner signed, QA signed, **security signed**, and the approvals cover the
   merged commit.
6. **Mint.** The POD goes to the person who paid. Each agent gets a soulbound credit naming its role.
7. **Show.** The gallery gets a new tile, with a link anyone can open.

## What a POD holds

Not a picture of a robot. The receipt:

- the repo and the exact commit that shipped
- the pod: which agent held which role, by on-chain id
- the verdict, including what the hidden tests found
- time to ship, price paid, diff stat
- a link to the running thing

**Traits are facts, not a rarity table.** Shipped under twenty minutes. Survived a challenge. Zero
review comments. One-shot, meaning no failed re-run. Four-role pod. None of them can be bought.

## Two tokens

| Token | Goes to | Transferable | Purpose |
|---|---|---|---|
| POD | The person who paid | Yes | The collectible, the brag, the gallery tile |
| Credit | Each agent that worked | No | The resume, tagged by role, feeding role-scoped reputation |

The deployed reputation registry already takes role tags on feedback and filters summaries by them.
Nobody has populated them with roles. We would be first.

## What "done" means

Objective or it does not gate money:

- the branch builds
- the test suite passes at the merged commit
- **hidden checks**, which the pod never sees, pass when they drive the artefact from outside
- the artefact deploys and loads
- the owner's checklist items each have a check
- **anything the artefact needs to reach on the network is declared in the job**, and the graded run
  allows exactly that and nothing else. An undeclared call is a finding for the security seat

Anything about taste is judged by the gallery, never by the chain. Say so in the copy, because it is
the first question anyone asks.

## Timing, and why it cannot be gamed by hand

- **Sealed spec.** The job is a hash until kickoff, so nothing can be pre-built.
- **Hidden tests.** You cannot overfit to tests you have not seen.
- **Decaying payout.** Full value early, less later. Speed is worth money, so machine speed wins
  without a rule about who typed the code.
- **Liveness that measures progress, not noise.** First pull request within twenty minutes of
  claiming. Commits only count when they change source or tests. No gap longer than the mode's idle
  limit. Miss it and the seat is released, and the deposit with it.
- **Injected events.** At random moments the pod must respond: a change request, a failing test, an
  added constraint. This is the control a human cannot service at three in the morning.

| Mode | Window | Idle limit |
|---|---|---|
| Flash | 2 hours | 10 minutes |
| Sprint | 24 hours | 30 minutes |
| Project | 7 days | 2 hours, plus daily events |

## Where the money goes

Fixed prices throughout. The person who posts the idea sets the price, the split per role is fixed
and published with the job, and every seat costs the same percentage to take. Nothing is negotiated.
Agents compete on speed and on their record, never on price.

**Everything is a percentage of the job's price.** A seat deposit and the doubting fee exist for two
reasons only: to cover the technical costs of running the checks, and to make spamming expensive.
They are not a revenue stream. The percentages below are starting values to tune, not decisions.

| Money | How much | Why it exists |
|---|---|---|
| The price | Set by the person posting the idea | What the pod is paid |
| Role shares | Fixed percentages of the price, published per job | So nobody negotiates |
| Seat deposit | A percentage of that role's share, say 10% | Returned when the seat is done properly. Kept if the agent abandons the seat or its approval turns out to be wrong |
| Checking budget | A percentage of the price, say 5% | Pays for the sandbox runs, the gas and the mint |
| Doubting fee | A small percentage of the price | Pays for the extra re-run someone asked for |
| Spotting reward | A percentage of the price | Paid to whoever finds broken work, out of the checking budget |

**Told as a story.** Maria pays 20 for "a site that rates my excuses".

- Four agents take the seats: lead, builder, reviewer, QA. **Each puts down a deposit to hold its
  seat**, a percentage of what that seat pays. The deposit is what makes an approval mean something.
- The pod ships. The network runs Maria's checks independently. They pass.
- Maria gets her site and her POD. The price splits between the four agent owners by the job's fixed
  shares, less the checking budget.
- If the checks fail, or the pod runs out of time, Maria gets her money back less the checking that
  was actually done.
- An agent that abandons its seat loses its deposit and the seat is refilled.

**How seats are taken: first come, first served, among agents that qualify.** No queue-jumping and
nothing assigned by us. An agent qualifies for a seat when both hold:

- **Specialty.** The agent is registered for that role, and for the kind of work the job names.
- **Record.** It meets the reputation bar the job asks for in that role, which the person posting the
  idea can raise or leave at the default.

Speed and record are therefore the only things that get an agent a seat.

**One seat per job is kept for a newcomer.** A reputation bar plus first come first served would
close the door behind the first cohort, so every job reserves one seat for an agent with no record in
that role yet.

- The newcomer seat still needs the specialty, and still puts down the same deposit.
- It cannot be the codeowner, since that approval is the one the payout depends on.
- If no newcomer takes it before the job would otherwise stall, it opens to everyone, so a job is
  never blocked waiting for one.
- Work done in that seat earns a record like any other, which is how an agent stops being a newcomer.

**One owner, one seat.** A pod cannot be packed with friends, so the rules that matter are about
owners rather than agents:

- One owner holds at most one seat on a job.
- The reviewer and QA seats cannot share an owner with the builder or the lead.
- A job posted by someone who also holds a seat on it is flagged as self-posted, publicly, and the
  record it earns is counted separately.

### Doubting a result pays a reward, never the deposit

Anyone can doubt a result, including someone who had nothing to do with the job.

- They pay the doubting fee, which covers the re-run they are asking for.
- **If the work really is broken:** they get the fee back plus **the spotting reward**. The agent that
  waved it through loses its deposit, and **that deposit goes to Maria**, because she is the one who
  ended up with broken work.
- **If it holds up:** the fee paid for the re-run they asked for, and the approver's record gets a
  little stronger.

**Why not simply hand the deposit to the doubter.** That turns doubting into a bet: a small amount
down, a larger amount back if you are right, on an outcome you do not control. Whatever we call it,
that is the shape of gambling, and the rules differ by country. A set reward for finding a real
defect keeps the same reason to go looking, and it is how bug bounties have worked for years.

| | Doubter takes the deposit | A set reward for spotting it |
|---|---|---|
| What the doubter is | Someone with a position on an outcome | Someone paid for finding a defect |
| Where the deposit goes | To the doubter | To the person who paid for the job |
| What they can win | Large and variable | Small and fixed |
| Invites a legal conversation | Probably | Much less likely |

**This is the rule on every network, mainnet included.** Not a testnet compromise to revisit when the
money is real. The amounts are parameters; who receives the deposit is not.

## The security seat

The sandbox protects us while the code runs. It does nothing for the person who ends up owning the
repository and a live deployment. A malicious dependency, an install script, or a quiet call home
passes a green test suite without trouble, so **every pod carries a security seat, and its approval
is required before anyone is paid.**

**Part of it is machine-checked, inside the same sealed run:**

- dependencies added, and where they came from
- install and post-install scripts, which are the classic way in
- anything reaching the network during the run, which the sandbox already blocks and can therefore
  report
- secrets and keys committed to the repository
- licences of what was pulled in
- obfuscated or generated blobs nobody can read

**The rest is judgement, and that is what the seat is for.** The security agent reads what the machine
flagged, looks at the diff, and signs or refuses. Like every other approval it carries a deposit, and
being wrong costs it.

**We hold the seat at first.** Nobody has a security record yet, so the platform fills it until agents
qualify, and **the tile says so in plain words**: security seat held by the platform. The same honesty
rule as the verdict: never imply an independence we do not have.

Two rules that keep it from becoming theatre:

- **It cannot be the same owner as the builder**, ever, including while we hold it.
- **The machine-checked part is what can be doubted**, because it can be re-run. The judgement part is
  an attestation, and it is the deposit rather than the re-run that gives it weight.

**Not cuttable.** Everything else in the cut list can go. A pod that ships code to a stranger without
anyone looking for a trap is the one version of this we should not ship.

## Who owns what

**The POD is the title, and the repository follows it.** When a job passes, the repository is
transferred to whoever holds the POD.

- **On a passing verdict the repo is handed over.** The person who paid names a GitHub account and it
  becomes theirs: code, history, issues, the lot.
- **If they do not claim it**, it stays in the platform's account, public, for a claim window of
  about thirty days, with reminders before the window closes. After that the live repository and the
  running deployment are removed, so we are not carrying somebody else's abandoned work for ever.
- **Removed is not lost.** The unalterable copy stays, with its hash. A claim after the window
  restores the code into the owner's account from that copy, so a late claimer is never turned away
  and the gallery tile keeps its evidence. What disappears is the hosting bill, not the artefact.
- **If the POD is sold, the repo follows.** The new holder claims the transfer the same way. The token
  is the title; the handover is a claim, not an automatic push.
- **A copy is kept that nobody can alter**, hashed and recorded with the job, so the artefact survives
  a deleted repo, a lost account or a platform outage. It is also what lets anyone re-run the checks
  later.

**Hosting.** The deployment stays up for a period included with the job. After that the owner has the
repository and can deploy it anywhere. That is the honest answer to hosting something forever: we do
not, and the owner is never stranded because they hold the code.

**Licence.** The agents that take seats waive their claims when they take the seat, so the work
belongs to the person who paid. Public jobs ship under a permissive licence by default, which is what
makes remixes possible. Private jobs, if they exist later, are the exception and priced as one.

**Follow-ons after a transfer.** Once the repo belongs to the owner, a later pod needs access. The
owner grants it per job, and it lapses when the job ends. Nobody keeps standing access to somebody
else's repository.

## What is actually unsolved: cooperation across owners

Orchestration is a solved problem. Role frameworks, coding agents that edit repos and open pull
requests, and sandboxed runtimes all exist and are active. What none of them do is let agents owned
by **different people** work on the same job and get paid for their part.

| | One owner | Many owners |
|---|---|---|
| Agents work alone | Devin, SWE-agent, Cursor agents | Kaggle, Topcoder, HackerOne, Bittensor subnets: many owners, competing, never cooperating |
| Agents work together | CrewAI, MetaGPT, ChatDev, AutoGen, GitHub Agent HQ | **Empty** |

Crowd platforms have many owners and keep them isolated. Frameworks have real collaboration and
assume one owner. Cooperative work across owners is the empty square, and it is where POD sits.

**The frameworks are not multi-owner by accident.** Each assumption below holds inside one trust
domain and breaks across several:

- **Messages pass in memory.** Roles are objects in one process, so there is no wire between owners
  and nothing to attribute.
- **One credential, one checkout.** One key, one repo, one machine. Five strangers cannot share push
  access and still call the result trustworthy.
- **Nobody lies.** No signatures, because inside one owner there is nothing to prove.
- **No notion of value.** A task has no price, no split and no stake. Nothing knows what a role is
  worth.
- **Failure is a retry.** In-process you loop. When a stranger's agent vanishes, a seat has to be
  released and refilled.

**So the substrate between owners is the product:**

| Piece | What it means here |
|---|---|
| Shared state | The repo, not memory. Branches and pull requests are the only place agents meet |
| Message bus | Repo events and the job board. An agent reacts to a review comment, not a function call |
| Attribution | Every commit and approval signed by that agent's own on-chain identity, over the exact commit |
| Credentials | Scoped per role: an agent can push to its own branch and nothing else. The platform merges |
| Value | The job has a fixed price, roles have fixed shares, seats cost a deposit, approvals carry it |
| Liveness | A rule, not a loop. A missing agent loses its seat and the seat is refilled |

**We do not write an agent.** Agent owners bring their own: a coding CLI in a container, the model
they pay for, the skills they wrote. Reusable on that side: sandboxed repo-editing runtimes, the
issue-to-pull-request loop, role orchestration, and the per-task container harnesses built for
coding benchmarks, which are the closest thing to our hermetic re-run. Our build is the seat, the
rules, the proof and the money.

That is also the community story: people compete by writing better skills for the same runtime, and
the leaderboard shows whose reviewer actually catches things.

The nearest working analogue is a Bittensor subnet: miners owned by different people, validators
scoring their work, rewards by result. The difference is that those miners never collaborate. Ours
have to, on one repo, which is why signed attribution and scoped credentials matter more here than
they do there.

## What exists already, and what does not

| Piece | Who has it | What is missing |
|---|---|---|
| Paying for a pull request with crypto | Obol, $5 USDC on Base mainnet, live | No acceptance gate of any kind. Pay first, PR appears, nothing checks it |
| Sandboxed verification of bounty work | frantic-board, 373 stars, active | Settles off chain, results unsigned, reputation is one global number |
| Agent identity and reputation | ERC-8004, live on 40+ chains including Monad | Role tags exist and nobody populates them |
| Re-execution of agent work | Bittensor's Ridges | Benchmarks, no customer, winner takes all |
| Tests as the grading standard for real money | SWE-Lancer, $1M paid on 1,400 tasks | A human still releases the payment |
| Validation Registry | Deployed on Arc testnet, Sepolia and **Monad testnet**; absent from mainnets | One live consumer, writing a compliance tag rather than a code one |

**The unoccupied intersection:** a signed, re-executable verification result that is itself the
release condition on the money held for the job, written where the standard says it belongs.

## Risks worth naming

- **Running untrusted code.** Needs a real sandbox and a hard time limit. This is the first thing to
  prove, because it can sink the build.
- **Agents cost money.** The role share and the decay curve have to beat the model bill, or only
  subsidised pods show up.
- **Flaky tests.** Two runs must agree. If they do not, the verdict is "not reproducible", which is a
  real outcome, not a failure of the system. **Decided 17 September: that outcome holds the job.**
  Nothing is paid and nothing is refunded; the money goes back to the person who posted it when the
  job's window closes, which the contract already does for them, and the pod's deposits go home at
  the same moment. Two runs disagreeing is a fact about the run, not a finding about the work, and
  ending somebody's job on it is a decision a person can still make by hand before the deadline.
- **A quiet gallery.** If nothing ever fails, the wall is marketing. Failures get posted too.
- **Collusion inside a pod.** Reviewer seats are assigned rather than chosen, approvals carry
  liability against the re-run, and pods that always appear together are visible in the index.

## Scope for 13 Oct

**Must ship:** one job template, three roles, sealed spec, hidden tests, the sandboxed re-run, the
policy check, the split, the POD mint, the gallery, and one mode (Flash).

**Then:** injected events, challenges, the credit tokens, Sprint mode, the index.

**Cut first:** Project mode, multi-pod jobs, anything creative being judged on chain, the role market
from the full vision. That vision is the roadmap slide, and it is a strength there.

## Decided later

Parked on purpose, with the reason each one can wait.

- **What an archived tile looks like.** Once an unclaimed job's deployment is removed, the tile loses
  its "Open it" link, which is the best thing on it. Options: keep the deployment up longer than the
  repository, or keep a screenshot and mark the tile archived. Decide when the gallery is built.
- **Whether micro jobs run with fewer seats.** Two roles instead of four may be what makes a cheap job
  clear its price floor. Decide once the first cost measurements exist.
- **The take rate.** Named and set to zero. Decide a real number only after the twenty-job test.
- **Private jobs.** Priced differently and licensed differently. Not before there is demand for public
  ones.
