// The check writer, as a program.
//
// A poster says in plain words what would prove the work was done. This turns each sentence into a
// check that can decide it from outside, and — because a check nobody has tried is a guess — it also
// writes the two things the platform tries every check against before anything is sealed:
//
//   a working version   that does everything the poster asked, which every check has to pass
//   a near miss         one per sentence: the working version with that one thing wrong, which
//                       that sentence's check has to fail
//
// A near miss is asked for as the change that makes it, not as the whole program again: a program
// written out once for every sentence is most of what an answer costs, and all of it is the same
// program. A writer that cannot say it as a change may still hand the whole near miss over.
//
// It decides nothing. Whether a check passes or fails is found out afterwards, by running it, in a
// box this program never touches. The model is a socket, not a route: there is no network in here.
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
};

function prompt(job) {
  return [
    "You write acceptance checks for a small piece of software that somebody else will build.",
    "The person who wants it is not a programmer. They said what would prove it works, in plain words.",
    "",
    `What they want: ${job.idea}`,
    `What it is: ${WHAT_IT_IS[job.kind]}.`,
    `It is a Node program, server.js, standard library only, listening on port ${job.port}.`,
    "",
    "What would prove it works, numbered:",
    ...job.statements.map((statement, i) => `${i + 1}. ${statement.says}`),
    "",
    "Reply with one JSON object and nothing else, shaped like this:",
    "{",
    '  "working": "<the whole of a server.js that does everything asked, and every sentence holds>",',
    '  "howItIsAsked": null, or when the checks ask for something the sentences left open (see below):',
    '    { "plainly": "<one or two sentences for the person, with the values the checks use>",',
    '      "exactly": "<for the builder: what the work must accept, its name and form, and what it does without it>" },',
    '  "checks": [ one entry per numbered sentence, in order:',
    '    { "checkable": true,',
    '      "asks": "<what the check does to it, in everyday words, no code, no URLs>",',
    '      "expects": "<what a good answer looks like, in everyday words>",',
    '      "check": "<an ES module, see below>",',
    '      "nearMiss": "<one sentence: the plausible mistake the near miss makes>",',
    '      "nearMissChanges": [ { "replace": "<a piece of your working server.js, copied exactly>", "with": "<what that piece becomes>" } ] }',
    '    or, only when a program truly cannot decide the sentence from outside (taste, looks, anything needing the internet):',
    '    { "checkable": false, "why": "<one or two sentences the person can act on, see below>" }',
    "  ]",
    "}",
    "",
    "Each check:",
    "- is a complete ES module run with `node`, using only the standard library and the global fetch",
    "- reaches the work only through process.env.TARGET, which is its address, for example http://host:" + job.port,
    "- exits 0 when the sentence holds and 1 when it does not, printing one short line saying what it saw",
    "- tests the behaviour the sentence describes, not how it is built. Tolerate reasonable variation:",
    "  compare words case-insensitively, and do not require exact wording the person did not ask for",
    "- must pass against your working version and fail against that sentence's near miss",
    "- must fail against a server that has built nothing and answers every address with not found. So a check that",
    "  something is refused, or is not found, first shows that the thing itself works (for example it makes a short",
    "  code and follows it) and only then asks for what must be refused: otherwise an empty server would pass it",
    "",
    "Things that change on their own, such as the time of day, the date or chance, are not a reason to refuse.",
    "A check cannot wait for night or for a six, so it asks for one: choose the obvious way to ask, the same for every",
    "sentence that needs it (for example the work takes an hour in its address, as hour=22, and uses the real clock",
    "when none is given), build the working version that way, write every check that way, and say it in howItIsAsked.",
    "Where the sentences leave a line to draw, such as when day begins, choose the ordinary one and say it. Say the",
    "plain version so a person who has never programmed understands it, with the values the checks use (10 in the",
    "morning, 10 at night), and no code, addresses or parameter names. Say the exact version so a builder can build it.",
    "",
    "Refuse a sentence only when no program could decide it. Say why in words for a person who has never programmed:",
    "no code, no addresses, no parameter names. When a sentence only repeats another, say which one, and suggest a",
    "different situation to check instead, for example midnight rather than night again.",
    "",
    "Each near miss changes the working version so that one sentence no longer holds while everything else",
    "still works. Make it the mistake a hurried builder would really make, not a crash.",
    "Give a near miss as its changes, not as the program again: each change names a piece of your working server.js",
    "to replace and what it becomes. Copy the piece exactly, spaces and line breaks included, and make it long enough",
    "that it appears in the working version only once. One change is usually all a near miss needs.",
    "",
    "Write asks, expects, nearMiss, why and howItIsAsked in plain sentences, with commas and full stops. Do not use em dashes.",
  ].join("\n");
}

