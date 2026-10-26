// The check writer, as a program.
//
// A poster says in plain words what would prove the work was done. This turns each sentence into a
// check that can decide it from outside, says in everyday words what each check does, and says what
// a sentence asks for that no check here can decide.
//
// It builds nothing. The work is the pod's to build, and what a check is worth is found out when it
// is run against that work. The one thing tried beforehand is that no check passes when nothing has
// been built, which is run afterwards in a box this program never touches.
//
// It decides nothing. The model is a socket, not a route: there is no network in here.
const fs = require("fs");
const http = require("http");
const path = require("path");

const ask = (prompt) => new Promise((resolve, reject) => {
  const request = http.request(
    { socketPath: process.env.POD_MODEL, path: "/", method: "POST" },
    (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (response.statusCode !== 200) reject(new Error(parsed.error ?? body));
          else resolve(parsed.text);
        } catch (error) { reject(error); }
      });
    },
  );
  request.on("error", reject);
  request.end(prompt);
});

const say = (decision, why) =>
  fs.writeFileSync(process.env.POD_SAY, JSON.stringify({ decision, why }));

const write = (file, contents) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents.endsWith("\n") ? contents : contents + "\n");
};

const WHAT_IT_IS = {
  page: "a web page a person opens in a browser. Checks look at the HTML it serves: what a person would see",
  service: "a service other programs call over HTTP. Checks look at the data it answers with",
  site: "a website: files a person opens in a browser. Checks ask for its pages and files and look at what is in them",
};

/** How the work will be made, which decides what a check can ask of it. */
const HOW_IT_IS_MADE = {
  page: (port) => `It will be a Node program, server.js, standard library only, listening on port ${port}.`,
  service: (port) => `It will be a Node program, server.js, standard library only, listening on port ${port}.`,
  site: (port) => [
    `It will be a folder of files named site, with index.html as its front page, served as they are on port ${port}:`,
    "site/cards/mewtwo.html answers at /cards/mewtwo.html and at /cards/mewtwo, and an address with no file answers not found.",
    "No program of the builders runs on the server: nothing is stored there, and a request that is not for a file is",
    "not answered. What a page does when it is clicked happens in the visitor's browser, in the page's own script,",
    "which a check does not run: a check reads the files, the page's script among them, as text.",
  ].join("\n"),
};

