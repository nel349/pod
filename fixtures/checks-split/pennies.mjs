// The hidden one: the shares have to add up to the bill, including when the pennies do not divide.
const target = process.env.TARGET;
for (const [total, people] of [[30, 3], [10, 3], [0.03, 2], [100.01, 7]]) {
  const answer = await (await fetch(`${target}/?total=${total}&people=${people}`)).json();
  const sum = answer.shares.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - total) > 0.0001) {
    console.log(`${people} people splitting ${total} were charged ${sum}`);
    process.exit(1);
  }
}
console.log("every split adds back up to the bill");
