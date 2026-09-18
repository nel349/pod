# How this project tests

Adapted from a QA rulebook whose second and third sections we took as written, and whose first we
rewrote because it would have deleted the only thing this project proves.

The short version: **fake nothing you are asserting about**, and before you write an assertion, ask
what break in the code it would fail on. If the answer is "none", the test is decoration.

---

## 1. The mutation check, which is the rule that matters

Before writing a test, and again before keeping it: **if I deliberately broke the logic under test —
flipped a comparison, skipped the write, returned an empty payload — would this exact test go red?**

If a plausible bug slips past it, the test is structurally blind and the assertion has to bind to the
requirement instead.

Where a test is subtle, say in a comment what bug it is standing guard over. Everywhere else, the
name does that job.

## 2. Assert behaviour, not implementation

Test what the system does that somebody can observe: the returned value, the rendered page, the
balance after the transaction, the state on chain. Not which private function was called on the way.

If the implementation changes and the requirement does not, the test stays green. If the requirement
changes, exactly the tests describing it go red, and they read like the requirement.

## 3. No weak assertions

`toBeDefined()`, `not.toBeNull()`, and "the array has three things in it" are how a test passes while
the feature is broken. Assert the value, the shape, the status, the exact text a person would read.

`expect(outcome.findings).toEqual([])` is better than a length check for the same reason a stack
trace is better than "error": when it fails, it tells you what it found.

## 4. Fake only what you are not asserting about

This is where we part company with the usual advice.

The claim of this project is that nothing is trusted that was not re-executed. So the sandbox tests
run real containers, the chain tests deploy this build's bytecode to a real EVM and move real
balances, the browser tests drive a real browser, and the registry tests read the live testnet. A
mock in any of those positions would prove only that the mock behaves like the mock.

Fake the thing you do not control and are not testing — a third party's paid API, a clock you need to
fast-forward past. Never the thing under test. When a dependency is too slow or too remote to run for
real, that is a fact worth stating in the test's name, not papering over.

## 5. Never sleep for a fixed time; wait for a condition, and say what you saw

Real asynchronous things need waiting for. A fixed `sleep` is either too short, and the test is
flaky, or too long, and the suite crawls.

Poll for the condition, with a deadline, and when the deadline passes, fail with what the thing
actually said. A container that died has a log; quote it. A node that never came up has stderr; quote
that. The version of this rule we learned the hard way: a dead box used to cost ninety seconds and
report "no such container", which is true and useless.

## 6. Determinism belongs in the assertion, not always in the world

Mock the clock when the test is about the clock. Do not reach for it reflexively.

Our "could not be reproduced" verdict is tested against an artefact that genuinely flips a coin, ten
times, because the behaviour under test *is* how the system handles something it cannot predict.
Removing the randomness would remove the test.

## 7. A test that the feature exists, not only that it works

F.I.R.S.T. tests check that what you wrote behaves. They cannot tell you that something was never
wired at all.

On 17 September this codebase graded fixtures at commit strings somebody typed, and every test
passed, because every test was about the grading. The missing test was the one that says: a graded
commit is a commit that exists in a repository.

So for each feature, ask what its absence would look like, and write that check too. Some of them are
one line: a grep that fails if an invented identifier reappears; an assertion that the receipt's
commit resolves; a browser test that the link goes somewhere.

## 8. Names that read as sentences

`test("a weak excuse scores lower than a strong one")` tells a reviewer at 2am what broke.
`test_validateScore_returns_false` does not.

The suite is the specification. It should be readable end to end by somebody who has not seen the
code.

## 9. A flake is a failure

A test that fails one run in twenty is worse than no test: it teaches everybody to ignore red.

Fix it or delete it, the same week. If the flakiness is in the thing under test rather than the test,
that is a finding, and it belongs on the wall rather than in a retry loop.

## 10. Nothing machine-checkable judges whether it looks right

No assertion catches "this is ugly", "this is confusing", or "nobody would know what to click". The
browser layer checks that a thing is reachable, clickable, legible at phone width and not overflowing.
Whether it is any good is a person's call.

So: after a change to anything visible, it goes in front of a person before it is committed.

---

## The layers

| Layer | What it catches | Runs |
|---|---|---|
| Unit | Logic that can be wrong in a sentence: verdicts, shares, seals, routes | every push |
| Container | The sandbox's promises: no route out, checks unreadable, a dead box reported at once | every push |
| Chain | The contract's rules against a real EVM: payment, refund, the held job, a stranger refused | every push |
| Git | That a graded commit is a commit, and the tree is what git says it is | every push |
| Browser | That the pages work as things people use, not as HTML containing the right words | every push |
| Agent | That a seat's agent did its seat's work | locally, and nightly |
| Live audit | That the deployed site is not lying: dead links, holes, receipts that cannot be repeated | before every submission |

A feature is not done until its layer has a test for it, and the mutation check has been asked of
that test.
