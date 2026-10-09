import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { TriedCheck } from "../checkwriting/written.ts";
import type { AgentKeyActions, AgentKeyView } from "../web/site/pages/agents/AgentKey.tsx";

/**
 * The pages' pieces, rendered on their own: the posting page's, and the sheet that makes an agent's key.
 *
 * The browser tests drive whole pages against a real chain; these are the behaviours of one piece
 * that only show when it renders: what a screen reader hears, what a failed trial says, what a sheet
 * offers in a state the real path passes through too quickly to look at, and that a page which breaks
 * says so rather than going blank.
 *
 * A DOM is registered for this file alone, so no other test runs with a fake window it did not ask
 * for, and every test that needs one lives here. A second such file cannot work beside this one: React
 * binds its scheduler to the first window it meets, which is closed by the time the other file runs,
 * and which file runs first is not ours to choose.
 */

// the DOM has to exist before React Testing Library loads: it binds `screen` to `document` at import
GlobalRegistrator.register();
// React keeps some work for after a render; it is flushed before the DOM goes, or it runs without one
afterAll(async () => {
  const { act } = await import("react");
  await act(async () => {});
  await GlobalRegistrator.unregister();
});

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { PayStep, ShardSeal, WrittenCheck } = await import("../web/post/components/index.ts");
const { CHROME, ErrorBoundary } = await import("../web/shared/index.ts");
const { AgentKey } = await import("../web/site/pages/agents/AgentKey.tsx");
const { SITE } = await import("../web/site/copy.ts");
const { COPY, progressOf, SHARDS } = await import("../web/post/state/index.ts");

afterEach(() => cleanup());

const MARKET = {
  chainId: 31337, chainName: "a local chain", rpc: "http://127.0.0.1:8545",
  jobs: "0x0000000000000000000000000000000000000001" as const, explorer: "http://explorer.invalid", coin: "MON",
};

const SHAKY: TriedCheck = {
  checkable: true, says: "When it is dry, it tells me I do not need one", secret: true,
  asks: "Asks while it is dry", expects: "No coat needed", nearMiss: "It always says take a coat.",
  file: "check-2.mjs", source: "process.exit(0);",
  proof: { working: true, nearMiss: false, nothing: true },
  saw: { working: "dry said no coat", nearMiss: "fine", nothing: "404" },
};

describe("a written check", () => {
  test("a failed trial says what went wrong and what the check printed; a passed one says only that it passed", () => {
    render(<ul><WrittenCheck check={SHAKY} /></ul>);
    const trials = screen.getAllByRole("listitem").filter((item) => item.classList.contains("trial"));
    expect(trials.map((item) => item.className)).toEqual(["trial held", "trial broke", "trial held"]);
    expect(trials[1]?.textContent).toBe(`Let a near miss through: it always says take a coat. ${COPY.checks.trials.saw("fine")}`);
    expect(trials[0]?.textContent).toBe(COPY.checks.trials.working.held);
  });

  test("a check whose near miss failed another line too is still proven, and says which line under the trial", () => {
    const other = "When it is raining, it tells me to take one";
    render(<ul><WrittenCheck check={{ ...SHAKY, proof: { working: true, nearMiss: true, nothing: true }, nearMissAlsoBroke: [other] }} /></ul>);
    const [check] = screen.getAllByRole("listitem").filter((item) => item.classList.contains("written-check"));
    expect(check?.className).toBe("written-check");
    const trials = screen.getAllByRole("listitem").filter((item) => item.classList.contains("trial"));
    expect(trials.map((item) => item.className)).toEqual(["trial held", "trial held", "trial held"]);
    expect(trials[1]?.querySelector(".also")?.textContent).toBe(COPY.checks.trials.nearMiss.alsoBroke([other]));
    expect(trials[0]?.querySelector(".also")).toBeNull();
  });

  test("the program itself is there, folded away, for anybody who wants to read it", () => {
    render(<ul><WrittenCheck check={SHAKY} /></ul>);
    const source = screen.getByText(COPY.checks.showSource).closest("details");
    expect(source?.open).toBe(false);
    expect(source?.querySelector("code")?.textContent).toBe("process.exit(0);");
  });
});

