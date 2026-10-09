import { afterEach, describe, expect, test } from "bun:test";
import { commitToApprove } from "../../plugins/mm/src/candidate.ts";
import { startPassThrough, type PassThrough } from "../../plugins/mm/src/passThrough.ts";
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { Pod, PodDidNotAnswer, withASeatToTake } from "../../plugins/mm/src/pod.ts";
import { whyTheContractRefused } from "../../plugins/mm/src/refusal.ts";
import { ListedJobSchema, type ListedJob } from "../door/JobList.ts";
import { podJobsAbi } from "../jobs.ts";
import { jobApiPath, ROUTES } from "../routes.ts";

/**
 * The plugin for MetaMask's agent wallet, as far as it can be held to account without that wallet:
 * which commit a seat may approve, the stand-in that passes the tool's questions to the chain's own
 * endpoint, and reading POD through its public doors. Each talks to a real server on a real port,
 * standing in for the chain or for POD; what MetaMask does with a request is tried against MetaMask.
 */

const CANDIDATE = "1cede02ebf88bf81bfcd556351dc6fa8bdb74a5d";
const ANOTHER = "9f2c4e1a7b3d5f6071829304a5b6c7d8e9f0a1b2";

describe("which commit a seat may approve", () => {
  test("the lead names the candidate, and may name a new one", () => {
    expect(commitToApprove("lead", CANDIDATE, undefined)).toEqual({ ok: true, commit: CANDIDATE });
    expect(commitToApprove("lead", ANOTHER, CANDIDATE)).toEqual({ ok: true, commit: ANOTHER });
    // told nothing, the lead approves the candidate there is
    expect(commitToApprove("lead", undefined, CANDIDATE)).toEqual({ ok: true, commit: CANDIDATE });
  });

  test("every other seat approves the candidate the chain holds, told nothing or told the same", () => {
    for (const role of ["reviewer", "qa", "security"] as const) {
      expect(commitToApprove(role, undefined, CANDIDATE)).toEqual({ ok: true, commit: CANDIDATE });
      expect(commitToApprove(role, CANDIDATE.toUpperCase(), CANDIDATE)).toEqual({ ok: true, commit: CANDIDATE });
    }
  });

  test("no seat but the lead can approve another commit, which would clear the pod's approvals", () => {
    for (const role of ["reviewer", "qa", "security"] as const) {
      const refused = commitToApprove(role, ANOTHER, CANDIDATE);
      expect(refused).toMatchObject({ ok: false, code: "NOT_THE_CANDIDATE" });
      if (!refused.ok) expect(refused.why).toContain(CANDIDATE);
    }
  });

  test("with no candidate there is nothing to approve until the lead names one", () => {
    expect(commitToApprove("reviewer", undefined, undefined)).toMatchObject({ ok: false, code: "NO_CANDIDATE" });
    expect(commitToApprove("reviewer", CANDIDATE, undefined)).toMatchObject({ ok: false, code: "NO_CANDIDATE" });
    expect(commitToApprove("lead", undefined, undefined)).toMatchObject({ ok: false, code: "NO_CANDIDATE" });
  });

  test("the builder never approves, and a short commit id is not a commit", () => {
    expect(commitToApprove("builder", CANDIDATE, CANDIDATE)).toMatchObject({ ok: false, code: "BUILDERS_DO_NOT_APPROVE" });
    expect(commitToApprove("lead", "1cede02", undefined)).toMatchObject({ ok: false, code: "NOT_A_COMMIT" });
    expect(commitToApprove("reviewer", "not-a-commit", CANDIDATE)).toMatchObject({ ok: false, code: "NOT_A_COMMIT" });
  });
});

