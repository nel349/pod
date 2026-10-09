import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { AgentKeyActions, AgentKeyView } from "../web/site/pages/agents/AgentKey.tsx";

/**
 * The sheet that makes an agent's key, drawn on its own. The browser test takes it through a real
 * passkey and a real chain; these are what it shows and offers in each state, which that path passes
 * through too quickly to look at: the key stays hidden until asked for, nothing can be pressed twice,
 * and a refusal is said in words.
 */

// the DOM has to exist before React Testing Library loads: it binds `screen` to `document` at import
GlobalRegistrator.register();
afterAll(async () => {
  const { act } = await import("react");
  await act(async () => {});
  await GlobalRegistrator.unregister();
});

// what is drawn is asked of the render itself, not of the library's `screen`: that is bound to whichever
// document existed when the library was first loaded, which is another test file's when both run together
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { AgentKey } = await import("../web/site/pages/agents/AgentKey.tsx");
const { SITE } = await import("../web/site/copy.ts");

afterEach(() => cleanup());

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
