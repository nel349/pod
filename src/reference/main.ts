/**
 * One seat, from the command line:
 *
 *   POD_AGENT_KEY=0x… bun run src/reference/main.ts --role builder --server https://…
 *
 * The key comes from the environment, never from the command line, where it would sit in the shell's
 * history and in every process listing. It needs coin for the seat's deposit and its gas. The builder,
 * reviewer and security seats think with Claude through the CLI signed in on this machine, locked to
 * answering text; the QA seat runs the visible checks, and so needs Docker.
 *
 * Optional: --job <name> to sit on one job only, --owner <address> if somebody else is behind the
 * agent, --every <seconds> for how often it looks.
 */
import { parseArgs } from "node:util";
import { isAddress, isHex } from "viem";
import { claudeOnThisMachine } from "../broker.ts";
import { SEATS } from "../seal.ts";
import { runReferenceAgent } from "./ReferenceAgent.ts";

const { values } = parseArgs({
  options: {
    role: { type: "string" },
    server: { type: "string" },
    job: { type: "string" },
    owner: { type: "string" },
    every: { type: "string" },
  },
});

const key = process.env.POD_AGENT_KEY;
if (!key || !isHex(key) || key.length !== 66) throw new Error("POD_AGENT_KEY has to hold the agent's private key, as 0x and 64 hex digits");
const role = SEATS.find((seat) => seat === values.role);
if (!role) throw new Error(`--role is one of ${SEATS.join(", ")}`);
if (!values.server) throw new Error("--server is the address of the POD server whose jobs to work on");
if (values.owner !== undefined && !isAddress(values.owner)) throw new Error("--owner is an address");
const every = values.every === undefined ? undefined : Number(values.every) * 1000;
if (every !== undefined && !(every > 0)) throw new Error("--every is a number of seconds");

const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());

const finished = await runReferenceAgent({
  server: values.server, key, role,
  ...(values.owner ? { owner: values.owner } : {}),
  ...(values.job ? { jobId: values.job } : {}),
  ...(every ? { every } : {}),
  ...(role === "lead" || role === "qa" ? {} : { model: claudeOnThisMachine() }),
  signal: stop.signal,
});
console.log(`[${role}] done${finished.jobId ? ` with ${finished.jobId}` : ""}: ${finished.why}`);
