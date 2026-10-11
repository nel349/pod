import { afterAll, describe, expect, test } from "bun:test";
import { brevo, brevoFromTheEnvironment, BREVO_SETTINGS, deliveredMail, isEmail, lastDayMail, LONGEST_EMAIL, whenInAMail } from "../mail/index.ts";
import { LAST_DAY_SECONDS, LONGEST_MAIL_WAIT_MS, MAIL_AGAIN_AFTER_MS, mailWait, whatToTell } from "../worker/Worker.ts";
import { brevoSaying } from "./support/brevo.ts";

const KEY = "xkeysib-a-key-for-tests";
const FROM = "pod@example.org";
const DELIVERY = {
  idea: "A page of Pokemon cards: each with its picture and details, and a way to mint one for a price in MON",
  checksPassed: true, answerBy: new Date("2026-10-14T06:03:04.000Z"), page: "https://pod.example/job/pokemon-cards",
};

describe("mail through Brevo", () => {
  const said = brevoSaying();
  afterAll(() => said.stop());
  const mailer = brevo({ key: KEY, from: FROM, endpoint: said.endpoint });

  test("one message is one request: to one address, from the confirmed sender, in plain text, with the account's key", async () => {
    await mailer.send({ to: "poster@example.com", subject: "A subject", text: "Two\nlines" });
    expect(said.sent).toEqual([{ key: KEY, from: { email: FROM, name: "POD" }, to: "poster@example.com", subject: "A subject", text: "Two\nlines" }]);
    expect(said.asked()).toBe(1);
  });

  test("a message Brevo will not take throws with Brevo's own reason, and never with the key or the address", async () => {
    said.refuse(400, "email is not valid in to");
    const refused = await mailer.send({ to: "nobody@example.com", subject: "s", text: "t" }).then(() => undefined, (error: Error) => error.message);
    said.recover();
    expect(refused).toBe("Brevo did not take the message (400): email is not valid in to");
    expect(refused).not.toContain(KEY);
    expect(refused).not.toContain("nobody@example.com");
  });

  test("the settings name Brevo or nothing does: a key and a sender go together, and the sender is an address", () => {
    expect(brevoFromTheEnvironment({})).toBeUndefined();
    expect(brevoFromTheEnvironment({ [BREVO_SETTINGS.key]: KEY, [BREVO_SETTINGS.from]: FROM })?.name).toBe("Brevo");
    expect(() => brevoFromTheEnvironment({ [BREVO_SETTINGS.key]: KEY })).toThrow(BREVO_SETTINGS.from);
    expect(() => brevoFromTheEnvironment({ [BREVO_SETTINGS.from]: FROM })).toThrow(BREVO_SETTINGS.key);
    expect(() => brevoFromTheEnvironment({ [BREVO_SETTINGS.key]: KEY, [BREVO_SETTINGS.from]: "not an address" })).toThrow("not an email address");
    // and nothing it refuses with repeats the key
    expect(() => brevoFromTheEnvironment({ [BREVO_SETTINGS.key]: KEY, [BREVO_SETTINGS.from]: "nope" })).not.toThrow(KEY);
  });
});

describe("what POD writes to a poster", () => {
  test("delivered: what the checks found, the one address to go to, until when in a time anybody can read, and what silence does", () => {
    const passed = deliveredMail(DELIVERY);
    expect(passed.subject).toStartWith("Your job is delivered: A page of Pokemon cards");
    expect(passed.subject.length).toBeLessThan(100);
    expect(passed.text).toContain(DELIVERY.idea);
    expect(passed.text).toContain("Its checks passed.");
    expect(passed.text).toContain(DELIVERY.page);
    expect(passed.text).toContain("You have until 14 Oct 2026, 06:03 UTC to answer. If you say nothing by then, the checks decide: the pod is paid.");

    const failed = deliveredMail({ ...DELIVERY, checksPassed: false });
    expect(failed.text).toContain("Its checks failed. You can still accept it.");
    expect(failed.text).toContain("the checks decide: your money comes back.");
    expect(failed.text).not.toContain("the pod is paid");
  });

  test("a day before their time runs out: that it still waits for them, until when, and where to answer", () => {
    const mail = lastDayMail(DELIVERY);
    expect(mail.subject).toStartWith("One day left to answer: ");
    expect(mail.text).toContain("you have not accepted or refused it yet");
    expect(mail.text).toContain(whenInAMail(DELIVERY.answerBy));
    expect(mail.text).toContain(DELIVERY.page);
  });

  test("both say why the reader got them, and neither carries a dash that reads as a machine's", () => {
    for (const mail of [deliveredMail(DELIVERY), lastDayMail(DELIVERY)]) {
      expect(mail.text).toContain("You get this because you left this address when you posted the job.");
      expect(mail.subject + mail.text).not.toMatch(/[–—]/);
    }
  });

  test("an address is worth sending to when it looks like one, and is no longer than mail carries", () => {
    for (const good of ["a@b.co", "norman.lopez+pod@example.com"]) expect(isEmail(good)).toBe(true);
    for (const bad of ["", "a", "a@b", "a b@c.de", "@b.co", `${"a".repeat(LONGEST_EMAIL)}@b.co`]) expect(isEmail(bad)).toBe(false);
  });
});

describe("which message a poster is owed", () => {
  const ANSWER_BY = 1_800_000_000n;
  const iso = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString();
  const THREE_DAYS = 3n * LAST_DAY_SECONDS;

  test("that it is delivered, as soon as it is, and only once", () => {
    expect(whatToTell(undefined, ANSWER_BY, ANSWER_BY - THREE_DAYS)).toBe("delivered");
    expect(whatToTell({}, ANSWER_BY, ANSWER_BY - THREE_DAYS)).toBe("delivered");
    expect(whatToTell({ delivered: iso(ANSWER_BY - THREE_DAYS) }, ANSWER_BY, ANSWER_BY - THREE_DAYS + 60n)).toBeUndefined();
  });

  test("that a day is left, when one is, and only once", () => {
    const told = { delivered: iso(ANSWER_BY - THREE_DAYS) };
    expect(whatToTell(told, ANSWER_BY, ANSWER_BY - LAST_DAY_SECONDS - 1n)).toBeUndefined();
    expect(whatToTell(told, ANSWER_BY, ANSWER_BY - LAST_DAY_SECONDS)).toBe("lastDay");
    expect(whatToTell({ ...told, lastDay: iso(ANSWER_BY - LAST_DAY_SECONDS) }, ANSWER_BY, ANSWER_BY - 60n)).toBeUndefined();
  });

  test("a poster given a day or less to answer gets the one message, not two in a row", () => {
    const told = { delivered: iso(ANSWER_BY - LAST_DAY_SECONDS + 5n) };
    expect(whatToTell(told, ANSWER_BY, ANSWER_BY - 60n)).toBeUndefined();
  });

  test("a message that failed waits longer before each new try, up to the longest wait, and is never given up", () => {
    expect(mailWait(1)).toBe(MAIL_AGAIN_AFTER_MS);
    expect(mailWait(2)).toBe(2 * MAIL_AGAIN_AFTER_MS);
    expect(mailWait(3)).toBe(4 * MAIL_AGAIN_AFTER_MS);
    expect(mailWait(40)).toBe(LONGEST_MAIL_WAIT_MS);
  });
});
