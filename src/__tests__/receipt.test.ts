import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { fingerprintTree, receiptHash, signReceipt, verifyReceipt, type Receipt } from "../receipt.ts";

const KEY = `0x${"7".repeat(64)}` as const;
const runner = privateKeyToAccount(KEY).address;

const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  version: "pod.receipt.v1",
  seal: `0x${"ab".repeat(32)}`,
  commit: "c0ffee1",
  tree: `0x${"cd".repeat(32)}`,
  image: "node@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944",
  checks: [
    { says: "the page loads", command: "curl -fs $TARGET", exitCode: 0, seconds: 0.4, hidden: false },
    { says: "a weak excuse scores under 3", command: "node checks/weak.js", exitCode: 0, seconds: 1.1, hidden: true },
  ],
  runs: 3,
  verdict: "passed",
  allowedHosts: [],
  undeclaredCalls: [],
  runner,
  finishedAt: "2026-10-01T12:00:00.000Z",
  ...over,
});

describe("the receipt's hash", () => {
  test("the same receipt always hashes the same", () => {
    expect(receiptHash(receipt())).toBe(receiptHash(receipt()));
  });

  test("changing anything changes the hash", () => {
    const before = receiptHash(receipt());
    expect(receiptHash(receipt({ verdict: "failed" }))).not.toBe(before);
    expect(receiptHash(receipt({ runs: 2 }))).not.toBe(before);
    expect(receiptHash(receipt({ commit: "c0ffee2" }))).not.toBe(before);
  });

  test("a check's exit code is part of it", () => {
    const changed = receipt();
    const checks = [{ ...changed.checks[0]!, exitCode: 1 }, changed.checks[1]!];
    expect(receiptHash({ ...changed, checks })).not.toBe(receiptHash(changed));
  });
});

describe("signing", () => {
  test("a signed receipt verifies", async () => {
    expect(await verifyReceipt(await signReceipt(receipt(), KEY))).toBe(true);
  });

  test("an edited receipt does not", async () => {
    const signed = await signReceipt(receipt(), KEY);
    const tampered = { ...signed, receipt: { ...signed.receipt, verdict: "passed" as const, runs: 1 } };
    expect(await verifyReceipt(tampered)).toBe(false);
  });

  test("a receipt cannot be signed on another runner's behalf", async () => {
    const other = `0x${"8".repeat(64)}` as const;
    await expect(signReceipt(receipt(), other)).rejects.toThrow("signed by the runner it names");
  });

  test("a signature from the wrong key is caught even when the hash is right", async () => {
    const signed = await signReceipt(receipt(), KEY);
    const impostor = privateKeyToAccount(`0x${"8".repeat(64)}`);
    const forged = {
      ...signed,
      signature: await impostor.signMessage({ message: signed.hash }),
    };
    expect(await verifyReceipt(forged)).toBe(false);
  });
});

describe("fingerprinting the tree that was graded", () => {
  async function tree(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "pod-tree-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "index.js"), "console.log(1)\n");
    await writeFile(join(root, "readme.md"), "hello\n");
    return root;
  }

  test("the same tree fingerprints the same", async () => {
    const root = await tree();
    expect(await fingerprintTree(root)).toBe(await fingerprintTree(root));
  });

  test("changed contents change the fingerprint", async () => {
    const root = await tree();
    const before = await fingerprintTree(root);
    await writeFile(join(root, "src", "index.js"), "console.log(2)\n");
    expect(await fingerprintTree(root)).not.toBe(before);
  });

  test("a moved file is a different tree, even with the same contents", async () => {
    const root = await tree();
    const before = await fingerprintTree(root);
    await rename(join(root, "src", "index.js"), join(root, "src", "main.js"));
    expect(await fingerprintTree(root)).not.toBe(before);
  });

  test("what gets rebuilt is left out, so an install does not change the fingerprint", async () => {
    const root = await tree();
    const before = await fingerprintTree(root);
    await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1\n");
    expect(await fingerprintTree(root)).toBe(before);
  });
});
