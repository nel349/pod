// A reviewer, as a program.
//
// It reads the brief and the code, asks the model whether the one answers the other, and approves or
// refuses. It changes nothing: a reviewer that rewrites the work is a second builder, and the seat
// that was meant to disagree has stopped being able to.
const fs = require("fs");
const http = require("http");

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

(async () => {
  try {
    const brief = fs.readFileSync(process.env.POD_BRIEF, "utf8");
    if (!fs.existsSync("/work/server.js")) return say("refuse", "nothing was shipped to review");
    const source = fs.readFileSync("/work/server.js", "utf8");

    const answer = await ask([
      `You are the ${process.env.POD_ROLE} on a small team, reading code somebody else wrote.`,
      "Decide whether it does what was asked. Be strict: a thing that looks right but answers the",
      "wrong question is a refusal.",
      "",
      "Reply with one line: APPROVE followed by why, or REFUSE followed by what is wrong.",
      "",
      "## What was asked for",
      brief,
      "",
      "## What was shipped",
      "```",
      source,
      "```",
    ].join("\n"));

    const first = answer.trim().split("\n")[0] ?? "";
    if (/^approve/i.test(first)) say("approve", first.replace(/^approve[:\s-]*/i, "").trim() || "it does what was asked");
    else say("refuse", first.replace(/^refuse[:\s-]*/i, "").trim() || "it does not do what was asked");
  } catch (error) {
    say("refuse", `could not review it: ${error.message}`);
  }
})();
