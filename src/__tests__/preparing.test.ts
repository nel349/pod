import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestClient, http, parseEther, type Account, type Address, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Model } from "../broker.ts";
import type { WriteRequest } from "../checkwriting/index.ts";
import { filesMatchSeal, MODES, sealSpec, type Mode } from "../job.ts";
import { podJobsV2Abi, readJobV2, readWritingMoney, readWritingPrice, WriterKey } from "../jobsV2.ts";
import { preparingMessage, setUpMessage } from "../messages.ts";
import { Preparing, PreparingStore, type PreparingChain, type PreparingView, type Writer } from "../preparing/index.ts";
import { openJob } from "../publish.ts";
import { specFromTheWire, SpecOnTheWireSchema } from "../specWire.ts";
import { JobStore } from "../store.ts";
import { handle } from "../server.ts";
import { jobNamePath, preparingPath, preparingWritingsPath, ROUTES } from "../routes.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { COAT_REQUEST, GOOD_REPLY, good, replying, WORKING, writerWith } from "./support/coat.ts";
import { dockerAvailable } from "./support/tools.ts";

/**
 * A paid job, prepared: set up by its poster, its checks written only once the money for each writing
 * is set aside on the chain, and approved on the chain with the writer's signature.
 *
 * Everything is real but the model: the contract on a local chain, the writer program and the trials
 * in their boxes. The model answers from a script, as it does in every test of check writing.
 */
const available = (await anvilAvailable()) && (await dockerAvailable());

const [DEPLOYER, VALIDATOR, WRITER, POSTER, STRANGER] = ANVIL_KEYS;
const WRITING = parseEther("0.05");
const PRICE = parseEther("1");
const SALT = "0123456789abcdef0123456789abcdef";
/** a model that cannot be reached, as when the machine it runs on is signed out */
const UNREACHABLE: Model = async () => { throw new Error("the model would not answer: not signed in"); };
/** a model that answers, but never with anything the writer can use */
const USELESS = replying("I would be happy to help with that!").model;

type Wallet = WalletClient & { account: Account };

