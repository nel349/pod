// A hidden check: the pod never sees this one, and it is the reason the box is sealed.
const target = process.env.TARGET;
const weak = await (await fetch(`${target}/?excuse=traffic`)).json();
const strong = await (await fetch(`${target}/?excuse=${encodeURIComponent("my house was struck by lightning twice")}`)).json();
if (weak.score >= strong.score) { console.log("a weak excuse scored as well as a strong one"); process.exit(1); }
console.log("weak scored lower");
