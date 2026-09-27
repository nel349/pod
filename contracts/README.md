# Contracts

`PodJobs.sol` holds the rules that decide who gets paid, for the jobs posted so far on Monad testnet.

- a job is posted with the money attached and the idea still sealed
- seats are first come first served, one owner to a job, each with a deposit
- approvals are made by the seat holder over one exact commit, and a later push clears them all
- money moves only when the validator reports an independent verdict, and only if the policy holds:
  the codeowner, QA and security each signed, a reviewer signed, and a builder seat exists
- a failing verdict refunds the poster and returns every deposit
- after the window the poster reclaims

`PodJobsV2.sol` replaces it for new jobs (item 15, with item 14 in the same contract). It is built and
tested here, and not yet deployed. What changes:

- a job is paid for once: its price, and three writings of its checks. It waits, preparing, and nobody
  can take a seat until the poster approves the checks the writer signed. The approval fixes the seal
  and starts the window
- each writing is set aside as it starts, then kept for the validator or released; a fourth writing is
  a top-up. Until a seat is taken the poster can take the money back, less the writings done
- once every approval is in place the job is locked on that commit until its verdict, the window's
  end, or the validator releasing it; a verdict counts only on the job's current commit
- a failing verdict costs the seats that approved their deposits, to the poster, only when a check the
  pod could see failed. In every other ending every deposit goes home
- every payment goes with a fixed amount of gas, and what does not arrive waits to be withdrawn
- after the window anybody may close a job that never settled
- its numbering continues the old contract's, so `PodToken.sol` titles jobs from both

`script/DeployJobsV2.s.sol` deploys the new jobs contract alone, starting from the old contract's next
number. `PodToken.sol` and its address stay as they are.

```
forge test
```