describe.skipIf(!available)("a paid job, prepared", () => {
  let anvil: Anvil;
  let jobs: Address;
  let writer: WriterKey;
  let wall: JobStore;
  const said: string[] = [];

  beforeAll(async () => {
    anvil = await startAnvil();
    jobs = await anvil.deploy("PodJobsV2", [
      privateKeyToAccount(VALIDATOR).address, privateKeyToAccount(WRITER).address, 10n, WRITING, 100_000n,
    ], DEPLOYER);
    writer = new WriterKey({ address: jobs, publicClient: anvil.publicClient, wallet: anvil.wallet(WRITER) });
    wall = new JobStore(await mkdtemp(join(tmpdir(), "pod-wall-")));
  });
  afterAll(() => anvil?.stop());

  const at = () => ({ address: jobs, publicClient: anvil.publicClient });
  const wallet = (key: Hex): Wallet => anvil.wallet(key);

  const realChain = (): PreparingChain => ({
    jobs,
    job: (id) => readJobV2(at(), id),
    money: (id) => readWritingMoney(at(), id),
    writingPrice: () => readWritingPrice(at()),
  });

  async function serviceWith(options: { model?: Model; folder?: string; atOnce?: number; chain?: PreparingChain; writer?: Writer } = {}) {
    const kept = options.folder ?? await mkdtemp(join(tmpdir(), "pod-preparing-"));
    const preparing = new Preparing({
      store: new PreparingStore(kept), wall, chain: options.chain ?? realChain(),
      writer: options.writer ?? writer, checkWriter: writerWith(options.model ?? replying(GOOD_REPLY).model),
      atOnce: options.atOnce ?? 2, tryAgainAfterMs: 200, say: (what) => said.push(what),
    });
    return { preparing, folder: kept };
  }

  async function service(model: Model = replying(GOOD_REPLY).model, folder?: string, atOnce = 2): Promise<{ preparing: Preparing; folder: string }> {
    return serviceWith({ model, ...(folder ? { folder } : {}), atOnce });
  }

  /** Waits until the job's writing is neither waiting nor under way, however many tries that takes. */
  async function whenWritten(preparing: Preparing, onChainId: bigint): Promise<PreparingView> {
    for (let i = 0; i < 600; i++) {
      await preparing.whenIdle();
      const read = await view(preparing, onChainId);
      if (read.now.kind === "idle" && read.asked === undefined) return read;
      await Bun.sleep(100);
    }
    throw new Error(`job ${onChainId}'s writing never finished`);
  }

  async function aPaidJob(mode: Mode = "flash", by: Hex = POSTER): Promise<bigint> {
    const payer = wallet(by);
    const { request, result } = await anvil.publicClient.simulateContract({
      address: jobs, abi: podJobsV2Abi, functionName: "post", args: [BigInt(MODES[mode].windowMinutes * 60), 1],
      value: PRICE + 3n * WRITING, account: payer.account,
    });
    await anvil.publicClient.waitForTransactionReceipt({ hash: await payer.writeContract(request) });
    return result;
  }

  async function asPoster(onChainId: bigint, name: string, options: { by?: Hex; claims?: Hex; mode?: Mode; request?: WriteRequest } = {}) {
    const signer = wallet(options.by ?? POSTER);
    const mode = options.mode ?? "flash";
    const signature = await signer.signMessage({ account: signer.account, message: setUpMessage({ jobs, onChainId: `${onChainId}`, name, mode, salt: SALT }) });
    return {
      onChainId: `${onChainId}`, name, mode, salt: SALT, request: options.request ?? COAT_REQUEST,
      poster: privateKeyToAccount(options.claims ?? options.by ?? POSTER).address, signature,
    };
  }

  async function statement(onChainId: bigint, options: { by?: Hex; seconds?: number } = {}): Promise<string> {
    const signer = wallet(options.by ?? POSTER);
    const until = Math.floor(Date.now() / 1000) + (options.seconds ?? 600);
    const signature = await signer.signMessage({ account: signer.account, message: preparingMessage({ jobs, onChainId: `${onChainId}`, until }) });
    return `Basic ${btoa(`${signer.account.address}:${until}.${signature}`)}`;
  }

  async function view(preparing: Preparing, onChainId: bigint): Promise<PreparingView> {
    const read = await preparing.read(`${onChainId}`, await statement(onChainId));
    if (!read.ok) throw new Error(`the poster could not read job ${onChainId}: ${read.why}`);
    return read.value;
  }

  const uniqueName = (): string => `a-coat-${crypto.randomUUID().slice(0, 8)}`;

  test("a job set up by its poster has its checks written, paid for writing by writing, and the poster can approve them", async () => {
    const { preparing } = await service();
    const id = await aPaidJob();
    const validatorBefore = await anvil.publicClient.getBalance({ address: privateKeyToAccount(VALIDATOR).address });

    expect(await preparing.setUp(await asPoster(id, uniqueName()))).toMatchObject({ ok: true });
    await preparing.whenIdle();

    const read = await view(preparing, id);
    const [first] = read.writings;
    expect(first?.isCharged).toBe(true);
    expect(first?.outcome.kind === "written" && first.outcome.ready).toBe(true);
    expect(read.money).toMatchObject({ balance: 2n * WRITING, reserved: 0n, kept: 1 });
    expect(await anvil.publicClient.getBalance({ address: privateKeyToAccount(VALIDATOR).address })).toBe(validatorBefore + WRITING);

    // what the poster approves is the whole spec, sealed as the page will seal it again, with its files
    const approval = first?.outcome.kind === "written" ? first.outcome.approval : undefined;
    if (!approval) throw new Error("a ready set came back with nothing to approve");
    const spec = specFromTheWire(SpecOnTheWireSchema.parse(approval.spec));
    expect(await sealSpec(spec)).toBe(approval.seal);
    expect(spec.price).toBe(PRICE);
    expect(spec.salt).toBe(SALT);
    expect(spec.checks.map((check) => check.hidden)).toEqual([false, true]);
    expect((await filesMatchSeal(spec, approval.files)).ok).toBe(true);

    const poster = wallet(POSTER);
    const { request } = await anvil.publicClient.simulateContract({
      address: jobs, abi: podJobsV2Abi, functionName: "approveChecks", args: [id, approval.seal, approval.signature], account: poster.account,
    });
    await anvil.publicClient.waitForTransactionReceipt({ hash: await poster.writeContract(request) });
    expect((await readJobV2(at(), id))?.state).toBe("open");
  }, 300_000);

  test("nobody but the poster can set a job up, and the chain has to agree with what they say", async () => {
    const { preparing } = await service(UNREACHABLE);
    const id = await aPaidJob();
    const name = uniqueName();

    expect(await preparing.setUp(await asPoster(id, name, { by: STRANGER, claims: POSTER }))).toMatchObject({ ok: false, status: 401 });
    expect(await preparing.setUp(await asPoster(id, name, { by: STRANGER }))).toMatchObject({ ok: false, status: 403 });
    expect(await preparing.setUp(await asPoster(id, name, { mode: "sprint" }))).toMatchObject({ ok: false, status: 409 });
    expect(await preparing.setUp(await asPoster(9999n, name))).toMatchObject({ ok: false, status: 404 });
    expect(await preparing.setUp(await asPoster(id, "Not A Name"))).toMatchObject({ ok: false, status: 400 });
    expect(await preparing.isNameTaken(name)).toBe(false);
  }, 120_000);

  test("a name is one job's: taken on the wall or by another job being prepared, it is refused", async () => {
    const { preparing } = await service(UNREACHABLE);
    const onTheWall = uniqueName();
    await wall.save(await openJob(wall, {
      jobId: onTheWall, seal: `0x${"0".repeat(64)}`, endsAt: new Date(Date.now() + 3_600_000), seats: [],
      spec: { idea: "somebody else's", mode: "flash", price: PRICE, checks: [], allowed: [], salt: SALT },
    }));
    expect(await preparing.setUp(await asPoster(await aPaidJob(), onTheWall))).toMatchObject({ ok: false, status: 409 });

    const name = uniqueName();
    expect(await preparing.setUp(await asPoster(await aPaidJob(), name))).toMatchObject({ ok: true });
    expect(await preparing.setUp(await asPoster(await aPaidJob(), name))).toMatchObject({ ok: false, status: 409 });
    expect(await preparing.isNameTaken(name)).toBe(true);
    await preparing.whenIdle();
  }, 180_000);

  async function takeBack(id: bigint, by: Hex = POSTER): Promise<void> {
    const payer = wallet(by);
    const { request } = await anvil.publicClient.simulateContract({ address: jobs, abi: podJobsV2Abi, functionName: "takeBack", args: [id], account: payer.account });
    await anvil.publicClient.waitForTransactionReceipt({ hash: await payer.writeContract(request) });
  }

  test("a name held by a job taken back before approval is free again, for anybody's next job", async () => {
    const { preparing, folder } = await service(UNREACHABLE);
    const name = uniqueName();
    const first = await aPaidJob();
    expect(await preparing.setUp(await asPoster(first, name))).toMatchObject({ ok: true });
    await preparing.whenIdle();
    expect(await preparing.isNameTaken(name)).toBe(true);

    await takeBack(first);
    expect(await preparing.isNameTaken(name)).toBe(false);
    expect(await (await handle(new Request(`http://pod.test${jobNamePath(name)}`), wall, { preparing })).json()).toEqual({ taken: false });

    const second = await aPaidJob("flash", STRANGER);
    expect(await preparing.setUp(await asPoster(second, name, { by: STRANGER }))).toMatchObject({ ok: true });
    await preparing.whenIdle();
    expect(await preparing.isNameTaken(name)).toBe(true);
    // the first job's files are kept under its number, and the name it gave up is kept aside
    expect((await new PreparingStore(folder).readSetUp(`${first}`))?.name).toBe(name);
    expect(await new PreparingStore(folder).nameHolder(name)).toBe(`${second}`);
  }, 180_000);

  test("a job taken back after its checks were approved keeps its name", async () => {
    const { preparing } = await service();
    const name = uniqueName();
    const id = await aPaidJob();
    await preparing.setUp(await asPoster(id, name));
    const [written] = (await whenWritten(preparing, id)).writings;
    const approval = written?.outcome.kind === "written" ? written.outcome.approval : undefined;
    if (!approval) throw new Error("a ready set came back with nothing to approve");
    const poster = wallet(POSTER);
    const { request } = await anvil.publicClient.simulateContract({
      address: jobs, abi: podJobsV2Abi, functionName: "approveChecks", args: [id, approval.seal, approval.signature], account: poster.account,
    });
    await anvil.publicClient.waitForTransactionReceipt({ hash: await poster.writeContract(request) });
    await takeBack(id);

    expect(await preparing.isNameTaken(name)).toBe(true);
    expect(await preparing.setUp(await asPoster(await aPaidJob("flash", STRANGER), name, { by: STRANGER }))).toMatchObject({ ok: false, status: 409 });
  }, 300_000);

  test("two jobs claiming a freed name at the same moment: one has it, the other is told it is taken", async () => {
    const { preparing } = await service(UNREACHABLE);
    const name = uniqueName();
    const first = await aPaidJob();
    await preparing.setUp(await asPoster(first, name));
    await preparing.whenIdle();
    await takeBack(first);

    // paid one after the other: paid at once, both would be told the same next number
    const a = await aPaidJob();
    const b = await aPaidJob("flash", STRANGER);
    const answers = await Promise.all([
      preparing.setUp(await asPoster(a, name)),
      preparing.setUp(await asPoster(b, name, { by: STRANGER })),
    ]);
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    expect(answers.find((answer) => !answer.ok)).toMatchObject({ status: 409 });
    await preparing.whenIdle();
  }, 180_000);

  test("asked again the same way, a set up answers the same; asked differently, it is refused", async () => {
    const { preparing } = await service(UNREACHABLE);
    const id = await aPaidJob();
    const name = uniqueName();
    const asked = await asPoster(id, name);
    expect(await preparing.setUp(asked)).toMatchObject({ ok: true });
    expect(await preparing.setUp(asked)).toEqual({ ok: true, value: { onChainId: `${id}`, name } });
    expect(await preparing.setUp(await asPoster(id, uniqueName()))).toMatchObject({ ok: false, status: 409 });
    await preparing.whenIdle();
  }, 120_000);

  test("a writing whose model cannot be reached is not charged: its money goes back to the job", async () => {
    const { preparing } = await service(UNREACHABLE);
    const id = await aPaidJob();
    await preparing.setUp(await asPoster(id, uniqueName()));
    await preparing.whenIdle();

    const read = await view(preparing, id);
    expect(read.writings[0]).toMatchObject({ isCharged: false, isSettled: true, outcome: { kind: "failed" } });
    expect(read.money).toMatchObject({ balance: 3n * WRITING, reserved: 0n, kept: 0 });
  }, 120_000);

  test("what the model's answers cost is kept with the writing, written or failed, and with none when it was never reached", async () => {
    // a model that answers as another does, and says what the answer cost, as the real one does
    const billing = (answers: Model): Model => async (prompt, signal, spent) => {
      const answer = await answers(prompt, signal);
      spent?.({ model: "claude-of-some-kind", calls: 1, tokensIn: 1000, tokensOut: 400, dollars: 0.03 });
      return answer;
    };
    const written = await service(billing(replying(GOOD_REPLY).model));
    const first = await aPaidJob();
    await written.preparing.setUp(await asPoster(first, uniqueName()));
    expect((await whenWritten(written.preparing, first)).writings[0]).toMatchObject({
      isCharged: true, outcome: { kind: "written" },
      spent: { model: "claude-of-some-kind", calls: 1, tokensIn: 1000, tokensOut: 400, dollars: 0.03 },
    });

    // two useless answers cost two answers: the writing failed, and what it cost is what its price has to cover
    const failed = await service(billing(USELESS));
    const second = await aPaidJob();
    await failed.preparing.setUp(await asPoster(second, uniqueName()));
    expect((await whenWritten(failed.preparing, second)).writings[0]).toMatchObject({
      isCharged: true, outcome: { kind: "failed" }, spent: { calls: 2, dollars: 0.06 },
    });

    const unreached = await service(UNREACHABLE);
    const third = await aPaidJob();
    await unreached.preparing.setUp(await asPoster(third, uniqueName()));
    expect((await whenWritten(unreached.preparing, third)).writings[0]?.spent).toBeUndefined();
  }, 240_000);

  test("three writings are paid for with the job; the fourth needs one more paid for", async () => {
    const { preparing } = await service(USELESS);
    const id = await aPaidJob();
    await preparing.setUp(await asPoster(id, uniqueName()));
    await preparing.whenIdle();
    for (let i = 0; i < 2; i++) {
      expect(await preparing.write(`${id}`, await statement(id), COAT_REQUEST)).toMatchObject({ ok: true });
      await preparing.whenIdle();
    }
    const read = await view(preparing, id);
    expect(read.writings.map((writing) => writing.isCharged)).toEqual([true, true, true]);
    expect(read.money).toMatchObject({ balance: 0n, kept: 3 });

    expect(await preparing.write(`${id}`, await statement(id), COAT_REQUEST)).toMatchObject({ ok: false, status: 402 });
    const poster = wallet(POSTER);
    const { request } = await anvil.publicClient.simulateContract({
      address: jobs, abi: podJobsV2Abi, functionName: "topUp", args: [id], value: WRITING, account: poster.account,
    });
    await anvil.publicClient.waitForTransactionReceipt({ hash: await poster.writeContract(request) });
    expect(await preparing.write(`${id}`, await statement(id), COAT_REQUEST)).toMatchObject({ ok: true });
    await preparing.whenIdle();
    expect((await view(preparing, id)).money).toMatchObject({ balance: 0n, kept: 4 });
  }, 300_000);

  test("only its poster reads and writes a job being prepared, with a statement good now", async () => {
    const { preparing } = await service(UNREACHABLE);
    const id = await aPaidJob();
    await preparing.setUp(await asPoster(id, uniqueName()));
    await preparing.whenIdle();

    expect(await preparing.read(`${id}`, null)).toMatchObject({ ok: false, status: 401 });
    expect(await preparing.read(`${id}`, await statement(id, { by: STRANGER }))).toMatchObject({ ok: false, status: 403 });
    expect(await preparing.read(`${id}`, await statement(id, { seconds: -10 }))).toMatchObject({ ok: false, status: 403 });
    expect(await preparing.read(`${id}`, await statement(id, { seconds: 2 * 3600 }))).toMatchObject({ ok: false, status: 403 });
    expect(await preparing.write(`${id}`, await statement(id, { by: STRANGER }), COAT_REQUEST)).toMatchObject({ ok: false, status: 403 });
    expect(await preparing.read(`${id}`, await statement(id))).toMatchObject({ ok: true });
  }, 120_000);

  test("one writing at a time: asked again while one waits or runs, it is refused", async () => {
    let letGo = (): void => {};
    const held = new Promise<void>((resolve) => { letGo = resolve; });
    const { preparing } = await service(async () => { await held; throw new Error("the model would not answer"); });
    const id = await aPaidJob();
    await preparing.setUp(await asPoster(id, uniqueName()));
    expect(await preparing.write(`${id}`, await statement(id), COAT_REQUEST)).toMatchObject({ ok: false, status: 409 });
    letGo();
    await preparing.whenIdle();
  }, 120_000);

  test("two asks for another writing at the same moment are one writing, and the other is told so", async () => {
    const { preparing } = await service(UNREACHABLE);
    const id = await aPaidJob();
    await preparing.setUp(await asPoster(id, uniqueName()));
    await preparing.whenIdle();
    const answers = await Promise.all([
      preparing.write(`${id}`, await statement(id), COAT_REQUEST),
      preparing.write(`${id}`, await statement(id), COAT_REQUEST),
    ]);
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    expect(answers.find((answer) => !answer.ok)).toMatchObject({ status: 409 });
    await preparing.whenIdle();
  }, 120_000);

  test("a paid job waits its turn, and is told where it is in the queue", async () => {
    let letGo = (): void => {};
    const held = new Promise<void>((resolve) => { letGo = resolve; });
    const { preparing } = await service(async () => { await held; throw new Error("the model would not answer"); }, undefined, 1);
    const first = await aPaidJob();
    const second = await aPaidJob();
    await preparing.setUp(await asPoster(first, uniqueName()));
    await preparing.setUp(await asPoster(second, uniqueName()));

    expect((await view(preparing, second)).now).toEqual({ kind: "waiting", place: 1 });
    expect((await view(preparing, first)).now.kind).not.toBe("waiting");
    letGo();
    await preparing.whenIdle();
    expect((await view(preparing, second)).now).toEqual({ kind: "idle" });
  }, 180_000);

  test("nothing is written for a job taken back while it waited its turn", async () => {
    let letGo = (): void => {};
    const held = new Promise<void>((resolve) => { letGo = resolve; });
    const { preparing, folder } = await service(async () => { await held; throw new Error("the model would not answer"); }, undefined, 1);
    const first = await aPaidJob();
    const second = await aPaidJob();
    await preparing.setUp(await asPoster(first, uniqueName()));
    await preparing.setUp(await asPoster(second, uniqueName()));

    const poster = wallet(POSTER);
    const { request } = await anvil.publicClient.simulateContract({
      address: jobs, abi: podJobsV2Abi, functionName: "takeBack", args: [second], account: poster.account,
    });
    await anvil.publicClient.waitForTransactionReceipt({ hash: await poster.writeContract(request) });
    letGo();
    await preparing.whenIdle();

    expect(await new PreparingStore(folder).writings(`${second}`)).toEqual([]);
    expect(await new PreparingStore(folder).readAsked(`${second}`)).toBeUndefined();
    expect(await readWritingMoney(at(), second)).toEqual({ balance: 0n, reserved: 0n, kept: 0 });
  }, 180_000);

  test("through the server: set up after paying, read with the poster's statement, written again; and the name is taken", async () => {
    const { preparing } = await service(UNREACHABLE);
    const id = await aPaidJob();
    const name = uniqueName();
    const ask = (path: string, init: RequestInit = {}) => handle(new Request(`http://pod.test${path}`, init), wall, { preparing });

    const setUp = await ask(ROUTES.preparing, { method: "POST", body: JSON.stringify(await asPoster(id, name)) });
    expect(setUp.status).toBe(201);
    expect(await setUp.json()).toEqual({ onChainId: `${id}`, name, url: preparingPath(`${id}`) });
    await preparing.whenIdle();

    expect(await (await ask(jobNamePath(name))).json()).toEqual({ taken: true });
    expect((await ask(preparingPath(`${id}`))).status).toBe(401);
    const read = await ask(preparingPath(`${id}`), { headers: { authorization: await statement(id) } });
    expect(read.status).toBe(200);
    const shown = await read.json() as { name: string; money: { balance: string; writingPrice: string }; writings: unknown[] };
    expect(shown).toMatchObject({ name, money: { balance: `${3n * WRITING}`, writingPrice: `${WRITING}` } });
    expect(shown.writings).toHaveLength(1);

    const again = await ask(preparingWritingsPath(`${id}`), {
      method: "POST", headers: { authorization: await statement(id) }, body: JSON.stringify(COAT_REQUEST),
    });
    expect(again.status).toBe(202);
    await preparing.whenIdle();
    expect((await ask(`${ROUTES.preparing}/${id}/elsewhere`)).status).toBe(404);
    expect((await ask(ROUTES.preparing, { method: "POST", body: "not json" })).status).toBe(400);
  }, 180_000);

  test("a chain that fails once before the writing starts holds nothing up: the writing is tried again, and done", async () => {
    // the real chain, but its first read of the job during the writing fails, as a busy public node's can
    let failuresLeft = 0;
    const chain = realChain();
    const flaky: PreparingChain = { ...chain, job: async (id) => {
      if (failuresLeft > 0) { failuresLeft--; throw new Error("HTTP 429: too many requests"); }
      return chain.job(id);
    } };
    const { preparing } = await serviceWith({ chain: flaky });
    const id = await aPaidJob();
    await preparing.setUp(await asPoster(id, uniqueName()));
    await preparing.whenIdle();
    expect(await preparing.write(`${id}`, await statement(id), COAT_REQUEST)).toMatchObject({ ok: true });
    // the next read of the job is the writing's own, before it sets anything aside
    failuresLeft = 1;

    const read = await whenWritten(preparing, id);
    expect(read.writings).toHaveLength(2);
    expect(read.money.kept).toBe(2);
    expect(said.some((line) => line.includes("HTTP 429"))).toBe(true);
  }, 300_000);

  test("money already set aside that no writing owns is used by the next writing, not stranded", async () => {
    const { preparing } = await service();
    const id = await aPaidJob();
    // as if the reservation landed and the answer to it was lost: set aside, and no writing owns it
    await writer.reserve(id);
    await preparing.setUp(await asPoster(id, uniqueName()));
    const read = await whenWritten(preparing, id);
    expect(read.writings[0]?.isCharged).toBe(true);
    expect(read.money).toMatchObject({ balance: 2n * WRITING, reserved: 0n, kept: 1 });
  }, 300_000);

  test("a reservation that reached the chain while its answer was lost is used by the writing, not stranded", async () => {
    // the real writer key, except that the answer to setting the money aside never comes back
    const answerLost: Writer = {
      reserve: async (id) => { await writer.reserve(id); throw new Error("the connection closed before the receipt came back"); },
      keep: (id) => writer.keep(id), release: (id) => writer.release(id), sign: (id, seal) => writer.sign(id, seal),
    };
    const { preparing } = await serviceWith({ writer: answerLost });
    const id = await aPaidJob();
    await preparing.setUp(await asPoster(id, uniqueName()));
    const read = await whenWritten(preparing, id);
    expect(read.writings[0]).toMatchObject({ isCharged: true, outcome: { kind: "written", ready: true } });
    expect(read.money).toMatchObject({ balance: 2n * WRITING, reserved: 0n, kept: 1 });
  }, 300_000);

  test("a job's number is written one way: with a leading zero it is refused, so one payment cannot hold two names", async () => {
    const { preparing } = await service(UNREACHABLE);
    const id = await aPaidJob();
    expect(await preparing.setUp({ ...(await asPoster(id, uniqueName())), onChainId: `0${id}` })).toMatchObject({ ok: false, status: 400 });
    expect(await preparing.read(`0${id}`, await statement(id))).toMatchObject({ ok: false, status: 400 });
  }, 120_000);

  test("a set with a line that is not proven is charged, and has nothing the writer signed", async () => {
    const taste = { checkable: false, why: "Say what you would see, for example the answer is in large type" };
    const { preparing } = await service(replying({ working: WORKING, checks: [good(0), taste] }).model);
    const id = await aPaidJob();
    await preparing.setUp(await asPoster(id, uniqueName(), { request: { ...COAT_REQUEST, statements: [COAT_REQUEST.statements[0]!, { says: "It looks lovely", secret: true }] } }));
    const [written] = (await whenWritten(preparing, id)).writings;
    expect(written).toMatchObject({ isCharged: true, outcome: { kind: "written", ready: false } });
    expect(written?.outcome.kind === "written" && written.outcome.approval).toBeFalsy();
  }, 300_000);

  test("the price is set aside on the chain before the model is asked a thing", async () => {
    let reservedWhenAsked: bigint | undefined;
    let idBeingWritten = 0n;
    const good = replying(GOOD_REPLY).model;
    const watching: Model = async (prompt, signal) => {
      reservedWhenAsked ??= (await readWritingMoney(at(), idBeingWritten)).reserved;
      return good(prompt, signal);
    };
    const { preparing } = await service(watching);
    idBeingWritten = await aPaidJob();
    await preparing.setUp(await asPoster(idBeingWritten, uniqueName()));
    await whenWritten(preparing, idBeingWritten);
    expect(reservedWhenAsked).toBe(WRITING);
  }, 300_000);

  test("a writing whose price the chain refuses to set aside never reaches the model, and is not charged", async () => {
    const { model, asked } = replying(GOOD_REPLY);
    // a key the contract does not know as its writer: the chain refuses to set anything aside for it
    const notTheWriter = new WriterKey({ address: jobs, publicClient: anvil.publicClient, wallet: wallet(STRANGER) });
    const { preparing } = await serviceWith({ model, writer: notTheWriter });
    const id = await aPaidJob();
    await preparing.setUp(await asPoster(id, uniqueName()));
    const read = await whenWritten(preparing, id);
    expect(read.writings[0]).toMatchObject({ isCharged: false, isSettled: true, outcome: { kind: "failed" } });
    expect(asked()).toBe(0);
    expect(read.money).toMatchObject({ balance: 3n * WRITING, kept: 0 });
  }, 120_000);

  test("checks the model wrote that cannot be signed here are still charged, kept, and say why there is nothing to approve", async () => {
    // the real writer key, except that it cannot sign
    const cannotSign: Writer = {
      reserve: (id) => writer.reserve(id), keep: (id) => writer.keep(id), release: (id) => writer.release(id),
      sign: async () => { throw new Error("the writer key's wallet names no chain"); },
    };
    const { preparing } = await serviceWith({ writer: cannotSign });
    const id = await aPaidJob();
    await preparing.setUp(await asPoster(id, uniqueName()));
    const [written] = (await whenWritten(preparing, id)).writings;
    expect(written).toMatchObject({ isCharged: true, outcome: { kind: "written", ready: true } });
    expect(written?.outcome.kind === "written" && written.outcome.whyNoApproval).toContain("could not be sealed and signed");
    expect(written?.outcome.kind === "written" && written.outcome.approval).toBeFalsy();
  }, 300_000);

  test("a stranger asking over and over cannot stand in the poster's way", async () => {
    const { preparing } = await service(UNREACHABLE);
    const id = await aPaidJob();
    await preparing.setUp(await asPoster(id, uniqueName()));
    await preparing.whenIdle();
    const strangers = Array.from({ length: 20 }, () => preparing.write(`${id}`, null, COAT_REQUEST));
    const [posters] = await Promise.all([preparing.write(`${id}`, await statement(id), COAT_REQUEST), ...strangers]);
    expect(posters).toMatchObject({ ok: true });
    await preparing.whenIdle();
  }, 120_000);

  test("after a restart, jobs are written in the order they were asked", async () => {
    const { preparing, folder } = await service(UNREACHABLE);
    const first = await aPaidJob();
    const second = await aPaidJob();
    await preparing.setUp(await asPoster(first, uniqueName()));
    await preparing.setUp(await asPoster(second, uniqueName()));
    await preparing.whenIdle();
    const store = new PreparingStore(folder);
    await store.ask(`${second}`, { request: COAT_REQUEST, askedAt: "2026-09-27T10:00:00.000Z" });
    await store.ask(`${first}`, { request: COAT_REQUEST, askedAt: "2026-09-27T10:00:05.000Z" });

    let letGo = (): void => {};
    const held = new Promise<void>((resolve) => { letGo = resolve; });
    const { preparing: again } = await serviceWith({ model: async () => { await held; throw new Error("the model would not answer"); }, folder, atOnce: 1 });
    await again.recover();
    expect((await view(again, first)).now).toEqual({ kind: "waiting", place: 1 });
    expect((await view(again, second)).now.kind).not.toBe("waiting");
    letGo();
    await again.whenIdle();
  }, 180_000);

  test("a charged writing whose money the poster released after a day is not charged, and cannot be approved", async () => {
    const { preparing, folder } = await service();
    const id = await aPaidJob();
    await preparing.setUp(await asPoster(id, uniqueName()));
    await whenWritten(preparing, id);
    // as if the price was never kept: set aside again, the writing on disk not yet settled
    const store = new PreparingStore(folder);
    const [written] = await store.writings(`${id}`);
    if (!written) throw new Error("the first writing was never kept");
    await writer.reserve(id);
    await store.saveWriting(`${id}`, { ...written, number: 2, isSettled: false });
    // a day passes, and the poster takes the money back from the writing
    const clock = createTestClient({ mode: "anvil", transport: http(anvil.rpc) });
    await clock.increaseTime({ seconds: 86_400 });
    await clock.mine({ blocks: 1 });
    const poster = wallet(POSTER);
    const { request } = await anvil.publicClient.simulateContract({
      address: jobs, abi: podJobsV2Abi, functionName: "releaseWriting", args: [id], account: poster.account,
    });
    await anvil.publicClient.waitForTransactionReceipt({ hash: await poster.writeContract(request) });

    const { preparing: again } = await service(UNREACHABLE, folder);
    await again.recover();
    const second = (await store.writings(`${id}`)).find((writing) => writing.number === 2);
    expect(second).toMatchObject({ isCharged: false, isSettled: true });
    expect(second?.note).toContain("released by the poster");
    expect(second?.outcome.kind === "written" && second.outcome.approval).toBeFalsy();
  }, 300_000);

  test("a server that stopped after writing, before the price was kept, keeps it when it starts again", async () => {
    const { preparing, folder } = await service(UNREACHABLE);
    const id = await aPaidJob();
    await preparing.setUp(await asPoster(id, uniqueName()));
    await preparing.whenIdle();

    // as if the model had answered and the server stopped before the chain heard of it
    const store = new PreparingStore(folder);
    const [written] = await store.writings(`${id}`);
    if (!written) throw new Error("the first writing was never kept");
    await writer.reserve(id);
    await store.saveWriting(`${id}`, { ...written, isCharged: true, isSettled: false });

    const { preparing: again } = await service(UNREACHABLE, folder);
    // a set whose price is not yet settled is not shown
    expect((await view(again, id)).writings).toEqual([]);
    await again.recover();
    expect(await readWritingMoney(at(), id)).toEqual({ balance: 2n * WRITING, reserved: 0n, kept: 1 });
    expect((await store.writings(`${id}`))[0]?.isSettled).toBe(true);
  }, 120_000);

  test("a server that stopped while writing releases that writing when it starts again, and writes it then", async () => {
    const { preparing, folder } = await service(UNREACHABLE);
    const id = await aPaidJob();
    await preparing.setUp(await asPoster(id, uniqueName()));
    await preparing.whenIdle();

    // as if it had stopped with a writing asked for and its money set aside
    const store = new PreparingStore(folder);
    await store.ask(`${id}`, { request: COAT_REQUEST, askedAt: new Date().toISOString() });
    await writer.reserve(id);

    const { preparing: again } = await service(replying(GOOD_REPLY).model, folder);
    await again.recover();
    await again.whenIdle();
    const read = await view(again, id);
    expect(read.writings.map((writing) => writing.outcome.kind)).toEqual(["failed", "written"]);
    expect(read.money).toMatchObject({ balance: 2n * WRITING, reserved: 0n, kept: 1 });
  }, 300_000);
});
