// A visible check: it answers, and it answers with a share each.
const target = process.env.TARGET;
const answer = await (await fetch(`${target}/?total=30&people=3`)).json();
if (!Array.isArray(answer.shares) || answer.shares.length !== 3) {
  console.log("no shares came back"); process.exit(1);
}
console.log("answered with three shares");
