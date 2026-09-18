# Putting it somewhere a stranger can reach

Everything here is one command and a decision. Nothing in it is secret: the two things that are, a
deployer key and a validator key, never appear in this repository and never will.

## What has to be decided first

| Decision | Why it cannot be defaulted |
|---|---|
| **The host and the name** | The wall has to be at a URL a judge can open, and the job pages point at themselves |
| **Who holds the validator key** | It is the only address the contracts take a verdict from, and the only one that can mint a title |
| **Where the jobs directory lives** | The server reads it; a container that loses it loses the wall |

The validator key signs receipts as well as transactions, so the address in `POD_VALIDATOR` and the
address the runner signs receipts with should be the same one, or the receipts on the wall will name
somebody the contracts have never heard of.

## The keys

They are generated once and kept in `.env`, which is gitignored and readable only by its owner:

```
cast wallet new --json        # and put the key in .env, never anywhere else
```

`.env` holds `POD_DEPLOYER_KEY`, which pays for the deployment, and `POD_VALIDATOR_ADDRESS` with its
key, which is the only address the contracts take a verdict from and the only one that can mint a
title. Both need testnet MON: the deployer once, the validator for every settlement and every mint.

Nothing reads a key from anywhere else, and no key is ever passed on a command line.

## The contracts

```
./scripts/deploy-testnet.sh
```

It reads `.env`, refuses to run if the deployer has no MON, deploys both contracts to the same
validator, and writes the two addresses back into `.env` so the runner and the README are talking
about the same deployment. Monad testnet is chain 10143.

Public RPC endpoints, all answering on 2026-09-17: `https://testnet-rpc.monad.xyz` (the one in
`.env`), `https://rpc.ankr.com/monad_testnet`, `https://monad-testnet.drpc.org`.

Record the addresses in the README's proof table with an explorer link each.

## The server

```
POD_JOBS=/var/lib/pod/jobs PORT=3000 bun run serve
```

`POD_JOBS` is a directory the runner writes and the server only reads: one directory per job, holding
the record and the checks. It must survive a restart, so on a container platform it is a volume
rather than the image.

Nothing else is configured. There is no database, no API key and no build step.

## After it is up

```
bun run src/audit.ts https://<the host>
```

It opens the wall as a stranger would and fails on a dead link, a page with a hole in it, or a
receipt that cannot be repeated. Save the output; on submission day it goes beside the entry.

Then the real check, from a machine that is not the server:

```
bun run src/repeat.ts https://<the host>/job/<id> ./the-code-at-that-commit
```

If that agrees, the claim at the centre of this project is true in public and not only on a laptop.

## What is not automated

The repository handover. When a job passes, the code is transferred to whoever holds the POD, and
that is a claim they make rather than a push we do. It needs an account that owns the repositories
and a token with rights over it, and neither belongs in this repository.
