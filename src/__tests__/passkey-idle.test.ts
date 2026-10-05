import { describe, expect, test } from "bun:test";
import { lockWhenIdle } from "../web/shared/wallet/useLockPasskeyWhenIdle.ts";

/**
 * A passkey wallet left open with nobody at the page is locked, so a tab left open is not a wallet left
 * open; somebody at the page keeps it open. The page's own events are stood in for by an event target,
 * the same interface the window gives.
 */

const IDLE_MS = 120;

describe("a passkey wallet nobody is using", () => {
  test("is locked once nobody has touched the page for a while", async () => {
    let locked = 0;
    const stop = lockWhenIdle({ idleMs: IDLE_MS, at: new EventTarget(), lock: () => { locked++; } });
    await Bun.sleep(IDLE_MS * 2);
    expect(locked).toBe(1);
    stop();
  });

  test("stays open while somebody is at the page, and locks once they leave", async () => {
    let locked = 0;
    const page = new EventTarget();
    const stop = lockWhenIdle({ idleMs: IDLE_MS, at: page, lock: () => { locked++; } });
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(IDLE_MS / 2);
      page.dispatchEvent(new Event("pointerdown"));
    }
    expect(locked).toBe(0);
    await Bun.sleep(IDLE_MS * 2);
    expect(locked).toBe(1);
    stop();
  });

  test("stops watching when told, and never locks after", async () => {
    let locked = 0;
    const stop = lockWhenIdle({ idleMs: IDLE_MS, at: new EventTarget(), lock: () => { locked++; } });
    stop();
    await Bun.sleep(IDLE_MS * 2);
    expect(locked).toBe(0);
  });
});
