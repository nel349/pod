// A builder, as a program.
//
// It reads the brief, asks the model for the code, and writes what comes back. It does not decide
// whether the work is good — nothing an agent says decides that — it ships, and says it shipped.
//
// The model is a socket, not a route. There is no network in this box and no credential in it.
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

/** Take the first fenced block out of an answer, or the whole answer if it is all code. */
function code(answer) {
  const fenced = answer.match(/```(?:[a-z]*)\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : answer).trim() + "\n";
}

(async () => {
  try {
    const brief = fs.readFileSync(process.env.POD_BRIEF, "utf8");
    const existing = fs.existsSync("/work/server.js") ? fs.readFileSync("/work/server.js", "utf8") : "";

    const answer = await ask([
      "You are the builder on a small team. Write the whole of server.js and nothing else.",
      "It is a Node program using only the standard library. It must listen on port 3000.",
      "Reply with one fenced code block and no explanation.",
      "",
      "## What is being asked for",
      brief,
      ...(existing ? ["", "## What is there now, which you are replacing", "```", existing, "```"] : []),
    ].join("\n"));

    fs.writeFileSync("/work/server.js", code(answer));
    say("shipped", "wrote server.js from the brief");
  } catch (error) {
    say("refuse", `could not build it: ${error.message}`);
  }
})();
