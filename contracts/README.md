# Contracts

Four contracts. Three are live on Monad testnet (chain 10143), and the fourth is written, tested and not yet deployed:

| Contract | Address | What it holds |
|---|---|---|
| `PodJobs.sol` | `0xBAD56C4b830c8B4Aa71A6880D870049270f2A2F2` | Jobs 1 to 9. Read and graded still, posted to no more |
| `PodJobsV2.sol` | `0xc831b6e4414E064F7713A3b6017be4a1Eb9F5E9b` | Every job from 10 on |
| `PodToken.sol` | `0x31CDFdFf36e0125aeE49D21F3Fd80eE2F0F3b617` | The title to a job that passed, one per job, for jobs on either |
| `PodJobsV3.sol` | not deployed yet | The contract on which the poster has the last word. It replaces `PodJobsV2.sol` for new jobs once the one job still open there is taken back |

`PodJobs.sol` holds the rules that decided who got paid for the first nine jobs.

- a job is posted with the money attached and the idea still sealed
- seats are first come first served, one owner to a job, each with a deposit
- approvals are made by the seat holder over one exact commit, and a later push clears them all
- money moves only when the validator reports an independent verdict, and only if the policy holds:
  the codeowner, QA and security each signed, a reviewer signed, and a builder seat exists
- a failing verdict refunds the poster and returns every deposit
- after the window the poster reclaims

`PodJobsV2.sol` replaced it for new jobs. It was deployed on 2 October 2026, 02:44 UTC. What changed:

- a job is paid for once: its price, and three writings of its checks. It waits, preparing, and nobody
  can take a seat until the poster approves the checks the writer signed. The approval fixes the seal
  and starts the window
- each writing is set aside as it starts, then kept for the validator or released; a fourth writing is
  a top-up. Until a seat is taken the poster can take the money back, less the writings done
- the builder builds and the other seats judge: a builder's approval is refused
- once every approval is in place the job is locked on that commit until its verdict, the window's
  end, or the validator releasing it; a verdict counts only on the job's current commit
- a failing verdict costs the seats that approved their deposits, to the poster, only when a check the
  pod could see failed. In every other ending every deposit goes home
- every payment goes with a fixed amount of gas, and what does not arrive waits to be withdrawn
- after the window anybody may close a job that never settled
- its numbering continues the old contract's, so `PodToken.sol` titles jobs from both

`script/DeployJobsV2.s.sol` deployed the new jobs contract alone, starting from the old contract's next
number. `PodToken.sol` and its address stayed as they are.

`PodJobsV3.sol` is the second contract with the ending changed. What changed:

- the builder puts its work forward as one exact commit, and the other seats say whether they stand behind it
- no seat can hold work back: a review lasts a quarter of the job's window, and a delivery waits only for seats that are taken. After the review the work is graded with whoever stands behind it
- the validator reports what the checks found and moves no money. The job is then delivered, and its poster has a time fixed at deployment to accept or refuse
- accepted, the pod is paid, whatever the checks found. Refused after its checks passed, the pod keeps a quarter and the rest goes back. Refused after they failed, everything goes back. Unanswered, the checks decide, and anybody may settle it
- only the builder and the seats that stood behind the delivered commit are paid, and what the others would have had goes back to the poster
- a job's own poster takes no seat on it, as the agent or as an agent's owner. This turns away their own address and not a second one of theirs, which nothing on a chain can
- it counts how each poster's jobs ended and how each agent's did, so either can be read before a seat is taken
- its numbering continues the second contract's, so `PodToken.sol` titles jobs from all three

`script/DeployJobsV3.s.sol` deploys it alone, and `scripts/deploy-jobs-v3.sh` refuses to run while any job on the contract it replaces is unfinished.

```
forge test
```

238 tests: 14 for the first jobs contract; 65 for the second and 2 that hold its sums under random
sequences of calls; 128 for the third, 2 that hold its sums under random amounts and 8 under random
sequences of calls; 3 and 5 for the two deployments that continue the numbering; and 11 for the title.
