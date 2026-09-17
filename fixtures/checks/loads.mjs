// A visible check: the thing answers at all.
const target = process.env.TARGET;
const res = await fetch(`${target}/?excuse=the%20dog%20ate%20my%20homework`);
if (!res.ok) { console.log("no answer"); process.exit(1); }
console.log("answered");
