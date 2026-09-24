/**
 * A browser, driven for real, with nothing installed to do it.
 *
 * Chrome is already on the machine and speaks its debugging protocol over a websocket, which the
 * runtime can open by itself. So the browser layer needs no framework and no install: it starts a
 * headless Chrome, talks to it, and closes it.
 *
 * What this exists to catch is the class of bug that markup assertions cannot see. A string can be
 * in the HTML while the thing it names is unreachable, unclickable, off the side of a phone, or
 * behind a link that goes nowhere. Those are the bugs a person hits first.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LINUX_CHROME = ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];

async function chromePath(): Promise<string | undefined> {
  if (await Bun.file(CHROME).exists()) return CHROME;
  for (const path of LINUX_CHROME) if (await Bun.file(path).exists()) return path;
  return undefined;
}

export async function browserAvailable(): Promise<boolean> {
  return (await chromePath()) !== undefined;
}

interface Waiting {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class Browser {
  private constructor(
    private readonly process: ReturnType<typeof Bun.spawn>,
    private readonly socket: WebSocket,
    private readonly waiting: Map<number, Waiting>,
  ) {}

  private static nextId = 1;

  /** Start a headless Chrome and attach to its first page. */
  static async start(): Promise<Browser> {
    const path = await chromePath();
    if (!path) throw new Error("no Chrome on this machine to drive");

    // a profile directory, in a temporary place. The first version of this put it in the repository,
    // which is how you end up committing a browser profile
    const profile = await mkdtemp(join(tmpdir(), "pod-chrome-"));
    const process = Bun.spawn([
      path,
      "--headless=new",
      // port 0: Chrome picks one that is free and writes it into the profile, so two runs never collide
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      `--user-data-dir=${profile}`,
      "about:blank",
    ], { stdout: "ignore", stderr: "pipe" });

    // the debugging port takes a moment; ask until it answers rather than sleeping a guess
    let target: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 100 && !target; i++) {
      try {
        const port = (await Bun.file(join(profile, "DevToolsActivePort")).text()).split("\n")[0];
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as
          { type: string; webSocketDebuggerUrl: string }[];
        target = pages.find((page) => page.type === "page");
      } catch { /* not up yet: no port written, or not answering */ }
      if (!target) await Bun.sleep(100);
    }
    if (!target) {
      const said = await new Response(process.stderr as ReadableStream).text();
      process.kill();
      throw new Error(`Chrome never opened its debugging port. It said: ${said.slice(0, 400)}`);
    }

    const waiting = new Map<number, Waiting>();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("could not attach to Chrome")), { once: true });
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id === undefined) return;
      const pending = waiting.get(message.id);
      if (!pending) return;
      waiting.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });

    return new Browser(process, socket, waiting);
  }

  /** One protocol call. Every one of them can fail, and failing loudly is the point. */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = Browser.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.delete(id)) reject(new Error(`${method} never answered`));
      }, 30_000);
    });
  }

  /** Open a page and wait until it has actually loaded, not until the call returned. */
  async open(url: string): Promise<void> {
    await this.send("Page.enable");
    await this.send("Page.navigate", { url });
    for (let i = 0; i < 100; i++) {
      const state = await this.evaluate<string>("document.readyState");
      if (state === "complete") return;
      await Bun.sleep(50);
    }
    throw new Error(`${url} never finished loading`);
  }

  /**
   * Run a script in every page before the page's own code, for as long as this browser lives.
   *
   * It is how a wallet is put into a page for a test: the page cannot tell it apart from one an
   * extension injected, which is the point.
   */
  async beforeEveryPage(source: string): Promise<void> {
    await this.send("Page.enable");
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source });
  }

  /** Type into a field the way a keyboard would, rather than setting its value behind the page's back. */
  async type(selector: string, text: string): Promise<void> {
    await this.evaluate(`(() => {
      const field = document.querySelector(${JSON.stringify(selector)});
      field.focus();
      field.select?.();
    })()`);
    await this.send("Input.insertText", { text });
  }

  /** Wait until something is true on the page, and say what the page showed if it never is. */
  async until(expression: string, what: string, seconds = 60, show?: string): Promise<void> {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(`Boolean(${expression})`)) return;
      await Bun.sleep(150);
    }
    // the part of the page that explains the wait, if the caller knows where that is
    const shown = show
      ? await this.evaluate<string>(`String(${show})`)
      : (await this.text()).slice(0, 600);
    throw new Error(`waited ${seconds}s for ${what}. The page said: ${shown}`);
  }

  /** Run an expression in the page and hand back what it evaluated to. */
  async evaluate<T>(expression: string): Promise<T> {
    const answer = await this.send<{ result: { value: T }; exceptionDetails?: { text: string } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
    );
    if (answer.exceptionDetails) throw new Error(`the page threw: ${answer.exceptionDetails.text}`);
    return answer.result.value;
  }

  /**
   * Click where a person would click, not where the markup is.
   *
   * It asks the page what is at that point first: clicking coordinates that are covered by something
   * else is exactly the bug this layer exists to catch, and a click that lands on the wrong element
   * should fail rather than quietly do nothing.
   */
  async clickAt(x: number, y: number): Promise<void> {
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await this.send("Input.dispatchMouseEvent", {
        type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0,
      });
    }
  }

  /**
   * The middle of something, after scrolling it into view.
   *
   * A click is dispatched at viewport coordinates, so an element below the fold has to be brought
   * into the viewport first or the click lands on whatever happens to be there instead. The first
   * version of this did not, and two tests failed for a reason that had nothing to do with the page.
   */
  async centreOf(selector: string): Promise<{ x: number; y: number }> {
    const box = await this.evaluate<{ x: number; y: number; covered: string | null } | null>(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      element.scrollIntoView({ block: "center", behavior: "instant" });
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const at = document.elementFromPoint(x, y);
      const covered = at && (at === element || element.contains(at) || at.contains(element))
        ? null
        : (at ? at.tagName + "." + (at.className || "") : "nothing");
      return { x, y, covered };
    })()`);
    if (!box) throw new Error(`nothing matches ${selector}`);
    if (box.covered) throw new Error(`${selector} is covered by ${box.covered}, so a person could not click it`);
    return box;
  }

  /** Click a thing by what it is, rather than by where it happened to be. */
  async click(selector: string): Promise<void> {
    const { x, y } = await this.centreOf(selector);
    await this.clickAt(x, y);
  }

  /** A point inside an element but away from its middle, for testing that a whole row is a target. */
  async cornerOf(selector: string): Promise<{ x: number; y: number }> {
    const box = await this.evaluate<{ x: number; y: number } | null>(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      element.scrollIntoView({ block: "center", behavior: "instant" });
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.bottom - 6 };
    })()`);
    if (!box) throw new Error(`nothing matches ${selector}`);
    return box;
  }

  /** What the page thinks it is showing, as a person would read it. */
  text(): Promise<string> {
    return this.evaluate<string>("document.body.innerText");
  }

  where(): Promise<string> {
    return this.evaluate<string>("location.pathname + location.search");
  }

  /** Resize the viewport, which is how phone width is tested rather than guessed at. */
  async resize(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: width < 500,
    });
  }

  async screenshot(path: string): Promise<void> {
    const shot = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    await Bun.write(path, Buffer.from(shot.data, "base64"));
  }

  async stop(): Promise<void> {
    try { this.socket.close(); } catch { /* already gone */ }
    this.process.kill();
    await this.process.exited;
  }
}