/** The first JSON object in an answer, whether or not it came fenced. */
function parse(answer) {
  const fenced = answer.match(/```(?:json)?\n([\s\S]*?)```/);
  const text = fenced ? fenced[1] : answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1);
  const parsed = JSON.parse(text);
  if (typeof parsed.working !== "string") throw new Error("there was no working version");
  if (!Array.isArray(parsed.checks)) throw new Error("there were no checks");
  const asked = parsed.howItIsAsked;
  if (asked !== undefined && asked !== null && (typeof asked.plainly !== "string" || typeof asked.exactly !== "string" || !asked.plainly || !asked.exactly)) {
    throw new Error("howItIsAsked was given without both a plain and an exact version");
  }
  return parsed;
}

const isAChange = (change) => change && typeof change.replace === "string" && change.replace !== "" && typeof change.with === "string";

function wellFormed(entry) {
  if (entry && entry.checkable === false) return typeof entry.why === "string";
  if (!entry || !["asks", "expects", "check", "nearMiss"].every((key) => typeof entry[key] === "string")) return false;
  // the near miss, as its changes or, from a writer that could not say it that way, whole
  return typeof entry.nearMissServer === "string"
    || (Array.isArray(entry.nearMissChanges) && entry.nearMissChanges.length > 0 && entry.nearMissChanges.every(isAChange));
}

/**
 * The near miss a check is tried against: the working version with its changes made. A change has to
 * name a piece that is in the program exactly once, or nobody could say which piece it meant, and a
 * change that is not there at all would leave a near miss that is not one.
 */
function nearMissOf(working, entry, number) {
  if (typeof entry.nearMissServer === "string") return entry.nearMissServer;
  return entry.nearMissChanges.reduce((server, change) => {
    const times = server.split(change.replace).length - 1;
    if (times !== 1) {
      throw new Error(`the near miss for check ${number} replaces a piece that is in the working version ${times} times, and it has to be there exactly once: ${JSON.stringify(change.replace.slice(0, 80))}`);
    }
    // a function, so nothing in what it becomes is read as a pattern
    return server.replace(change.replace, () => change.with);
  }, working);
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
        // made now, so a change that cannot be made is something the writer is told and may put right
        const nearMisses = parsed.checks.map((entry, i) => (entry.checkable === false ? undefined : nearMissOf(parsed.working, entry, i + 1)));
        written = { ...parsed, nearMisses };
      } catch (error) {
        problem = error.message;
      }
    }
    if (!written) { say("refuse", `could not write the checks: ${problem}`); return; }

    write("/work/working/server.js", written.working);
    const checks = written.checks.map((entry, i) => {
      if (entry.checkable === false) return { checkable: false, why: entry.why };
      write(`/work/checks/check-${i + 1}.mjs`, entry.check);
      write(`/work/near-miss/${i + 1}/server.js`, written.nearMisses[i]);
      return { checkable: true, asks: entry.asks, expects: entry.expects, nearMiss: entry.nearMiss };
    });
    const asked = written.howItIsAsked;
    const howItIsAsked = asked ? { plainly: asked.plainly, exactly: asked.exactly } : null;
    write("/work/.pod/readback.json", JSON.stringify({ checks, howItIsAsked }, null, 2));
    say("shipped", `wrote ${checks.filter((entry) => entry.checkable).length} of ${checks.length} checks`);
  } catch (error) {
    say("refuse", `could not write the checks: ${error.message}`);
  }
})();
