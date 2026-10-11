import { describe, expect, test } from "bun:test";
import { BREVO_SETTINGS, brevoFromTheEnvironment, deliveredMail, isEmail } from "../mail/index.ts";

/**
 * One message sent through Brevo itself, once, when somebody asks for it: the message a poster gets
 * when their job is delivered, to an address the person running this names.
 *
 * It sends real mail from a real account, so it runs only when a person sets the key and the sender
 * and names who to send to in POD_BREVO_LIVE_TO, and never on CI. Everything short of Brevo saying
 * yes is in mail.test.ts, which runs everywhere against a stand-in that takes a message as Brevo does.
 */

const TO = "POD_BREVO_LIVE_TO";
const to = process.env[TO]?.trim();
const asked = to !== undefined && process.env[BREVO_SETTINGS.key] !== undefined && process.env.CI !== "true";
if (!asked) console.log(`  (mail through Brevo itself runs only when ${BREVO_SETTINGS.key}, ${BREVO_SETTINGS.from} and ${TO} are set, off CI)`);

describe.skipIf(!asked)("mail, through Brevo itself", () => {
  test("Brevo takes the message a poster gets at delivery; whether it arrives is for the person at that address to see", async () => {
    const mailer = brevoFromTheEnvironment();
    if (!mailer || !to) throw new Error("no Brevo key is set, or nobody to send to");
    expect(isEmail(to), `${TO} is an email address`).toBe(true);
    await mailer.send({
      to,
      ...deliveredMail({
        idea: `A message sent by POD's own test at ${new Date().toISOString()}`, checksPassed: true,
        answerBy: new Date(Date.now() + 3 * 24 * 3600 * 1000), page: "https://vps-39a35c60.vps.ovh.us/",
      }),
    });
  }, 60_000);
});
