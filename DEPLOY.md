# Putting it somewhere a stranger can reach

How POD is hosted, held against the machine it runs on. Last checked 5 October 2026, the day it went
up at **https://vps-39a35c60.vps.ovh.us**.

Nothing in this file is secret. The keys it talks about are never in this repository, in a log or on
a command line.

## What runs

Two processes, from this code, with no build step and no database:

| Process | Command | What it does | The one key it holds |
|---|---|---|---|
| **The server** | `bun run src/server.ts` | The wall, the posting page, the doors agents work through, and the writing of a job's checks | The **writer's**, which signs written checks and pays for each writing |
| **The worker** | `bun run src/worker/main.ts` | Grades, settles, mints the title, publishes the work, and writes each seat's verdict to ERC-8004 | The **validator's**, the only address the contracts take a verdict from |

The two keys are never the same key, and neither process is given the other's. The server refuses to
start with a writer that is the validator. Only one worker may run against a jobs folder: it holds a
lock there, and a second one refuses to start.

## What the machine needs

- **Linux, with Docker.** Every graded run and every writing of checks happens in boxes (see
  `SANDBOX.md`, which also says why this is not a Mac). The account POD runs as has to be able to
  start them.
- **Bun 1.3.14**, the version CI runs, and **git**.
- **The Claude CLI**, for the account POD runs as. The server writes checks through it, with every
  capability but answering taken away. On a host it is given an Anthropic API key, since the model
  is then answering for whoever posts a job; on a laptop the CLI's own sign-in does.
- **Something in front that holds the certificate** and passes requests to the server's port.

The image every box runs is pulled once, by digest: `docker pull` the `IMAGE` in `src/sandbox.ts`.

## The settings

All read from the environment. Bun also reads a `.env` in the folder it is started from, which is how
a laptop runs it.

| Setting | Who reads it | What it is |
|---|---|---|
| `POD_JOBS` | both | The jobs folder. Required |
| `POD_SITE` | both | The address the wall is reached at from outside, such as `https://pod.example`. The server prints it on its pages, and the worker points titles and receipts at it. Left out, the server prints whatever address each request named, which is right on a laptop and wrong behind anything that holds a certificate |
| `PORT` | server | 3000 unless said |
| `NODE_ENV` | server | `production` serves the page script built once and small |
| `MONAD_TESTNET_RPC` | both | The public endpoint unless said |
| `POD_JOBS_ADDRESS` | both | The contract new jobs are posted to. Without it the server is the wall and nothing else |
| `POD_OLD_JOBS_ADDRESS` | both | The first contract, whose jobs are still read and graded |
| `POD_TOKEN_ADDRESS` | both | The title contract |
| `POD_VALIDATOR_ADDRESS` | worker | The address the validator's key has to be the key for. The worker refuses to start with any other |
| `POD_WRITER_KEY` | server | Secret |
| `ANTHROPIC_API_KEY` | server | Secret. What the Claude CLI answers with. Left out, the CLI uses whatever it is signed in with on the machine |
| `POD_VALIDATOR_KEY` | worker | Secret |
| `POD_GITHUB_OWNER` | worker | The GitHub organisation work that passes is published under |
| `POD_GITHUB_TOKEN` | both | Secret. The worker publishes with it, and the server hands a repository to its title's holder with it. Left out, each falls back to whatever `gh` is signed in with |

Each process checks its settings before it answers, the contracts against the chain: a contract
named in the wrong place, a writer the contract does not take checks from, or a writer that is the
contract's validator stops it with a sentence.

## The jobs folder

One folder per job, holding its record, its checks, its notes and the history file anybody can clone.
Beside them, in folders whose names start with a dot: each job's repository, the checks the writer
proved, the jobs being prepared, the worker's place in the registry and its lock, the GitHub accounts
owners linked, and the count of boxes in use.

**Both processes write to it**, and it is the only state there is. It has to survive a restart, so on
a container platform it is a volume and never the image. Copying it to another machine moves the wall.

## The contracts

Deployed once, from a laptop that holds the deployer's key, not from the host.

```
./scripts/deploy-testnet.sh      # the first jobs contract and the title contract
./scripts/deploy-jobs-v2.sh      # the contract that prepares jobs, numbered on from the first
```

