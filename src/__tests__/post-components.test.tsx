import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { TriedCheck } from "../checkwriting/written.ts";

/**
 * The posting page's pieces, rendered on their own.
 *
 * The browser test drives the whole page against a real chain; these are the behaviours of one piece
 * that only show when it renders: what a screen reader hears, what a failed trial says, and that a
 * page which breaks says so rather than going blank. A DOM is registered for this file alone, so no
 * other test runs with a fake window it did not ask for.
 */

// the DOM has to exist before React Testing Library loads: it binds `screen` to `document` at import
GlobalRegistrator.register();
// React keeps some work for after a render; it is flushed before the DOM goes, or it runs without one
afterAll(async () => {
  const { act } = await import("react");
  await act(async () => {});
  await GlobalRegistrator.unregister();
});

const { cleanup, render, screen } = await import("@testing-library/react");
const { ErrorBoundary, PayStep, ShardSeal, WrittenCheck } = await import("../web/post/components/index.ts");
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
    expect(screen.getByRole("alert").textContent).toBe(COPY.broken("the checks came back in a shape nobody expected"));
  });
});