function prompt(job) {
  return [
    "You write acceptance checks for a piece of software that somebody else will build.",
    "The person who wants it is not a programmer. They said what would prove it works, in plain words.",
    "You do not build it, and nobody has built it yet. Your checks are run later, against what the builders make.",
    "",
    `What they want: ${job.idea}`,
    `What it is: ${WHAT_IT_IS[job.kind]}.`,
    HOW_IT_IS_MADE[job.kind](job.port),
    "",
    "What would prove it works, numbered. The builders are shown some of these and not others:",
    ...job.statements.map((statement, i) => `${i + 1}. ${statement.says} ${statement.secret ? "[kept from the builders]" : "[the builders see this]"}`),
    "",
    "Reply with one JSON object and nothing else, shaped like this:",
    "{",
    '  "howItIsAsked": null, or when the checks rely on anything the sentences do not say (see below):',
    '    { "plainly": "<one or two sentences for the person, with the values the checks use>",',
    '      "exactly": "<for the builder: every address, name and form of answer the checks rely on>" },',
    '  "notAskedFor": null, or "<one or two plain sentences, see below>",',
    '  "checks": [ one entry per numbered sentence, in order:',
    '    { "checkable": true,',
    '      "asks": "<what the check does to it, in everyday words, no code, no URLs>",',
    '      "expects": "<what a good answer looks like, in everyday words>",',
    '      "leavesOut": null, or "<one sentence: what the sentence asks for that this check does not decide>",',
    '      "check": "<an ES module, see below>" }',
    '    or, only when a program cannot decide any part of the sentence from outside (taste, looks, anything needing the internet):',
    '    { "checkable": false, "why": "<one or two sentences the person can act on, see below>" }',
    '    or, only for a sentence kept from the builders that asks for something they are never told (see below):',
    '    { "checkable": false, "untold": true, "why": "<what in it the builders are never told, and what to do instead>" }',
    "  ]",
    "}",
    "",
    "A sentence kept from the builders is there to catch work built only to pass the checks its builders could read.",
    "So it may only test what the builders are told: what the person wants, the sentences the builders see, and what you",
    "say in howItIsAsked. It tests one of those in a situation the builders were not shown: another card, another",
    "city, an empty answer, the same thing asked twice. It must not ask for anything new. If honest builders, reading",
    "only what they are shown, would have no reason to build what a kept sentence asks for, that sentence is untold:",
    "a different rule, a limit, a number, a page, a date or a behaviour that nothing they see mentions. Do not write",
    "a check for an untold sentence. Answer it with untold true, and in why say plainly what the builders are never",
    "told and that the person can either move the sentence to the ones the builders see, or change it to test",
    "something they already ask for in a different situation. Judge this fairly: a kept sentence that follows",
    "plainly from what the builders see is not untold only because it names a case they were not given.",
    "",
    "Each check:",
    "- is a complete ES module run with `node`, using only the standard library and the global fetch",
    "- reaches the work only through process.env.TARGET, which is its address, for example http://host:" + job.port + ".",
    "  It runs with no internet: asking any other host fails. A picture, font or library a page takes from another",
    "  host is checked by the page naming where it comes from, never by fetching it",
    "- exits 0 when the sentence holds and 1 when it does not. It prints what it did as it goes: the address it",
    "  asked and what it sent, the answer it got back cut to about ten lines, and last of all one short line",
    "  saying what it saw. Whoever posted the job reads that print on the job's page: where the work is a service",
    "  with no page to open, it is the only thing that shows them what they are paying for, so make it readable",
    "- tests the behaviour the sentence describes, not how it is built. Tolerate reasonable variation:",
    "  compare words case-insensitively, and do not require exact wording the person did not ask for",
    "- looks for the thing itself, where it belongs, and not for a word that could be anywhere on the page: a page",
    "  that only mentions an image, a price or a button somewhere has not shown it",
    "- must fail against a server that has built nothing and answers every address with not found. So a check that",
    "  something is refused, or is not found, first shows that the thing itself works (for example it makes a short",
    "  code and follows it) and only then asks for what must be refused: otherwise an empty server would pass it",
    "",
    "The builders see the sentences, and never your checks for the ones the person keeps secret. So every check keeps to",
    "one way of reaching the work, and everything a check relies on that the sentences do not say (which address shows",
    "what, what a request is called and carries, the form an answer takes) is said in howItIsAsked. Say the exact",
    "version so a builder can build to it and pass. Say the plain version so a person who has never programmed",
    "understands it, with the values the checks use, and no code, addresses or parameter names.",
    "",
    "Builders build what the sentences say and nothing more. Read what the person wants, and ask yourself what they",
    "plainly seem to expect that no sentence asks for: a real wallet being connected, a real payment or transaction on",
    "a blockchain, signing in, things being saved between visits, data taken from a real service, working on a phone.",
    "When there is something like that, say it in notAskedFor, to the person, in one or two plain sentences: what no",
    "sentence asks for, and that the builders may leave it out or fake it unless a sentence says so. For example:",
    "Nothing here asks for a real wallet or a real payment, so the builders may make a button that only looks like",
    "minting. Only raise what the person's own words name or cannot do without: wanting to mint for a price names a",
    "real payment, a cafe's menu does not name ordering online. Never suggest a feature they did not mention. Leave",
    "notAskedFor null when the sentences cover what the person wants. Do not use it for taste or polish.",
    "",
    "Things that change on their own, such as the time of day, the date or chance, are not a reason to refuse.",
    "A check cannot wait for night or for a six, so it asks for one: choose the obvious way to ask, the same for every",
    "sentence that needs it (for example the work takes an hour in its address, as hour=22, and uses the real clock",
    "when none is given), write every check that way, and say it in howItIsAsked (10 in the morning, 10 at night).",
    "Where the sentences leave a line to draw, such as when day begins, choose the ordinary one and say it.",
    "",
    "A check reaches the work the way a program does, not the way a person does. It cannot click, see how a page looks,",
    "use a wallet, or pay or mint on a blockchain. When a sentence asks for some of that, check the part a program can",
    "decide (clicking a card becomes asking for that card's page) and say in leavesOut, in one plain sentence, what is",
    "left out. Leave leavesOut null when the check decides the whole sentence.",
    "",
    "Refuse a sentence only when no program could decide any of it. Say why in words for a person who has never",
    "programmed: no code, no addresses, no parameter names. When a sentence only repeats another, say which one, and",
    "suggest a different situation to check instead, for example midnight rather than night again.",
    "",
    "Write asks, expects, leavesOut, why and howItIsAsked in plain sentences, with commas and full stops. Do not use em dashes.",
    "asks, expects, leavesOut, why and the plain half of howItIsAsked are read by somebody who has never programmed. Say what a",
    "person would see or do: the card's page shows a picture of the Pokemon, there is a button to mint it. Never use a",
    "programmer's word there: no status or number codes, and none of HTML, tag, element, attribute, markup, script, source,",
    "endpoint, request, response, fetch, parse, render, web3, API, JSON or URL. Keep each to one or two short sentences.",
  ].join("\n");
}

