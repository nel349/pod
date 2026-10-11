/**
 * A stand-in for Brevo, for tests: a server on a real port that takes a message the way Brevo's own
 * door for sending one does, and keeps what it was sent. So everything between this project and the
 * wire is the code that runs in production. Brevo itself is asked only when its key is set, by
 * brevo-live.test.ts.
 */
import { BREVO_SEND_PATH } from "../../mail/index.ts";

export interface Sent {
  readonly key: string | null;
  readonly from: { readonly email: string; readonly name: string };
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface BrevoSaying {
  readonly endpoint: string;
  /** every message it took, in order */
  readonly sent: Sent[];
  /** how many times it was asked, the ones it refused included */
  asked(): number;
  /** from now on it refuses every message with this, in Brevo's own shape */
  refuse(status: number, message: string): void;
  /** a bad moment that has passed */
  recover(): void;
  stop(): void;
}

export function brevoSaying(): BrevoSaying {
  const sent: Sent[] = [];
  let asked = 0;
  let refusal: { readonly status: number; readonly message: string } | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method !== "POST" || pathname !== BREVO_SEND_PATH) return new Response("no such door", { status: 404 });
      asked += 1;
      if (refusal) return Response.json({ code: "invalid_parameter", message: refusal.message }, { status: refusal.status });
      const body = await request.json() as { sender: Sent["from"]; to: { email: string }[]; subject: string; textContent: string };
      for (const one of body.to) sent.push({ key: request.headers.get("api-key"), from: body.sender, to: one.email, subject: body.subject, text: body.textContent });
      return Response.json({ messageId: `<${sent.length}@stand-in>` }, { status: 201 });
    },
  });
  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    sent,
    asked: () => asked,
    refuse: (status, message) => { refusal = { status, message }; },
    recover: () => { refusal = undefined; },
    stop: () => { void server.stop(true); },
  };
}
