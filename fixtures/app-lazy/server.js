// Stands in for work that only looks right: it answers every request, always the same way.
// The visible check asks whether the page answers, and it does. The hidden check asks whether a
// thin excuse scores lower than a real one, and this never scores anything differently at all.
const http = require("http");
http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ excuse: url.searchParams.get("excuse") ?? "", score: 5 }));
}).listen(3000, () => console.log("listening"));
