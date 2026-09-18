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
import { tmpdir } from "node:os";

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

    const port = 30000 + Math.floor(Math.random() * 20000);
    const process = Bun.spawn([
      path,
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      // a profile directory, in a temporary place. The first version of this line put it in the
      // repository, which is how you end up committing a browser profile
      `--user-data-dir=${tmpdir()}/pod-chrome-${port}`,
      "about:blank",
    ], { stdout: "ignore", stderr: "pipe" });

    // the debugging port takes a moment; ask until it answers rather than sleeping a guess
    let target: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 100 && !target; i++) {
      try {
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as
          { type: string; webSocketDebuggerUrl: string }[];
        target = pages.find((page) => page.type === "page");
      } catch { /* not up yet */ }
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

  /** The middle of the first thing matching a selector, in page coordinates. */
  async centreOf(selector: string): Promise<{ x: number; y: number }> {
    const box = await this.evaluate<{ x: number; y: number } | null>(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
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