/** The first JSON object in an answer, whether or not it came fenced. */
function parse(answer) {
  const fenced = answer.match(/```(?:json)?\n([\s\S]*?)```/);
  const text = fenced ? fenced[1] : answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1);
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.checks)) throw new Error("there were no checks");
  const asked = parsed.howItIsAsked;
  if (asked !== undefined && asked !== null && (typeof asked.plainly !== "string" || typeof asked.exactly !== "string" || !asked.plainly || !asked.exactly)) {
    throw new Error("howItIsAsked was given without both a plain and an exact version");
  }
  if (parsed.notAskedFor !== undefined && parsed.notAskedFor !== null && typeof parsed.notAskedFor !== "string") {
    throw new Error("notAskedFor was neither null nor a sentence");
  }
  return parsed;
}

function wellFormed(entry) {
  if (entry && entry.checkable === false) return typeof entry.why === "string" && (entry.untold === undefined || typeof entry.untold === "boolean");
  if (!entry || !["asks", "expects", "check"].every((key) => typeof entry[key] === "string")) return false;
  return entry.leavesOut === undefined || entry.leavesOut === null || typeof entry.leavesOut === "string";
}

(async () => {
  try {
    const job = JSON.parse(fs.readFileSync("/work/.pod/ask.json", "utf8"));
    let written;
    let problem = "";
    // one more chance, told what was wrong with the first. A writer that cannot manage it twice is stuck
    for (let attempt = 1; attempt <= 2 && !written; attempt++) {
      const answer = await ask(problem
        ? `${prompt(job)}\n\nYour last reply could not be used: ${problem}. Reply with the JSON object only.`
        : prompt(job));
      try {
        const parsed = parse(answer);
        if (parsed.checks.length !== job.statements.length) {
          throw new Error(`there were ${job.statements.length} sentences and ${parsed.checks.length} checks`);
        }
        const broken = parsed.checks.findIndex((entry) => !wellFormed(entry));
        if (broken !== -1) throw new Error(`check ${broken + 1} was missing a part`);
        written = parsed;
      } catch (error) {
        problem = error.message;
      }
    }
    if (!written) { say("refuse", `could not write the checks: ${problem}`); return; }

    const checks = written.checks.map((entry, i) => {
      if (entry.checkable === false) return { checkable: false, why: entry.why, ...(entry.untold === true ? { untold: true } : {}) };
      write(`/work/checks/check-${i + 1}.mjs`, entry.check);
      return { checkable: true, asks: entry.asks, expects: entry.expects, leavesOut: entry.leavesOut || null };
    });
    const asked = written.howItIsAsked;
    const howItIsAsked = asked ? { plainly: asked.plainly, exactly: asked.exactly } : null;
    const notAskedFor = typeof written.notAskedFor === "string" && written.notAskedFor.trim() ? written.notAskedFor.trim() : null;
    write("/work/.pod/readback.json", JSON.stringify({ checks, howItIsAsked, notAskedFor }, null, 2));
    say("shipped", `wrote ${checks.filter((entry) => entry.checkable).length} of ${checks.length} checks`);
  } catch (error) {
    say("refuse", `could not write the checks: ${error.message}`);
  }
})();