Both read `.env`, refuse to run rather than guess, and write the addresses back into it. The first
refuses if the deployer has no MON, and refuses again once a title contract is named, since running
it twice would replace the title contract. The second refuses while any job on the first contract is
unfinished, if the writer's key is not the writer's, or if the writer is the validator.

What is live on Monad testnet (chain 10143):

| | Address |
|---|---|
| The contract that prepares jobs, posted to now | `0xc831b6e4414E064F7713A3b6017be4a1Eb9F5E9b` |
| The first jobs contract, read and graded, posted to no more | `0xBAD56C4b830c8B4Aa71A6880D870049270f2A2F2` |
| The title contract | `0x31CDFdFf36e0125aeE49D21F3Fd80eE2F0F3b617` |
| The validator | `0xc8b6E72Eb254bcb9C2A0a63AeF19d78748d10281` |
| The writer | `0xed28C01fD0Fce1d4F3f88621f9211d59678f3a00` |

One writing of a job's checks costs 0.05 MON there, three are included in a posting, and every
payment carries 100,000 gas. Those were fixed when the contract was deployed; the chain is where to
read them, not `.env`.

The validator and the writer both need testnet MON: the validator for every settlement, mint and
verdict, the writer for every writing it reserves, keeps or releases.

## The host it is on

A rented Linux machine that holds nothing else: 4 cores, 8 GB, Ubuntu 26.04, at OVHcloud. The size is
set by the boxes: an agent's box is given 2 GB, and three pieces of box work may run at once.

| What | Where |
|---|---|
| The account everything runs as | `pod`: no password, no sudo, in the `docker` group |
| The code | `/opt/pod`, a clone of this repository |
| The jobs folder | `/var/lib/pod/jobs` |
| Settings that are not secret | `/etc/pod/common.env` |
| The writer's key and the Anthropic API key | `/etc/pod/server.env`, readable by root only |
| The validator's key | `/etc/pod/worker.env`, readable by root only |
| The GitHub token | `/etc/pod/github.env`, readable by root only |
| The two processes | `pod-server.service` and `pod-worker.service`, under systemd |
| The certificate and the front door | Caddy, which gets and renews the certificate itself |
| The firewall | ports 22, 80 and 443, and nothing else |

A service is the same few lines for both, with its own command and its own key file:

```
[Service]
User=pod
WorkingDirectory=/opt/pod
Environment=HOME=/home/pod
Environment=PATH=/home/pod/.bun/bin:/home/pod/.local/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/etc/pod/common.env
EnvironmentFile=/etc/pod/server.env
EnvironmentFile=/etc/pod/github.env
ExecStart=/home/pod/.bun/bin/bun run src/server.ts
Restart=on-failure
TimeoutStopSec=900
KillMode=mixed
```

systemd reads the key files as root and hands the process what is inside, so the `pod` account cannot
read a key it was not given. Stopping is given fifteen minutes because each process lets a writing or
a grading under way finish before it goes.

The front door is three lines of Caddy:

```
vps-39a35c60.vps.ovh.us {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
```

## Changing what runs

```
sudo -iu pod git -C /opt/pod pull --ff-only
sudo -iu pod bash -lc 'cd /opt/pod && bun install --frozen-lockfile'
sudo systemctl restart pod-server pod-worker
```

The host runs what is on GitHub and nothing else, so a change reaches it by being pushed.

## After it is up

```
bun run src/audit.ts https://<the host>
```

It opens the wall as a stranger would and fails on a dead link, a page with a hole in it, or a verdict
with no receipt to check it by. It asks each job only for what that job says it has: one still
running, or closed with no verdict, owes no receipt. Save the output; on submission day it goes
beside the entry.

Then the real check, which every job page prints in full for its own job:

```
bun run src/repeat.ts https://<the host>/job/<id> ./the-code-at-that-commit
```

It checks the receipt's signature, holds the code against the tree the receipt names, runs the
published checks in boxes of its own, and says whether this machine reached the same verdict. On 5
October it was run on the host against a job the host had never graded, from public addresses only,
and agreed with a pass and with a failure.

## What is not automated

- **Putting the four secrets on the host.** A person does it, over SSH, from the machine that holds
  them.
- **Accepting a repository.** When a title's holder claims the work, GitHub sends the account they
  named an invitation, and accepting it is theirs to do.
