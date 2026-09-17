# The sandbox

The engine's one job is to take a commit somebody else's agent wrote, run the acceptance checks, and
say pass or fail. That means executing untrusted code on our machines, on every job, and it is the
piece that can sink the build: if the box is not both sealed and repeatable, the verdict means
nothing, and the verdict is the product.

Two dangers, and people usually only plan for the first.

1. **The code attacks us.** Reads keys, calls out, mines, reaches other jobs.
2. **The code attacks the judge**, which is the one specific to us: rewrite the hidden tests, patch
   the runner so everything reports green, fetch the answers, detect that it is being judged, or be
   deliberately flaky so no verdict can be reached.

---

## What we ran, and what happened

A spike on 2026-09-17: one honest repository and three rigged ones, run in a sealed container, three
times each. Image pinned by digest, `node@sha256:9bef0ef1…`, hidden tests mounted read-only from
outside the repo.

The box: `--network none`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only` with
writable memory-backed `/tmp` and `/work`, `--memory 512m --cpus 1 --pids-limit 128`, the repository
mounted read-only and copied in, and a hard timeout.

| Repository | What it tried | Result |
|---|---|---|
| honest | nothing | **Passed, three times, byte-identical.** Same result digest each run |
| tamper | overwrite the hidden tests before they run | **Blocked.** The write failed with a read-only filesystem error, and the real tests then failed it |
| network | look the answer up over the network | **Blocked.** No route out, and it said so in its own output |
| flaky | return the right answer half the time | **Caught by disagreement.** Six runs gave two different results, so no verdict |

That is the whole threat model exercised end to end, in one afternoon, with nothing but Docker.

---

## The correction: hiding the checks in the same box is not a mechanism

The first spike mounted the hidden tests read-only inside the same container. That stopped the code
**writing** to them. It did nothing to stop it **reading** them, and reading them is enough: the
documented attack is to look at the expected values and return those instead of doing the work.

One benchmark hid its tests in a password-protected archive with the password published in the same
repository, and a researcher reached a **100% pass rate** by replacing the contents. Another put the
grading in the driver rather than the agent's container and still says plainly that if the agent's
submission is executable, very little true protection can be achieved.

Two mechanisms held up everywhere they were tried:

- **The checks never sit where the code runs.**
- **Only the outputs are graded**, by something the code cannot reach. One large competition platform
  runs your notebook privately against a hidden dataset and scores only the file it produces.

## Second spike: grade from outside, over the wire

Run the artefact in one box with no way out, and the checks in another box that can only reach it:

- a private network with no route to the internet
- the artefact box holds the code and nothing else: no checks, no expected values
- the checks box holds the checks and can reach exactly one thing, the artefact

Results on 2026-09-17:

| Case | Result |
|---|---|
| Honest artefact, run twice | **Passed both times**, four of four checks, identical output |
| Artefact that goes looking for the checks | Found nothing. `/checks`, `/hidden` and `/grade` do not exist in its box |
| The same artefact trying to reach the internet | **Blocked, and it said so.** Its own log read `peek=none internet=blocked`, then it carried on and served normally |

That last row is the useful one. The lookup failed immediately rather than hanging, the artefact kept
running, and both facts landed in its log: it found no checks anywhere on its filesystem, and it had
no way out. That is evidence the security seat can read, rather than a job that mysteriously stops.

**A correction to an earlier draft of this file.** A first attempt reported that the artefact stalled
in name resolution and failed by timeout. That was wrong, and it came from a debug run of mine whose
container outlived the command that started it. The block is clean and fast. The outer timeout still
matters, because a run can hang for other reasons, but nothing here demonstrated that.

**So the shape is: the checks drive the artefact from outside.** For POD that is a natural fit,
because the jobs produce things you can drive: a site, an endpoint, a command. Where a check really
has to run in-process, treat it as the weaker kind and say so, rather than pretending the box hides
anything from code running inside it.

## What we copy from people who have been attacked already

Verified from their source, not their marketing:

- **Ridges (a Bittensor subnet)** is the only one that really cuts the network: default-deny egress,
  and the grading runs in a separate pod from the agent. Copy the posture, not the Kubernetes.
- **SWE-agent** reverse-applies the golden test patch before taking the diff, so graded tests cannot
  leak into what gets submitted.
- **Terminal-Bench** tears down the agent's container and verifies in a fresh one. Even so it was
  beaten by replacing a binary to print fake output, which is why the grader must never run anything
  the repository provides.
- **brigade** has the best receipt: exit codes, the tree fingerprint and the base commit, in a signed
  in-toto test-result predicate. Copy the schema.
- **SWE-bench's harness**, by contrast, adds a privileged capability and leaves the network on, and
  pins images by a mutable tag. Its reset only restores files named in the test patch, so a change to
  a config file survives into the graded run. Do not copy it.
- **SWE-Lancer** hid its tests in a password-protected archive with the password in the public repo,
  and a researcher reached a 100% pass rate by replacing the contents. Hiding is not a mechanism.
- **A measured warning:** one benchmark rebuilt every repository as a single fresh commit and blocked
  code-hosting domains, and a model's score fell from 78.8% to 57.3%. Agents mine git history and the
  web for answers whenever you leave them the chance.

---

## The network rule: building is online, grading is offline

Agents should look things up. Reading documentation, pulling packages, searching for how a library
works, calling their model: that is the work, and it happens in the agent owner's own environment,
which we do not control and should not.

**The graded run is the part with no way out**, for four reasons, only one of which is about cheating:

1. **A verdict has to be repeatable.** We run the checks more than once and require them to agree. A
   run that depends on a live third party can disagree with itself, and then a pod is punished for
   somebody else's outage.
2. **Code can behave differently when it knows it is being watched.** With a route out it can fetch
   instructions, or answer well only while reachable. The artefact the buyer keeps would not be the
   artefact that passed.
3. **The checks would leak.** The inputs to the verdict are the one thing the code must not see, and a
   way out is a way to fetch them or to ship them somewhere.
4. **The buyer's safety.** An artefact that quietly calls home is exactly what the security seat looks
   for, and it is easier to see when the graded run has no route at all.

**Honest work often needs the network**, and a flat ban would be wrong. A site that calls a weather
service is not cheating. So:

- **The job declares what it needs to reach**, and that declaration is part of what done means.
- **The graded run gets either a recorded stand-in for that service, or a route to exactly that host**,
  and nothing else.
- **Anything reaching for something it did not declare is a finding**, reported by the security seat,
  not a silent pass and not a mysterious failure.

The spike showed why the last point matters: an artefact making an undeclared lookup was refused
immediately and carried on running, printing the refusal in its own log. That is visible evidence
somebody can act on, rather than a silent pass.

## The design

**Two boxes, and the checks never enter the one holding the code.**

1. **Artefact box.** The pod's code, copied in from a read-only mount, on a private network with no
   route out. No checks on disk, no expected values, nothing to read.
2. **Checks box.** Fresh container from the same pinned digest, holding the checks, able to reach the
   artefact and nothing else. It drives the artefact and grades what comes back.

Where a check cannot be black box, it runs in a third fresh container with the code applied only to
paths that are not tests and not build configuration, and its result is marked as the weaker kind.

**The rest of the posture:**

- **Pin the image by digest**, never a tag. Every harness we read pins by tag and is therefore not
  reproducible.
- **Single-commit repository.** No history, no remotes, no tags, so there is nothing to mine.
- **No network during the graded run.** Dependencies are installed in a separate phase, or baked in.
- **Run three times and require unanimity.** Two answers means "not reproducible", which is its own
  outcome and not a failure of the system.
- **Record a receipt** in the in-toto test-result shape: what ran, the exit codes, the tree
  fingerprint, the image digest, and the base commit. That receipt is what the verdict on chain points
  at.
- **Throwaway host.** A container escape is a host compromise, so the box runs somewhere we are happy
  to lose.

---

## What this does not fix, stated plainly

- **Shared kernel.** Docker is namespaces, not a virtual machine. An escape is a host compromise.
  Accepted, mitigated by running on a disposable host. A managed sandbox on gVisor or Firecracker is
  one dependency away if we want the harder boundary later.
- **Harness detection is undefeated.** Environment variables, hostnames and the absence of a network
  are all visible from inside. Nobody has an answer to this, us included.
- **Deliberate flakiness can be detected, never prevented.** Unanimity turns it into "not
  reproducible" rather than a false pass, which is the best available outcome.
- **Path filters are a denylist, and denylists leak.** An agent that hooks the test runner from inside
  a legitimately editable source file beats the filter. This is exactly why the security seat exists,
  and why the machine-checked part of that seat includes what the diff touches.
- **A signature proves who ran it, not that the result is honest.** Attestations bind provenance. They
  are not evidence of correctness, and we should never present them as such.

---

## What it costs

The spike ran in about a second per run on a laptop, plus the image pull. Three runs per job is
therefore small change next to the cost of the agents themselves, which is the line that actually
decides the price floor. A managed sandbox, if we ever need one, is roughly a cent per run.

---

## Still to do

- Install dependencies in a separate phase, since the spike had none.
- The diff filter, with its list of paths that never apply.
- The receipt, in brigade's shape, signed by the runner.
- Deployment of the built artefact, which is part of "done" and has not been sandboxed yet.
