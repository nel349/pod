import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { creditEmail, gistIdFrom, linkIn, readGist, SIGNED } from "../credit.ts";
import { CreditBook, CreditDoor } from "../door/index.ts";
import { creditMessage } from "../messages.ts";
import { creditPath, ROUTES } from "../routes.ts";

/**
 * Linking a GitHub account to an agent, checked against a gist exactly as GitHub describes one.
 *
 * The gist here is a real one, read from GitHub as the server reads it: octocat's first, which has
 * nothing to do with us, so it links nobody. For the rest, the same gist has its file replaced with a
 * sentence signed here, which is the one thing a test cannot ask octocat to publish: the shape, the
 * owner and the address stay GitHub's own.
 */

const OCTOCATS_GIST = "6cad326836d38bd3a7ae";
const OCTOCAT = { login: "octocat", githubId: 583231 };

let real: Record<string, unknown>;
beforeAll(async () => {
  const read = await readGist(OCTOCATS_GIST);
  if (typeof read !== "object" || read === null) throw new Error("GitHub described no gist");
  real = { ...read };
});

const agent = privateKeyToAccount(generatePrivateKey());
const someoneElse = privateKeyToAccount(generatePrivateKey());

/** octocat's own gist, with one file holding what is given */
function holding(content: string, changes: Record<string, unknown> = {}): unknown {
  return { ...real, files: { "pod.txt": { filename: "pod.txt", content, truncated: false } }, ...changes };
}

async function signedBy(key: typeof agent, named = OCTOCAT, forAgent = agent.address): Promise<string> {
  const sentence = creditMessage({ agent: forAgent, ...named });
  return `${sentence}\n${SIGNED}${await key.signMessage({ message: sentence })}\n`;
}

describe("a GitHub account linked to an agent", () => {
  test("a gist that holds no sentence links nobody", async () => {
    expect(await linkIn(real)).toEqual({ ok: false, why: expect.stringContaining("holds no sentence") });
  });

  test("the account that owns the gist, named in a sentence the agent signed, is linked", async () => {
    const checked = await linkIn(holding(`Linking my agent.\n\n${await signedBy(agent)}`));
    if (!checked.ok) throw new Error(checked.why);
    expect(checked.link).toMatchObject({ agent: agent.address, login: "octocat", githubId: 583231 });
    expect(checked.link.gist).toStartWith("https://gist.github.com/");
    expect(creditEmail(checked.link)).toBe("583231+octocat@users.noreply.github.com");
  });

  test("a sentence naming another account than the gist's owner is refused", async () => {
    const checked = await linkIn(holding(await signedBy(agent, { login: "someone", githubId: 42 })));
    expect(checked).toEqual({ ok: false, why: expect.stringContaining("the gist belongs to octocat") });
    // the same name with another number is somebody who took the name later
    const renamed = await linkIn(holding(await signedBy(agent, { login: "octocat", githubId: 42 })));
    expect(renamed.ok).toBe(false);
  });

  test("a signature from any key but the agent's is refused", async () => {
    const checked = await linkIn(holding(await signedBy(someoneElse)));
    expect(checked).toEqual({ ok: false, why: expect.stringContaining("not from the agent the sentence names") });
  });

  test("a secret gist is refused: a link is for anybody to check", async () => {
    expect(await linkIn(holding(await signedBy(agent), { public: false }))).toEqual({ ok: false, why: expect.stringContaining("secret") });
  });

  test("a gist is named by its address or its id, and nothing else", () => {
    expect(gistIdFrom(OCTOCATS_GIST)).toBe(OCTOCATS_GIST);
    expect(gistIdFrom(`https://gist.github.com/octocat/${OCTOCATS_GIST}`)).toBe(OCTOCATS_GIST);
    for (const not of [`http://gist.github.com/octocat/${OCTOCATS_GIST}`, `https://evil.example/${OCTOCATS_GIST}`, "../../etc", ""]) {
      expect(gistIdFrom(not)).toBeUndefined();
    }
  });
});

describe("the credit door", () => {
  test("a gist that links nobody is refused with the reason, and nothing is kept", async () => {
    const book = new CreditBook(await mkdtemp(join(tmpdir(), "pod-credit-")));
    const door = new CreditDoor({ book });
    const asked = await door.handle(new Request(`http://pod.test${ROUTES.credit}`, { method: "POST", body: JSON.stringify({ gist: `https://gist.github.com/octocat/${OCTOCATS_GIST}` }) }));
    expect(asked.status).toBe(400);
    expect(((await asked.json()) as { why: string }).why).toContain("holds no sentence");
    expect((await door.handle(new Request(`http://pod.test${creditPath(agent.address)}`))).status).toBe(404);
  });

  test("a link that was made is read back by anybody, with the proof and the address commits use", async () => {
    const book = new CreditBook(await mkdtemp(join(tmpdir(), "pod-credit-")));
    const checked = await linkIn(holding(await signedBy(agent)));
    if (!checked.ok) throw new Error(checked.why);
    await book.save(checked.link);
    const read = await new CreditDoor({ book }).handle(new Request(`http://pod.test${creditPath(agent.address)}`));
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ link: checked.link, email: "583231+octocat@users.noreply.github.com" });
  });

  test("a gist named badly is refused before GitHub is asked", async () => {
    const door = new CreditDoor({ book: new CreditBook(await mkdtemp(join(tmpdir(), "pod-credit-"))) });
    const asked = await door.handle(new Request(`http://pod.test${ROUTES.credit}`, { method: "POST", body: JSON.stringify({ gist: "https://evil.example/x" }) }));
    expect(asked.status).toBe(400);
  });
});