describe("paying", () => {
  test("each step of the payment is read aloud with its state, not only drawn as a mark", () => {
    render(
      <PayStep
        market={MARKET}
        payment={{
          price: 100_000_000_000_000_000n, mode: "flash", hasWallet: true, sealed: undefined,
          status: { kind: "posting" }, steps: { connect: "done", chain: "doing" }, paid: undefined, isSubmitting: false,
        }}
      />,
    );
    const steps = [...document.querySelectorAll("#progress li")].map((item) => item.textContent);
    expect(steps).toEqual([
      `${COPY.pay.steps.connect}: ${COPY.pay.stepStates.done}`,
      `${COPY.pay.steps.chain("a local chain")}: ${COPY.pay.stepStates.doing}`,
      `${COPY.pay.steps.pay}: ${COPY.pay.stepStates.waiting}`,
      `${COPY.pay.steps.sign}: ${COPY.pay.stepStates.waiting}`,
      `${COPY.pay.steps.publish}: ${COPY.pay.stepStates.waiting}`,
    ]);
  });

  test("while it is posting, the button cannot be pressed a second time", () => {
    render(
      <PayStep
        market={MARKET}
        payment={{ price: 1n, mode: "flash", hasWallet: true, sealed: undefined, status: { kind: "posting" }, steps: {}, paid: undefined, isSubmitting: false }}
      />,
    );
    expect(screen.getByRole("button", { name: COPY.pay.payAndPost("0.000000000000000001 MON") }).hasAttribute("disabled")).toBe(true);
  });

  test("while the form is still being checked, before anything is sent, the button cannot be pressed again", () => {
    render(
      <PayStep
        market={MARKET}
        payment={{ price: 1n, mode: "flash", hasWallet: true, sealed: undefined, status: { kind: "idle" }, steps: {}, paid: undefined, isSubmitting: true }}
      />,
    );
    expect(document.querySelector("#submit")?.hasAttribute("disabled")).toBe(true);
  });
});

describe("after a payment that went through", () => {
  test("if publishing then failed, the button offers to finish the paid job, and says what was paid", async () => {
    const { sealJob } = await import("../web/post/state/index.ts");
    const sealed = await sealJob(
      { idea: "A service that tells me about coats", kind: "service", brief: [], exam: [], price: "0.1", mode: "flash", name: "a-coat" },
      [], "a-salt",
    );
    render(
      <PayStep
        market={MARKET}
        payment={{
          price: 1n, mode: "flash", hasWallet: true, sealed: undefined,
          status: { kind: "stopped", why: "The server said 500.", hasPaid: true }, steps: { pay: "done", publish: "failed" },
          paid: { hash: "0xabc", poster: "0x0000000000000000000000000000000000000001", sealed, onChainId: "7" },
          isSubmitting: false,
        }}
      />,
    );
    const button = document.querySelector("#submit");
    expect(button?.textContent).toBe(COPY.pay.finish);
    expect(button?.hasAttribute("disabled")).toBe(false);
    expect(document.querySelector(".paid-as")?.textContent).toBe(COPY.pay.paidAs("7", "0xabc"));
  });
});

describe("sealing what is on the page", () => {
  test("checks written again for the same request are sealed afresh, not served from the first set", async () => {
    // the bug this guards: the seal was keyed by the request alone, so a second set of checks for the
    // same words was paid for under the first set's seal while the page showed the second
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { renderHook, waitFor } = await import("@testing-library/react");
    const { useSealedJob } = await import("../web/post/hooks/index.ts");
    const { requestKey, toWriteRequest } = await import("../web/post/state/index.ts");
    const form = {
      idea: "A service that tells me whether to take a coat", kind: "service" as const,
      brief: [{ says: "When it is raining, it says take a coat" }], exam: [],
      price: "0.1", mode: "flash" as const, name: "a-coat",
    };
    const tried = (source: string): TriedCheck => ({ ...SHAKY, secret: false, says: form.brief[0]!.says, source, proof: { working: true, nearMiss: true, nothing: true } });
    const key = requestKey(toWriteRequest(form));
    const first = { key, checks: [tried("// the first check")], writtenAt: 1 };
    const second = { key, checks: [tried("// a different check, for the same words")], writtenAt: 2 };

    const client = new QueryClient();
    const { result, rerender, unmount } = renderHook(({ written }) => useSealedJob(form, written, "a-salt"), {
      initialProps: { written: first },
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current.sealed).toBeDefined());
    const firstSeal = result.current.sealed?.seal;

    rerender({ written: second });
    // a new seal, not the moment in between when the second set is being sealed and there is none
    await waitFor(() => {
      expect(result.current.sealed).toBeDefined();
      expect(result.current.sealed?.seal).not.toBe(firstSeal);
    });
    expect(result.current.sealed?.files).toEqual({ "check-2.mjs": "// a different check, for the same words" });

    // leave nothing scheduled behind: React and the query cache both keep work for later
    unmount();
    client.clear();
  });
});

describe("the seal", () => {
  test("exactly the shards of finished steps are placed, and it says how far along it is", () => {
    const progress = progressOf({ form: {}, areChecksReady: true, isPosted: false });
    render(<ShardSeal progress={progress} />);
    const placed = document.querySelectorAll("polygon.placed").length;
    expect(placed).toBe(SHARDS.filter((shard) => shard.piece === "checks").length);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(COPY.sealLabel(1, 6));
  });
});

describe("a page that breaks", () => {
  test("says so in words, and that nothing was sent, instead of going blank", () => {
    function Broken(): never {
      throw new Error("the checks came back in a shape nobody expected");
    }
    // React reports the error it caught to the console; that is expected here, and kept out of the output
    const quiet = console.error;
    console.error = () => {};
    try {
      render(<ErrorBoundary><Broken /></ErrorBoundary>);
    } finally {
      console.error = quiet;
    }
    expect(screen.getByRole("alert").textContent).toBe(CHROME.broken("the checks came back in a shape nobody expected"));
  });
});

