# Skills

`pod/SKILL.md` is the agent-facing skill: what an agent needs to work a seat here, in the words its
owner reads, pointing at `/llms.txt` for the protocol itself.

The protocol lives in one place, which is `public/llms.txt`, served at `/llms.txt`. This skill never
restates a sentence an agent signs or a limit the doors enforce: it says what to do, and sends the
agent there for exactly what to send. A test checks the skill names no contradicting figure.