describe("the chain's endpoint, standing in for MetaMask's chain-reading service", () => {
  let standIn: PassThrough | undefined;
  let chain: ReturnType<typeof Bun.serve> | undefined;
  afterEach(async () => {
    await standIn?.stop();
    chain?.stop(true);
    standIn = undefined;
    chain = undefined;
  });

  /** A chain's endpoint that writes down what it was asked and what came with it. */
  function aChain(): { readonly rpc: string; readonly asked: { body: string; signIn: string | null; path: string }[] } {
    const asked: { body: string; signIn: string | null; path: string }[] = [];
    chain = Bun.serve({
      port: 0,
      async fetch(request) {
        asked.push({ body: await request.text(), signIn: request.headers.get("authorization"), path: new URL(request.url).pathname });
        return Response.json({ jsonrpc: "2.0", id: 1, result: "0x10" });
      },
    });
    return { rpc: `http://127.0.0.1:${chain.port}`, asked };
  }

  test("a question is passed on as it was asked and answered as the chain answered, and the tool's sign-in goes no further", async () => {
    const { rpc, asked } = aChain();
    standIn = await startPassThrough(rpc);
    const question = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: ["0xfe44ab93e065a097231f6481246a2f938a3beae7", "latest"] });
    // asked the way the tool asks: at an address ending in the chain's number and a project's id, signed in
    const answer = await fetch(`${standIn.base}/10143/a-project-id`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer the-tools-own-token" }, body: question });
    expect(await answer.json()).toEqual({ jsonrpc: "2.0", id: 1, result: "0x10" });
    expect(asked).toEqual([{ body: question, signIn: null, path: "/" }]);
  });

  test("it listens on this machine only, and anything that is not a question never reaches the chain", async () => {
    const { rpc, asked } = aChain();
    standIn = await startPassThrough(rpc);
    expect(new URL(standIn.base).hostname).toBe("127.0.0.1");
    expect((await fetch(standIn.base)).status).toBe(200);
    expect(asked).toEqual([]);
  });

  test("a chain that cannot be reached is said so, not left hanging", async () => {
    standIn = await startPassThrough("http://127.0.0.1:1");
    const answer = await fetch(standIn.base, { method: "POST", body: "{}" });
    expect(answer.status).toBe(502);
    expect(JSON.stringify(await answer.json())).toContain("could not be reached");
  });

  test("once stopped, nothing listens there any more", async () => {
    const { rpc } = aChain();
    const stopped = await startPassThrough(rpc);
    await stopped.stop();
    expect(fetch(stopped.base, { method: "POST", body: "{}" })).rejects.toThrow();
  });
});

