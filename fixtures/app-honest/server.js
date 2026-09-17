// Stands in for what a pod ships: something you can drive from outside.
const http = require("http");
http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const excuse = url.searchParams.get("excuse") ?? "";
  // a weak excuse is a short one
  const score = Math.max(1, Math.min(10, Math.ceil(excuse.trim().length / 8)));
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ excuse, score }));
}).listen(3000, () => console.log("listening"));
