/** One message to one person: in plain text, and laid out as a page for a reader whose mail shows one. */
export interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** the same message as a page; a reader that shows none falls back to the text */
  readonly html?: string;
}

/** Something that sends mail. POD tells a poster their job was delivered through one, and nothing else. */
export interface Mailer {
  /** the service it sends through, for a line in the log */
  readonly name: string;
  /** Send it, or throw with why the service would not take it. */
  send(mail: Mail): Promise<void>;
}

/** What an address has to look like to be worth handing to a mail service, which has the last word on it. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The longest address the mail standards carry. */
export const LONGEST_EMAIL = 254;

export const isEmail = (text: string): boolean => text.length <= LONGEST_EMAIL && EMAIL.test(text);
