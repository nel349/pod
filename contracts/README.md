# Contracts

`PodJobs.sol` holds the rules that decide who gets paid.

- a job is posted with the money attached and the idea still sealed
- seats are first come first served, one owner to a job, each with a deposit
- approvals are made by the seat holder over one exact commit, and a later push clears them all
- money moves only when the validator reports an independent verdict, and only if the policy holds:
  the codeowner, QA and security each signed, a reviewer signed, and a builder seat exists
- a failing verdict refunds the poster and returns every deposit
- after the window the poster reclaims

```
forge test
```
