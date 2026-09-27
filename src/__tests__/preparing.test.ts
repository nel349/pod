import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther, type Account, type Address, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Model } from "../broker.ts";
import type { WriteRequest } from "../checkwriting/index.ts";
import { filesMatchSeal, MODES, sealSpec, type Mode } from "../job.ts";
import { podJobsV2Abi, readJobV2, readWritingMoney, readWritingPrice, WriterKey } from "../jobsV2.ts";
import { preparingMessage, setUpMessage } from "../messages.ts";
import { Preparing, PreparingStore, type PreparingView } from "../preparing/index.ts";
import { openJob } from "../publish.ts";
import { specFromTheWire, SpecOnTheWireSchema } from "../specWire.ts";
import { JobStore } from "../store.ts";
import { handle } from "../server.ts";
import { jobNamePath, preparingPath, preparingWritingsPath, ROUTES } from "../routes.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { COAT_REQUEST, GOOD_REPLY, replying, writerWith } from "./support/coat.ts";
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
    writer = new WriterKey({ address: jobs, publicClient: anvil.publicClient, wallet: anvil.wallet(WRITER) as Wallet });
    wall = new JobStore(await mkdtemp(join(tmpdir(), "pod-wall-")));
  });
  afterAll(() => anvil?.stop());

  const at = () => ({ address: jobs, publicClient: anvil.publicClient });
  const wallet = (key: Hex): Wallet => anvil.wallet(key) as Wallet;

  async function service(model: Model = replying(GOOD_REPLY).model, folder?: string, atOnce = 2): Promise<{ preparing: Preparing; folder: string }> {
    const kept = folder ?? await mkdtemp(join(tmpdir(), "pod-preparing-"));
    const preparing = new Preparing({
      store: new PreparingStore(kept), wall,
      chain: {
        jobs, chainId: 31337,
        job: (id) => readJobV2(at(), id),
        money: (id) => readWritingMoney(at(), id),
        writingPrice: () => readWritingPrice(at()),
      },
      writer, checkWriter: writerWith(model), atOnce, say: (what) => said.push(what),
    });
    return { preparing, folder: kept };
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
