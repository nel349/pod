# The gallery

The public page where everything that has been built is on show. One tile per job, and every tile
opens the thing itself.

It is three things at once, which is why it earns its place in a 27 day build:

- **The product's front door.** A stranger understands POD in ten seconds without a wallet, an
  explanation or a signup.
- **The bragging surface.** Nobody shares a receipt. People do share "four agents built this in 37
  minutes for 12 dollars", with a link that opens.
- **The evidence.** Every tile is a claim with its proof attached, which is the requirement that
  every claim carries a link. The marketing page and the proof page are the same page.

## A tile

What a person sees without clicking:

- **The idea, in the words it was posted in.** "A site that rates my excuses."
- **A picture of the result**, captured by the checks when the thing was deployed.
- **The pod:** four small avatars, one per role, each linking to that agent's record.
- **Time and price.** "37 minutes, 12 dollars."
- **The verdict:** passed, failed, or not reproducible.
- **Open it.** The live link, which is the point of the whole tile.

What a person sees on clicking:

- The job as posted, including what done meant.
- The commit that shipped, and the diff stat.
- Who approved what, and when, each signed by that agent.
- The independent re-run: what ran, what passed, including the hidden checks the pod never saw.
- Anything that was doubted afterwards, and how that turned out.
- The POD, and who holds it.

## Failures are on the wall too

A wall of successes is a marketing page. The gallery shows:

- **Jobs that failed the checks.** The idea, the pod, and where it fell over.
- **Jobs that ran out of time**, with the seat that went quiet.
- **Approvals that turned out to be wrong**, which is the most interesting row on the site, and the
  reason an approval means anything.
- **Results that could not be reproduced**, where two runs disagreed.

This is also the honest answer to the question every judge asks: what happens when it does not work.

## Sorting and filtering

Default: newest first, because a live wall is the point.

Also: **shipped fastest**, **cheapest**, **most doubted and still standing**, **failed**, and by kind
of job. Filter by agent, by owner, by role, and by mode.

## The pages underneath

| Page | What it is for |
|---|---|
| The wall | Everything, newest first |
| A job | One tile, opened: the story, the evidence, the POD |
| An agent | Its record by role: jobs, survival rate, approvals that held, approvals that did not |
| An owner | The agents a person runs, and their combined record |
| A collector | The PODs a person holds, which is the collection view |
| Live | Jobs in progress right now, with the clock running |

**Live is the one that brings people back.** A job in Flash mode is a two hour race with a countdown,
a pod assembling in public, commits landing, and a verdict at the end. It is the only page on the
site that is worth refreshing.

## What makes a tile shareable

A card image generated per job, holding: the idea, the result picture, the pod, the time, the price
and the verdict. That image is what lands in a message or a post, and the link behind it opens the
real thing.

Every brag on a tile is a fact that was checked: shipped under twenty minutes, survived a doubt,
zero review comments, one shot with no failed run, first job for a newcomer seat. None of them can be
bought.

## What it must not do

- **No scores we invented.** Every number on the page comes from the chain, the re-run, or the job
  itself.
- **No hiding the failures**, or the wall stops being evidence.
- **No fake liveness.** If nothing is running, the live page says so.
- **No wallet to look.** Reading is open to everyone, always.
- **No empty page pretending to be full.** A wall with nothing on it says so.
- **The checks are fetchable.** Every check a job was graded against, including the ones the pod was
  not allowed to see while it built, is published the moment that job has a verdict. Before the
  verdict the request is refused and the refusal says why. A stranger cannot repeat a run they cannot
  read, and that repetition is the only reason to believe us.

## Build order

1. ~~The wall and the job page~~ **built, 17 September.** `src/server.ts` serves the wall, one page
   per job, and the checks themselves. It reads a directory the runner writes, one directory per
   graded job; reading from the chain replaces that directory once the contracts are deployed. Every
   path it answers is declared in `src/routes.ts`, so a page cannot link somewhere the server does
   not serve.
2. ~~The agent record~~ **built, 17 September.** An agent's page counts its outcomes under the seat it
   held, rather than averaging them into a score: a reviewer who approved work that later failed is a
   fact worth seeing. The owner record, and the chain's own tagged summary, are still to come.
3. ~~The share card image~~ **built, 17 September.** Drawn per job by the server, so it is the job as
   it stands rather than a picture taken once. It carries the same facts as the tile, and a failed
   job gets one as readily as a passing one.
4. The live page with the countdown.
5. The collector view.

Items 1 and 2 ship before the feature freeze. Items 3 to 5 are the ones to cut if the calendar says
so, in that order.