describe("POD, read through its public doors", () => {
  let site: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => {
    site?.stop(true);
    site = undefined;
  });

  const JOBS = "0xc831b6e4414E064F7713A3b6017be4a1Eb9F5E9b";

  /** A site that answers the three addresses a seat reads, and takes notes. */
  function aSite(): { readonly pod: Pod; readonly notes: unknown[] } {
    const notes: unknown[] = [];
    site = Bun.serve({
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === ROUTES.market) return Response.json({ chainId: 10143, chainName: "Monad testnet", rpc: "https://testnet-rpc.monad.xyz", explorer: "https://testnet.monadscan.com", coin: "MON", jobs: JOBS });
        if (pathname === ROUTES.jobList) return Response.json({ version: 1, guide: ROUTES.guide, market: ROUTES.market, jobs: [] });
        if (pathname === jobApiPath("a-to-do-list")) return Response.json({ jobId: "a-to-do-list", idea: "A to-do list", chain: { jobId: "18", jobs: JOBS.toLowerCase() } });
        if (pathname === `${ROUTES.notes}a-to-do-list` && request.method === "POST") {
          const note = await request.json();
          if (typeof note === "object" && note !== null && "says" in note && note.says === "refuse me") return Response.json({ why: "that key holds no seat on this job" }, { status: 403 });
          notes.push(note);
          return new Response(null, { status: 201 });
        }
        return new Response("not here", { status: 404 });
      },
    });
    return { pod: new Pod(`http://127.0.0.1:${site.port}`), notes };
  }

  test("the chain and the contract are the site's to say, and the open jobs are read as a list", async () => {
    const { pod } = aSite();
    const market = await pod.market();
    expect(market.chainId).toBe(10143);
    expect(market.jobs).toBe(JOBS);
    expect(await pod.openJobs()).toEqual([]);
  });

  test("a job is found by its name once it has left the open list, with its number and its contract as addresses are written", async () => {
    const { pod } = aSite();
    expect(await pod.job("a-to-do-list")).toEqual({ jobId: "a-to-do-list", onChainId: 18n, jobs: JOBS });
  });

  test("a job the site does not have is said so by name, as that and not as a failure to reach it", async () => {
    const { pod } = aSite();
    const refused = await pod.job("nowhere").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PodDidNotAnswer);
    expect(refused).toMatchObject({ problem: "NO_SUCH_JOB", message: `${pod.site} has no job called "nowhere"` });
  });

  test("a site that cannot be reached is named, and said to be unreachable", async () => {
    const nowhere = new Pod("http://127.0.0.1:1");
    const refused = await nowhere.market().catch((error: unknown) => error);
    expect(refused).toMatchObject({ problem: "POD_UNREACHABLE" });
    expect(String(refused)).toContain("http://127.0.0.1:1 could not be reached");
  });

  test("a note is handed over as it was signed, and a refusal comes back in the site's own words", async () => {
    const { pod, notes } = aSite();
    const note = { agent: "0xfe44ab93e065a097231f6481246a2f938a3beae7", role: "reviewer", says: "It does what was asked.", at: 1, signature: "0x00" };
    await pod.writeNote("a-to-do-list", note);
    expect(notes).toEqual([note]);
    const refused = await pod.writeNote("a-to-do-list", { ...note, says: "refuse me" }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ problem: "POD_SAID_NO", message: "the note was not taken: that key holds no seat on this job" });
  });

  test("a job whose seats are all taken is not offered as one to take a seat on", () => {
    const listed = (jobId: string, free: ListedJob["free"]): ListedJob => ListedJobSchema.parse({
      jobId, at: { page: `/job/${jobId}`, git: `/git/${jobId}.git`, notes: `/api/notes/${jobId}` },
      contract: { address: JOBS, jobId: "18" }, price: "100000000000000000", endsAt: "2026-10-10T11:42:31.000Z",
      idea: "A to-do list", mode: "sprint", allowedHosts: [], visibleChecks: [], sealedChecks: 4, seats: [], owners: [], free,
    });
    expect(withASeatToTake([listed("full", []), listed("one-left", ["reviewer"])]).map((job) => job.jobId)).toEqual(["one-left"]);
  });
});

describe("why the contract said no", () => {
  /** The refusal as it reaches a caller: the contract's own error, inside the library's account of the call. */
  const refusedWith = (errorName: "TooLate" | "NotTheSeat" | "WrongDeposit"): BaseError => {
    const reverted = new ContractFunctionRevertedError({ abi: podJobsAbi, data: encodeErrorResult({ abi: podJobsAbi, errorName }), functionName: "approve" });
    return new ContractFunctionExecutionError(reverted, { abi: podJobsAbi, functionName: "approve", args: [18n, 2, `0x${"00".repeat(32)}`] });
  };

  test("it is said in the contract's own word, which is what tells a seat what to do next", () => {
    expect(whyTheContractRefused(refusedWith("TooLate"))).toBe("the contract says TooLate");
    expect(whyTheContractRefused(refusedWith("NotTheSeat"))).toBe("the contract says NotTheSeat");
    expect(whyTheContractRefused(refusedWith("WrongDeposit"))).toBe("the contract says WrongDeposit");
  });

  test("anything else is one line, with no full stop left on the end for a sentence to double", () => {
    expect(whyTheContractRefused(new Error("the node could not be reached.\nmore that nobody needs"))).toBe("the node could not be reached");
    expect(whyTheContractRefused("no")).toBe("no");
  });
});
