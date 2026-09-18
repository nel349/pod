# What a judge sees, in the order they see it

Walked on 2026-09-17, against the server running locally with three jobs on it: one that passed, one
that failed, one whose runs disagreed. Everything below was looked at, not imagined. What has not
been walked is the deployed site, because there is not one yet; that is the last line of this file.

The rule this file exists to enforce: **a judge with no wallet, no key and no account can check the
central claim in about two minutes.** If a step needs something installed, it is not on this path.

## The path

| # | They see | What it proves | Checked |
|---|---|---|---|
| 1 | **The wall**, newest first, three jobs, one of each outcome | Failures are published beside successes. The counts are on the page: 1 passed, 1 failed, 1 could not be reproduced | yes |
| 2 | A tile says the verdict **in words**, with the time, the price in MON and the mode | Nothing on a tile is a number we invented | yes |
| 3 | A tile with no independent security seat says **"security seat held by the platform"** | The disclosure is on the tile, not buried in a document | yes |
| 4 | They open a job. It names the **commit** and the hash the idea was **sealed** under before it opened | The job could not have been built before it was posted | yes |
| 5 | **What was checked**, each check in a sentence, with the hidden one marked *hidden from the pod* | The pod was graded on something it could not read | yes |
| 6 | **Fetch the checks** — a plain list, then the files themselves, hidden ones included | A stranger can get everything the verdict came from | yes |
| 7 | **Who signed what**: seat, agent, commit, time | Approvals are bound to one exact commit | yes |
| 8 | **Check it yourself**: the exact docker command, the image by digest, the start command, the tree fingerprint | The run is repeatable by someone who trusts nobody | yes |
| 9 | The job whose runs disagreed says **what that means for the money** | The third outcome is explained rather than left as a phrase | yes |
| 10 | They run `bun run src/repeat.ts <job url> <the code>` and get the same verdict | The claim at the centre of the project, on their machine | yes, against a local server |

## Widths

Measured at 390 and 320 CSS pixels with the pages in an iframe of that width:

- Neither page scrolls sideways at either width.
- The approvals table is wider than a phone and scrolls **inside its own box**, which is the intended
  behaviour: an address is forty-two characters and breaking it across lines makes it unreadable.
- The wall is one column on a phone and three at desktop width.

Two things that width found and that are now fixed: a price with no unit, and long addresses widening
the whole page because a grid child will not shrink below its longest word.

## What we run before we submit

```
bun run src/audit.ts https://<the host>
```

It opens the wall as a stranger would, follows every job link, fetches every published check and
every receipt, and fails on a dead link, a page with a hole in it, or a receipt that cannot be
repeated. It found one hole the day it was written. Its output on submission day is saved beside the
entry.

## Not walked yet

The deployed site. The host, the name and the key that signs are still to be decided, and until they
are, every line above is true of a server on a laptop rather than one a judge can open.