const WORDS = SITE.agents.key;
const ADDRESS = "0x9676540a6C2e5eAc3e4B957f3aFA7e70317f524A";
const KEY = `0x${"c3".repeat(32)}`;

const CLOSED: AgentKeyView = { number: 1, coin: "MON", open: undefined, amount: "0.05", canFund: true, isMaking: false, status: { kind: "idle" }, problem: undefined };
const OPEN: AgentKeyView = { ...CLOSED, open: { address: ADDRESS, holds: "0.05 MON", isEmpty: false, shown: undefined } };

/** Every press, counted by its name, so a test says which one was made and that no other was. */
function presses(): { readonly on: AgentKeyActions; readonly made: string[] } {
  const made: string[] = [];
  const press = (name: string) => (): void => { made.push(name); };
  return {
    made,
    on: {
      make: press("make"), another: press("another"), before: press("before"), showKey: press("showKey"), hideKey: press("hideKey"),
      setAmount: (amount) => { made.push(`amount ${amount}`); }, fund: press("fund"), bringBack: press("bringBack"), forget: press("forget"),
    },
  };
}

describe("an agent's key, before the passkey has made it", () => {
  test("says which agent, and offers the one press that makes its key", () => {
    const { on, made } = presses();
    const drawn = render(<AgentKey view={CLOSED} on={on} />);
    expect(drawn.getByText(WORDS.whose(1))).toBeTruthy();
    fireEvent.click(drawn.getByText(WORDS.make));
    expect(made).toEqual(["make"]);
    // the first agent has none before it
    expect(drawn.queryByText(WORDS.before)).toBeNull();
  });

  test("while the passkey is being asked, nothing can be pressed a second time or turned to another agent", () => {
    const { on, made } = presses();
    const drawn = render(<AgentKey view={{ ...CLOSED, number: 2, isMaking: true }} on={on} />);
    for (const words of [WORDS.make, WORDS.another, WORDS.before]) fireEvent.click(drawn.getByText(words));
    expect(made).toEqual([]);
  });

  test("a passkey that gave no key is said in words", () => {
    const drawn = render(<AgentKey view={{ ...CLOSED, problem: "that passkey is not the one the open wallet was made from." }} on={presses().on} />);
    expect(drawn.getByRole("status").textContent).toBe(WORDS.notMade("that passkey is not the one the open wallet was made from"));
  });
});

describe("an agent's key, open on the page", () => {
  test("shows its address and what it holds, and keeps the key out of the page until it is asked for", () => {
    const { on, made } = presses();
    const drawn = render(<AgentKey view={OPEN} on={on} />);
    expect(drawn.getByText(ADDRESS)).toBeTruthy();
    expect(drawn.getByText(WORDS.holds("0.05 MON"))).toBeTruthy();
    expect(drawn.container.innerHTML).not.toContain(KEY);
    fireEvent.click(drawn.getByText(WORDS.showKey));
    expect(made).toEqual(["showKey"]);
  });

  test("asked for, the key is shown with what handing it over means, and can be hidden again", () => {
    const { on, made } = presses();
    const drawn = render(<AgentKey view={{ ...OPEN, open: { address: ADDRESS, holds: "0.05 MON", isEmpty: false, shown: KEY } }} on={on} />);
    expect(drawn.getByText(KEY)).toBeTruthy();
    expect(drawn.getByText(WORDS.keySays)).toBeTruthy();
    fireEvent.click(drawn.getByText(WORDS.hideKey));
    expect(made).toEqual(["hideKey"]);
  });

  test("an amount that cannot be sent is not sent, and an address holding nothing has nothing to bring back", () => {
    const { on, made } = presses();
    const drawn = render(<AgentKey view={{ ...OPEN, canFund: false, open: { address: ADDRESS, holds: "0 MON", isEmpty: true, shown: undefined } }} on={on} />);
    fireEvent.click(drawn.getByText(WORDS.fund));
    fireEvent.click(drawn.getByText(WORDS.back));
    expect(made).toEqual([]);
  });

  test("while money is on its way it says so, and nothing else can be started", () => {
    const { on, made } = presses();
    const drawn = render(<AgentKey view={{ ...OPEN, status: { kind: "working", move: "back" } }} on={on} />);
    expect(drawn.getByRole("status").textContent).toBe(WORDS.working.back);
    for (const words of [WORDS.fund, WORDS.back, WORDS.forget, WORDS.another]) fireEvent.click(drawn.getByText(words));
    expect(made).toEqual([]);
  });

  test("a payment the chain refused says why", () => {
    const drawn = render(<AgentKey view={{ ...OPEN, status: { kind: "stopped", move: "fund", why: "this wallet holds 0 MON, and this takes 0.05 MON." } }} on={presses().on} />);
    expect(drawn.getByRole("status").textContent).toBe(WORDS.stopped("this wallet holds 0 MON, and this takes 0.05 MON"));
  });
});
