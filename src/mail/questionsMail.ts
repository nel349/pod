// What POD writes to a poster when the pod building their week's job asks them something: each
// question, what its seat will assume if nobody answers, until when, and the one address to answer at.
import { escaped, FACE, inASubject, LOOK, SHOUT, whenInAMail, WHY_YOU_GET_THIS } from "./deliveryMail.ts";
import type { Mail } from "./Mailer.ts";

/** A pod's questions, as much of them as a message says. */
export interface QuestionsToTell {
  readonly idea: string;
  /** the job's page, in full, where the poster answers */
  readonly page: string;
  readonly questions: readonly {
    readonly asks: string;
    readonly assumes: string;
    readonly answerBy: Date;
  }[];
}

const HOW_TO_ANSWER = "Answer on the job's page, with the wallet that paid for it. Signing your answer costs nothing and moves no money.";
const IF_YOU_DO_NOT = "You do not have to answer. A question nobody answers in time is settled by what the pod said it would assume, and the pod builds on.";

/** The message that a pod asked its poster something: sent once for each batch of questions. */
export function questionsMail(told: QuestionsToTell): Omit<Mail, "to"> {
  const many = told.questions.length;
  const shout = many === 1 ? "Your pod has a question" : `Your pod has ${many} questions`;
  const paragraph = (line: string, weight = 400): string => `<p style="margin:0 0 10px;font:${weight} 16px/1.5 ${FACE};color:${LOOK.ink}">${escaped(line)}</p>`;
  return {
    subject: `${shout}: ${inASubject(told.idea)}`,
    text: [
      many === 1 ? "The pod building your job on POD asked you a question before it builds." : `The pod building your job on POD asked you ${many} questions before it builds.`,
      told.idea,
      ...told.questions.map((one) => [
        `Your pod asks: ${one.asks}`,
        `If nobody answers by ${whenInAMail(one.answerBy)}, it will assume: ${one.assumes}`,
      ].join("\n")),
      `${HOW_TO_ANSWER}\n${told.page}`,
      IF_YOU_DO_NOT,
      WHY_YOU_GET_THIS,
    ].join("\n\n"),
    html: `<!doctype html><html lang="en"><body style="margin:0;padding:0;background:${LOOK.ink}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${LOOK.ink}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="background:${LOOK.yellow};padding:26px 28px 22px">
<p style="margin:0 0 10px;font:700 13px/1.2 ${FACE};letter-spacing:1px;color:${LOOK.ink}">POD · PROOF OF DEVELOPMENT</p>
<p style="margin:0;font:900 34px/1 ${SHOUT};text-transform:uppercase;color:${LOOK.ink}">${escaped(shout)}</p>
</td></tr>
<tr><td style="background:${LOOK.paper};padding:26px 28px 8px">
<p style="margin:0 0 18px;font:700 20px/1.3 ${FACE};color:${LOOK.ink}">${escaped(told.idea)}</p>
${told.questions.map((one) => `<div style="margin:0 0 18px;padding:0 0 0 14px;border-left:4px solid ${LOOK.pink}">
<p style="margin:0 0 4px;font:700 12px/1.2 ${FACE};letter-spacing:1px;text-transform:uppercase;color:${LOOK.grey}">Your pod asks</p>
${paragraph(one.asks, 700)}
${paragraph(`If nobody answers by ${whenInAMail(one.answerBy)}, it will assume: ${one.assumes}`)}
</div>`).join("\n")}
${paragraph(HOW_TO_ANSWER)}
<p style="margin:8px 0 22px"><a href="${escaped(told.page)}" style="display:inline-block;padding:14px 22px 12px;background:${LOOK.ink};color:${LOOK.yellow};font:900 20px/1 ${SHOUT};text-transform:uppercase;text-decoration:none;border-right:5px solid ${LOOK.pink};border-bottom:5px solid ${LOOK.pink}">Open it and answer</a></p>
${paragraph(IF_YOU_DO_NOT)}
</td></tr>
<tr><td style="background:${LOOK.paper};padding:0 28px 24px;border-top:2px solid ${LOOK.ink}">
<p style="margin:14px 0 0;font:400 13px/1.45 ${FACE};color:${LOOK.grey}">${escaped(WHY_YOU_GET_THIS)}</p>
</td></tr></table></td></tr></table></body></html>`,
  };
}
