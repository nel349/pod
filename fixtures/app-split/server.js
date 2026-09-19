// What a pod shipped for the bill-splitting job: it reads a total and a party, and divides the bill
// so the pennies land somewhere rather than disappearing.
const http = require("http");
http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const total = Math.round(Number(url.searchParams.get("total") ?? "0") * 100);
  const people = Math.max(1, Number(url.searchParams.get("people") ?? "1"));

  const each = Math.floor(total / people);
  const left = total - each * people;
  // the first few pay one penny more, so the shares add back up to the bill
  const shares = Array.from({ length: people }, (_, i) => (each + (i < left ? 1 : 0)) / 100);

  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ total: total / 100, people, shares }));
}).listen(3000, () => console.log("listening"));
