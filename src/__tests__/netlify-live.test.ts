import { describe, expect, test } from "bun:test";
import { netlifyFromTheEnvironment, NETLIFY_SETTINGS } from "../hosting/index.ts";

/**
 * A website put live on Netlify itself, once, when somebody asks for it: made in the account the
 * server's token names, opened at its address, and taken down again.
 *
 * It makes a real site in a real account, so it runs only when a person sets the token and says so
 * in POD_NETLIFY_LIVE, and never on CI. Everything short of Netlify saying yes is in netlify.test.ts,
 * which runs everywhere against a stand-in that answers as Netlify's guide says Netlify does.
 */

const ASKED = "POD_NETLIFY_LIVE";
const asked = process.env[ASKED] !== undefined && process.env[NETLIFY_SETTINGS.token] !== undefined && process.env.CI !== "true";
if (!asked) console.log(`  (the website on Netlify itself runs only when ${NETLIFY_SETTINGS.token} and ${ASKED} are set, off CI)`);

const bytes = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(text));

describe.skipIf(!asked)("a website, live on Netlify itself", () => {
  test("it is made, answers at its address with the files it was given, and is taken down", async () => {
    const host = netlifyFromTheEnvironment();
    if (!host) throw new Error("no Netlify token is set");
    const marked = `put live by POD's own test at ${new Date().toISOString()}`;
    const madeFor = `a-live-test:${Date.now().toString(36)}`;
    const name = `pod-live-test-${Date.now().toString(36)}`;
    const live = await host.publish({
      name, madeFor,
      files: new Map([["/index.html", bytes(`<!doctype html><h1>${marked}</h1>`)], ["/cards/mewtwo.html", bytes("<h1>Mewtwo</h1>")]]),
    });
    try {
      console.log(`  live at ${live.url}`);
      expect(live.url).toMatch(/^https:\/\//);
      const front = await fetch(live.url);
      expect(front.status).toBe(200);
      expect(await front.text()).toContain(marked);
      // found with .html left off, as the sealed run serves it
      expect((await fetch(`${live.url}/cards/mewtwo`)).status).toBe(200);
      expect((await fetch(`${live.url}/cards/pikachu`)).status).toBe(404);
      // asked for again under the same name, as after a try that was cut short before it was written down:
      // the site this account already holds is filled, and no second one is made
      const again = await host.publish({ name, madeFor, files: new Map([["/index.html", bytes(`<!doctype html><h1>${marked}, again</h1>`)]]) });
      expect(again.siteId).toBe(live.siteId);
      expect(await (await fetch(live.url)).text()).toContain(`${marked}, again`);
      // a link that hands it over can be made when the settings name an application to sign it as
      if (process.env[NETLIFY_SETTINGS.clientSecret]) expect(await host.handoverLink(madeFor)).toMatch(/^https:\/\/app\.netlify\.com\/claim\?utm_source=pod#/);
    } finally {
      await host.remove(live.siteId);
    }
    // taken down, and taking it down again is no failure
    await host.remove(live.siteId);
  }, 240_000);

  // a job's name is no secret, so anybody could take it first; "netlify" is a name that is certainly somebody's
  test("a name somebody else holds keeps nothing from going live: Netlify names the site itself", async () => {
    const host = netlifyFromTheEnvironment();
    if (!host) throw new Error("no Netlify token is set");
    const live = await host.publish({ name: "netlify", madeFor: `a-live-test:${Date.now().toString(36)}`, files: new Map([["/index.html", bytes("<!doctype html><h1>named by Netlify</h1>")]]) });
    try {
      console.log(`  live at ${live.url}`);
      expect(new URL(live.url).hostname).not.toBe("netlify.netlify.app");
      expect(await (await fetch(live.url)).text()).toContain("named by Netlify");
    } finally {
      await host.remove(live.siteId);
    }
  }, 240_000);
});
