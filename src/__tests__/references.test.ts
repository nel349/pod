import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fetchReference, isPublicAddress, linksIn, type FetchOptions, ReferenceLinksSchema, ReferenceRefused, referenceName } from "../references/index.ts";

/**
 * A reference is a request this server makes for a stranger. These hold it to going only where a
 * stranger could go, and to keeping only what is safe to hand back from POD's own address. The files
 * come from a real server on a real port, which a test may ask and nobody else's link may.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const TEXT = "# What I want\n\nSix cards, two to a row on a phone.\n";
const asked: string[] = [];
const serving: ReturnType<typeof Bun.serve> = Bun.serve({
  port: 0,
  fetch(request): Response {
    const { pathname } = new URL(request.url);
    asked.push(pathname);
    switch (pathname) {
      case "/sketch.png": return new Response(PNG, { headers: { "content-type": "image/png" } });
      case "/named-as-text.png": return new Response(PNG, { headers: { "content-type": "text/plain" } });
      case "/spec.md": return new Response(TEXT, { headers: { "content-type": "text/markdown; charset=utf-8" } });
      case "/page": return new Response("<!doctype html><title>a page</title>", { headers: { "content-type": "text/html" } });
      case "/drawing.svg": return new Response("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", { headers: { "content-type": "image/svg+xml" } });
      case "/program.js": return new Response("alert(1)", { headers: { "content-type": "text/javascript" } });
      case "/not-text": return new Response(new Uint8Array([0xff, 0xfe, 0x00, 0xc3]), { headers: { "content-type": "text/plain" } });
      case "/heavy.png": return new Response(new Uint8Array(4096).fill(7), { headers: { "content-type": "image/png" } });
      case "/private": return new Response("sign in", { status: 401 });
      case "/gone": return new Response("no", { status: 404 });
      case "/empty": return new Response(null, { headers: { "content-type": "text/plain" } });
      case "/moved": return Response.redirect(`http://127.0.0.1:${serving.port}/sketch.png`, 302);
      case "/to-figma": return Response.redirect("https://www.figma.com/file/abc", 302);
      case "/round": return Response.redirect(`http://127.0.0.1:${serving.port}/round`, 302);
      default: return new Response("nothing", { status: 404 });
    }
  },
});
afterAll(() => { void serving.stop(true); });

const at = (path: string): string => `http://127.0.0.1:${serving.port}${path}`;
/** as a test asks: its own stand-in on this machine, and nothing else */
const here: FetchOptions = { mayAsk: (address) => address === "127.0.0.1" };
const refusal = async (link: string, options: FetchOptions = here): Promise<string> =>
  fetchReference(link, options).then(() => "kept", (error: unknown) => (error instanceof ReferenceRefused ? error.message : `threw otherwise: ${String(error)}`));

describe("fetching a reference a poster gave", () => {
  test("a picture and a text file are kept, by what their own bytes say, with a fingerprint anybody can hold them against", async () => {
    const picture = await fetchReference(at("/sketch.png"), here);
    expect(picture.type).toBe("image/png");
    expect(picture.bytes).toEqual(PNG);
    expect(picture.digest).toBe(`0x${createHash("sha256").update(PNG).digest("hex")}`);

    const text = await fetchReference(at("/spec.md"), here);
    expect(text.type).toBe("text/markdown");
    expect(new TextDecoder().decode(text.bytes)).toBe(TEXT);
    // a picture served under the wrong name is kept as the picture it is, never as text
    expect((await fetchReference(at("/named-as-text.png"), here)).type).toBe("image/png");
    // and a link that moved is followed to where it went
    expect((await fetchReference(at("/moved"), here)).type).toBe("image/png");
  });

  test("what is not a file POD keeps is refused in words the poster can act on", async () => {
    expect(await refusal(at("/page"))).toContain("opens a web page, not a file");
    expect(await refusal(at("/drawing.svg"))).toContain("an SVG can carry a program");
    expect(await refusal(at("/program.js"))).toContain("POD keeps pictures");
    expect(await refusal(at("/not-text"))).toBe("that was served as text and is not text");
    expect(await refusal(at("/private"))).toContain("needs signing in");
    expect(await refusal(at("/gone"))).toBe("that link answered 404, not a file");
    expect(await refusal(at("/empty"))).toBe("that link answered with an empty file");
    expect(await refusal(at("/heavy.png"), { ...here, largestBytes: 1024 })).toContain("the most a reference may be");
    expect(await refusal(at("/round"))).toContain("more times than POD follows");
  });

  test("Figma and its like are refused before anything is asked, and so is a link that leads there", async () => {
    const before = asked.length;
    expect(await refusal("https://www.figma.com/design/abc/My-file")).toContain("Export the frame as an image");
    expect(await refusal("https://docs.google.com/document/d/abc")).toContain("needs signing in");
    expect(asked.length).toBe(before);
    expect(await refusal(at("/to-figma"))).toContain("Export the frame as an image");
  });

  test("it goes only where a stranger could: never this machine, a private network, or the address a cloud keeps its secrets at", async () => {
    // with nothing said about who may be asked, this machine's own stand-in is refused, by address and by name
    expect(await refusal(`https://127.0.0.1:${serving.port}/sketch.png`, {})).toContain("not a public one");
    expect(await refusal(`https://localhost:${serving.port}/sketch.png`, {})).toContain("not a public one");
    expect(await refusal("https://169.254.169.254/latest/meta-data/", {})).toContain("not a public one");
    expect(await refusal("https://[::1]/x", {})).toContain("not a public one");
    expect(await refusal("http://example.com/a.png", {})).toContain("starts with https://");
    // a public link that sends on to this machine is refused at the stop it is sent to
    const sendsHome: FetchOptions = { mayAsk: (address) => address === "127.0.0.1" && asked.at(-1) !== "/moved" };
    expect(await refusal(at("/moved"), sendsHome)).toContain("not a public one");

    for (const inside of ["10.0.0.5", "172.16.3.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1"]) {
      expect(isPublicAddress(inside), inside).toBe(false);
    }
    for (const outside of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "15.204.88.134", "2604:2dc0:202:300::196c", "::ffff:8.8.8.8"]) {
      expect(isPublicAddress(outside), outside).toBe(true);
    }
  });

  test("the links a poster types are a few public https addresses, one to a line, none twice", () => {
    expect(linksIn(" https://a.example/x.png \n\n https://b.example/y.pdf\n")).toEqual(["https://a.example/x.png", "https://b.example/y.pdf"]);
    expect(ReferenceLinksSchema.safeParse(["https://a.example/x.png"]).success).toBe(true);
    const why = (links: readonly string[]): string => ReferenceLinksSchema.safeParse(links).error?.issues[0]?.message ?? "";
    expect(why(["not a link"])).toContain("a reference is a link");
    expect(why(["ftp://a.example/x.png"])).toContain("a reference is a link");
    expect(why(["https://a.example/x.png", "https://a.example/x.png"])).toBe("the same link is given twice");
    expect(why(Array.from({ length: 6 }, (_, at) => `https://a.example/${at}.png`))).toBe("at most 5 references");
    expect(referenceName(2, "image/jpeg")).toBe("reference-2.jpg");
  });
});
