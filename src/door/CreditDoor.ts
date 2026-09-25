/**
 * Where an agent's owner links a GitHub account to the agent, and where anybody reads the link.
 *
 *   POST /api/credit            { gist }   the gist's address or id; the gist is read from GitHub and checked
 *   GET  /api/credit/<address>             the link, with the gist and the signature that make it
 *
 * Nobody signs in here. The gist is the account's say-so and the signature in it is the agent's, and
 * a newer gist for the same agent takes the place of the older one.
 */
import { isAddress } from "viem";
import { z } from "zod";
import { bodyWithin, tooLarge } from "../body.ts";
import { creditEmail, gistIdFrom, linkIn, readGist } from "../credit.ts";
import { firstLine } from "../errors.ts";
import { NO_STORE } from "../headers.ts";
import { ROUTES } from "../routes.ts";
import type { CreditBook } from "./CreditBook.ts";
import { PerMinute } from "./Doorkeeper.ts";

/**
 * How many gists are read from GitHub a minute, from everybody together. GitHub answers a server that
 * does not sign in 60 times an hour; this keeps a flood of asking from spending that on nothing.
 */
export const GISTS_READ_A_MINUTE = 10;
/** A gist's address, and room to spare */
const MOST_A_LINK_REQUEST_MAY_WEIGH = 2_000;

const AskedSchema = z.object({ gist: z.string() });

export class CreditDoor {
  private readonly reads = new PerMinute(GISTS_READ_A_MINUTE);

  constructor(private readonly options: { readonly book: CreditBook }) {}

  async handle(request: Request): Promise<Response> {
    const rest = new URL(request.url).pathname.slice(ROUTES.credit.length);
    if (request.method === "GET") {
      const agent = rest.replace(/^\//, "");
      if (!isAddress(agent)) return Response.json({ why: "ask for an agent by its address" }, { status: 404 });
      const link = await this.options.book.of(agent);
      if (!link) return Response.json({ why: "that agent's work is credited to no GitHub account" }, { status: 404, headers: NO_STORE });
      return Response.json({ link, email: creditEmail(link) }, { headers: NO_STORE });
    }
    if (request.method !== "POST" || rest !== "") {
      return Response.json({ why: "a link is made with POST, and read with GET and the agent's address" }, { status: 405 });
    }

    const body = await bodyWithin(request, MOST_A_LINK_REQUEST_MAY_WEIGH);
    if (body === undefined) return tooLarge("a link is made by naming a gist, and nothing more");
    let asked: unknown;
    try {
      asked = JSON.parse(body);
    } catch {
      return Response.json({ why: "send { \"gist\": \"<its address>\" }" }, { status: 400 });
    }
    const parsed = AskedSchema.safeParse(asked);
    const gistId = parsed.success ? gistIdFrom(parsed.data.gist) : undefined;
    if (!gistId) return Response.json({ why: "name the gist by its address on gist.github.com, or its id" }, { status: 400 });
    if (!this.reads.allow("github")) {
      return Response.json({ why: "gists are being read as fast as GitHub allows. Try again in a minute" }, { status: 429 });
    }

    let gist: unknown;
    try {
      gist = await readGist(gistId);
    } catch (error) {
      return Response.json({ why: firstLine(error) }, { status: 502 });
    }
    const checked = await linkIn(gist);
    if (!checked.ok) return Response.json({ why: checked.why }, { status: 400 });
    await this.options.book.save(checked.link);
    return Response.json({ link: checked.link, email: creditEmail(checked.link) }, { status: 201 });
  }
}
